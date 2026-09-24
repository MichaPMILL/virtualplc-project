<?php

declare(strict_types=1);

namespace VirtualPLC\Runtime;

use VirtualPLC\Modbus\ModbusTcpServer;
use VirtualPLC\Modbus\RegisterMap;
use VirtualPLC\Scl\Ast\Program;
use VirtualPLC\Scl\Interpreter;
use VirtualPLC\Scl\Parser;
use VirtualPLC\Scl\SclException;
use VirtualPLC\Scl\SemanticError;
use VirtualPLC\Support\Config;
use VirtualPLC\Support\Files;
use VirtualPLC\Support\Logger;

/**
 * The soft-PLC runtime: loads the deployed program, runs it cyclically and
 * keeps the outside world (I/O modules, HMIs, web IDE) in sync.
 *
 * States: IDLE (no program), RUN, FAULT (error, automatic restart), STOPPED.
 *
 * The FC is executed as a cyclic task (like OB1): when it returns, the next
 * scan starts after VPLC_CYCLE_MS. Programs may instead loop forever and call
 * WAIT(ms); every WAIT marks the end of a scan.
 *
 * End of scan = flush outputs -> apply operator commands -> publish status ->
 * check for a new program -> sleep while serving Modbus requests.
 */
final class Runtime
{
    public const STATE_IDLE = 'IDLE';
    public const STATE_RUN = 'RUN';
    public const STATE_FAULT = 'FAULT';
    public const STATE_STOPPED = 'STOPPED';

    /** Functions provided by the runtime (in addition to the interpreter's standard ones). */
    public const FUNCTIONS = ['CONNECT', 'DISCONNECT_ALL', 'DEVICE_OK', 'WAIT', 'LOG'];

    private const STATUS_INTERVAL = 0.2;
    private const RELOAD_CHECK_INTERVAL = 0.5;

    private string $state = self::STATE_IDLE;
    private bool $stopRequested = false;
    private ?ModbusTcpServer $server = null;
    private ?Interpreter $interpreter = null;
    private ?DeviceManager $devices = null;
    private readonly CommandQueue $commands;
    private readonly Logger $plcLog;

    private ?string $programHash = null;
    private ?float $programLoadedAt = null;
    /** @var array{message: string, line: int|null, at: float}|null */
    private ?array $lastError = null;

    private int $scanCount = 0;
    private float $scanStartedAt = 0.0;
    private float $lastScanMs = 0.0;
    private float $maxScanMs = 0.0;
    private float $lastStatusAt = 0.0;
    private float $lastReloadCheck = 0.0;
    private readonly float $startedAt;

    public function __construct(
        private readonly Config $config,
        private readonly Logger $logger,
    ) {
        $this->commands = new CommandQueue($config->commandFile());
        $this->plcLog = $logger->withChannel('program');
        $this->startedAt = microtime(true);
    }

    public function requestStop(): void
    {
        $this->stopRequested = true;
    }

    /** Main loop. Returns the process exit code. */
    public function run(): int
    {
        $this->installSignalHandlers();
        $this->ensureDataDir();

        if ($this->config->modbusEnabled) {
            $this->server = new ModbusTcpServer(
                $this->config->modbusBind,
                $this->config->modbusPort,
                $this->logger->withChannel('modbus'),
            );
        }

        $this->logger->info('Runtime started', [
            'pid' => getmypid(),
            'program' => $this->config->programFile(),
            'cycle_ms' => $this->config->cycleMs,
        ]);

        while (!$this->stopRequested) {
            $program = $this->loadProgram();
            if ($program === null) {
                $this->idle(fn (): bool => $this->programChanged());
                continue;
            }
            $this->execute($program);
        }

        $this->state = self::STATE_STOPPED;
        $this->writeStatus(true);
        $this->server?->close();
        $this->logger->info('Runtime stopped');

        return 0;
    }

    // ------------------------------------------------------------------
    // Program lifecycle
    // ------------------------------------------------------------------

    private function loadProgram(): ?Program
    {
        $file = $this->config->programFile();
        clearstatcache(true, $file);
        $source = is_file($file) ? @file_get_contents($file) : false;
        $this->programHash = $source === false ? null : hash('sha256', $source);

        if ($source === false || trim($source) === '') {
            if ($this->state !== self::STATE_IDLE) {
                $this->logger->info('No program deployed, waiting', ['file' => $file]);
            }
            $this->state = self::STATE_IDLE;
            $this->lastError = null;

            return null;
        }

        try {
            $program = Parser::parseSource($source);
            $this->logger->info('Program loaded', ['hash' => substr($this->programHash, 0, 12)]);

            return $program;
        } catch (SclException $e) {
            $this->fault($e);

            return null;
        }
    }

    private function execute(Program $program): void
    {
        $this->devices = new DeviceManager($this->logger->withChannel('io'), $this->config->ioTimeoutMs / 1000);
        $this->interpreter = $this->createInterpreter($this->devices);

        try {
            $this->interpreter->load($program);
            $this->server?->setRegisterMap(RegisterMap::fromDeclarations($this->interpreter->declarations()));
            $this->server?->setTagStore($this->interpreter);

            $this->state = self::STATE_RUN;
            $this->lastError = null;
            $this->programLoadedAt = microtime(true);
            $this->scanCount = 0;
            $this->maxScanMs = 0.0;
            $this->logger->info('Program running');

            $this->scanStartedAt = microtime(true);
            $this->devices->beginScan();
            $this->interpreter->start();

            while (true) {
                $this->interpreter->scan();
                $elapsedMs = (microtime(true) - $this->scanStartedAt) * 1000;
                $this->endOfScan(max(0.0, $this->config->cycleMs - $elapsedMs));
            }
        } catch (ReloadSignal) {
            $this->logger->info('Program changed on disk, reloading');
        } catch (StopSignal) {
            $this->logger->info('Shutdown requested');
            $this->safeStop();
        } catch (\Throwable $e) {
            $this->fault($e);
            $this->safeStop();
            $deterministic = $e instanceof SemanticError;
        } finally {
            $this->server?->setTagStore(null);
            // Outputs were flushed at the last scan boundary; never flush a half-executed scan.
            $this->devices?->disconnectAll(false);
            $this->devices = null;
            $this->interpreter = null;
        }

        if ($this->state === self::STATE_FAULT && !$this->stopRequested) {
            if ($deterministic ?? false) {
                // Retrying the same program is pointless: wait for a new deployment.
                $this->idle(fn (): bool => $this->programChanged());
            } else {
                // Restart after a delay, or immediately if a new program is deployed.
                $deadline = microtime(true) + $this->config->restartDelayMs / 1000;
                $this->idle(fn (): bool => microtime(true) >= $deadline || $this->programChanged());
            }
        }
    }

    private function createInterpreter(DeviceManager $devices): Interpreter
    {
        $interpreter = new Interpreter($devices);
        $interpreter->setWatchdog($this->config->watchdogMs / 1000);

        $interpreter->registerFunction('CONNECT', $devices->connect(...));
        $interpreter->registerFunction('DISCONNECT_ALL', static fn () => $devices->disconnectAll());
        $interpreter->registerFunction('DEVICE_OK', $devices->isOnline(...));
        $interpreter->registerFunction('LOG', function (mixed ...$parts): void {
            $this->plcLog->info(implode(' ', array_map(
                static fn (mixed $p): string => is_bool($p) ? ($p ? 'TRUE' : 'FALSE') : (string) $p,
                $parts,
            )));
        });
        $interpreter->registerFunction('WAIT', function (mixed $ms = 0): void {
            if (!is_int($ms) || $ms < 0) {
                throw new \InvalidArgumentException('WAIT expects a non-negative INT (milliseconds)');
            }
            $this->endOfScan((float) $ms);
        });

        return $interpreter;
    }

    /**
     * Scan boundary. Throws ReloadSignal/StopSignal to unwind the program.
     */
    private function endOfScan(float $sleepMs): void
    {
        $interpreter = $this->interpreter;
        $devices = $this->devices;
        if ($interpreter === null || $devices === null) {
            return;
        }

        $now = microtime(true);
        $this->lastScanMs = ($now - $this->scanStartedAt) * 1000;
        $this->maxScanMs = max($this->maxScanMs, $this->lastScanMs);
        $this->scanCount++;

        $devices->flush();
        $this->applyCommands($interpreter);
        $devices->flush();
        $this->writeStatus();

        if ($this->stopRequested) {
            throw new StopSignal();
        }
        if ($now - $this->lastReloadCheck >= self::RELOAD_CHECK_INTERVAL) {
            $this->lastReloadCheck = $now;
            if ($this->programChanged()) {
                throw new ReloadSignal();
            }
        }

        $this->sleepServing($sleepMs / 1000);

        $interpreter->kickWatchdog();
        $devices->beginScan();
        $this->scanStartedAt = microtime(true);
    }

    private function applyCommands(Interpreter $interpreter): void
    {
        foreach ($this->commands->drain() as $command) {
            $tag = (string) ($command['tag'] ?? '');
            if (($command['type'] ?? '') !== 'write' || $tag === '') {
                $this->logger->warning('Ignoring malformed command');
                continue;
            }
            try {
                $interpreter->writeTag($tag, $command['value'] ?? null);
                $this->logger->info('Operator write', ['tag' => $tag, 'value' => json_encode($command['value'] ?? null)]);
            } catch (SclException $e) {
                $this->logger->warning('Operator write rejected', ['tag' => $tag, 'reason' => $e->getRawMessage()]);
            }
        }
    }

    private function fault(\Throwable $e): void
    {
        $line = $e instanceof SclException ? $e->sourceLine : null;
        $message = $e instanceof SclException ? $e->getRawMessage() : $e::class . ': ' . $e->getMessage();
        $this->state = self::STATE_FAULT;
        $this->lastError = ['message' => $message, 'line' => $line, 'at' => microtime(true)];
        $this->logger->error('Program fault', ['error' => $message, 'line' => $line]);
        $this->writeStatus(true);
    }

    /** Puts the outputs in their configured safe state after a fault or a stop. */
    private function safeStop(): void
    {
        if ($this->config->outputsOffOnFault && $this->devices !== null) {
            $this->logger->warning('Driving all outputs OFF (VPLC_FAULT_OUTPUTS=off)');
            $this->devices->allOutputsOff();
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** Serves Modbus / publishes status until $done returns true or a stop is requested. */
    private function idle(callable $done): void
    {
        while (!$this->stopRequested && !$done()) {
            $this->writeStatus();
            $this->sleepServing(0.25);
        }
    }

    private function sleepServing(float $seconds): void
    {
        $deadline = microtime(true) + $seconds;
        do {
            $remaining = $deadline - microtime(true);
            if ($this->server !== null) {
                $this->server->poll(max(0.0, min($remaining, 0.05)));
            } elseif ($remaining > 0) {
                usleep((int) min($remaining * 1e6, 50_000));
            }
        } while (!$this->stopRequested && microtime(true) < $deadline);
    }

    private function programChanged(): bool
    {
        $file = $this->config->programFile();
        clearstatcache(true, $file);
        $hash = is_file($file) ? @hash_file('sha256', $file) : false;

        return ($hash === false ? null : $hash) !== $this->programHash;
    }

    private function writeStatus(bool $force = false): void
    {
        $now = microtime(true);
        if (!$force && $now - $this->lastStatusAt < self::STATUS_INTERVAL) {
            return;
        }
        $this->lastStatusAt = $now;

        $status = [
            'state' => $this->state,
            'updated_at' => round($now, 3),
            'started_at' => round($this->startedAt, 3),
            'pid' => getmypid(),
            'program' => [
                'hash' => $this->programHash,
                'loaded_at' => $this->programLoadedAt === null ? null : round($this->programLoadedAt, 3),
            ],
            'scan' => [
                'count' => $this->scanCount,
                'last_ms' => round($this->lastScanMs, 2),
                'max_ms' => round($this->maxScanMs, 2),
            ],
            'error' => $this->lastError,
            'devices' => $this->devices?->status() ?? [],
            'modbus' => [
                'enabled' => $this->server !== null,
                'port' => $this->server?->localPort(),
                'clients' => $this->server?->clientCount() ?? 0,
            ],
            'variables' => $this->interpreter?->memory() ?? (object) [],
            'mapping' => $this->server?->registerMap()->toArray() ?? (object) [],
        ];

        try {
            $json = (string) json_encode($status, JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
            Files::writeAtomic($this->config->statusFile(), $json);
        } catch (\Throwable $e) {
            $this->logger->warning('Cannot write status file', ['error' => $e->getMessage()]);
        }
    }

    private function ensureDataDir(): void
    {
        $dir = $this->config->dataDir;
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create data directory {$dir}");
        }
        if (!is_writable($dir)) {
            throw new \RuntimeException("Data directory {$dir} is not writable");
        }
    }

    private function installSignalHandlers(): void
    {
        if (!function_exists('pcntl_async_signals')) {
            $this->logger->debug('ext-pcntl not available: no graceful shutdown on SIGTERM');
            return;
        }
        pcntl_async_signals(true);
        $handler = function (int $signal): void {
            $this->logger->info('Signal received', ['signal' => $signal]);
            $this->stopRequested = true;
        };
        pcntl_signal(SIGTERM, $handler);
        pcntl_signal(SIGINT, $handler);
    }
}
