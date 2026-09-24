<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Runtime;

use PHPUnit\Framework\TestCase;
use VirtualPLC\Modbus\ModbusTcpClient;
use VirtualPLC\Runtime\CommandQueue;

/**
 * End-to-end: real runtime process <-> simulated Modbus I/O module <-> HMI client.
 */
final class RuntimeIntegrationTest extends TestCase
{
    private string $dir;
    private int $ioPort;
    private int $hmiPort;
    /** @var list<resource> */
    private array $processes = [];

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/vplc-it-' . bin2hex(random_bytes(4));
        mkdir($this->dir . '/data', 0777, true);
        $this->ioPort = self::freePort();
        $this->hmiPort = self::freePort();
        $this->setInputs([false, false, false, false, false, false, false, false]);

        $this->spawn([PHP_BINARY, dirname(__DIR__) . '/Fixtures/fake-io-module.php', (string) $this->ioPort, $this->dir . '/in.json', $this->dir . '/out.json'], []);
        $this->waitFor(fn () => is_file($this->dir . '/out.json'), 'fake I/O module did not start');
    }

    protected function tearDown(): void
    {
        foreach ($this->processes as $process) {
            proc_terminate($process, SIGTERM);
            proc_close($process);
        }
        exec('rm -rf ' . escapeshellarg($this->dir));
    }

    public function testRunsTheProgramAgainstRemoteIo(): void
    {
        $this->deploy(<<<SCL
            HARDWARE
                Io := CONNECT('127.0.0.1', {$this->ioPort}, 1);
            END_HARDWARE
            VAR
                Enable : BOOL;
                Button : Io.INPUT.1;
                Lamp : Io.OUTPUT.0;
                Blink : Io.OUTPUT.5;
                Count : INT;
            END_VAR
            DB
                Enable := TRUE;
            END_DB
            FC
                Lamp := Enable AND Button;
                // Toggled twice per scan: must never reach the hardware.
                Blink := TRUE;
                Blink := FALSE;
                Count := Count + 1;
            END_FC
            SCL);
        $this->startRuntime();

        $this->waitFor(fn () => ($this->runtimeStatus()['state'] ?? null) === 'RUN', 'runtime did not start');
        self::assertFalse($this->outputs()[0]);

        // Input -> program -> output
        $this->setInputs([false, true]);
        $this->waitFor(fn () => $this->outputs()[0] === true, 'Lamp did not turn on');
        self::assertFalse($this->outputs()[5], 'outputs are written once per scan (no chatter)');

        // Operator command through the queue
        (new CommandQueue($this->dir . '/data/commands.jsonl'))->push(['type' => 'write', 'tag' => 'enable', 'value' => false]);
        $this->waitFor(fn () => $this->outputs()[0] === false, 'operator write not applied');

        // HMI access through the Modbus server
        $hmi = new ModbusTcpClient('127.0.0.1', $this->hmiPort, 1, 1.0);
        self::assertSame([false], $hmi->readCoils(0, 1));
        self::assertSame([true], $hmi->readDiscreteInputs(1, 1));
        $hmi->writeSingleCoil(0, true);
        $this->waitFor(fn () => $this->outputs()[0] === true, 'HMI write not applied');
        self::assertGreaterThan(0, $hmi->readHoldingRegisters(4, 1)[0], 'scan counter is running');
        $hmi->disconnect();

        $status = $this->runtimeStatus();
        self::assertTrue($status['devices'][0]['online']);
        self::assertGreaterThan(0, $status['scan']['count']);
    }

    public function testFaultsAndRecoversOnRedeploy(): void
    {
        $this->deploy("VAR x : INT; END_VAR\nFC\nx := 1 / x;\nEND_FC");
        $this->startRuntime();
        $this->waitFor(fn () => ($this->runtimeStatus()['state'] ?? null) === 'FAULT', 'runtime did not fault');
        self::assertSame('Division by zero', $this->runtimeStatus()['error']['message']);
        self::assertSame(3, $this->runtimeStatus()['error']['line']);

        $this->deploy("VAR x : INT; END_VAR\nFC\nx := x + 1;\nEND_FC");
        $this->waitFor(fn () => ($this->runtimeStatus()['state'] ?? null) === 'RUN', 'runtime did not reload the fixed program');
        self::assertNull($this->runtimeStatus()['error']);
    }

    public function testGracefulShutdown(): void
    {
        $this->deploy('FC END_FC');
        $runtime = $this->startRuntime();
        $this->waitFor(fn () => ($this->runtimeStatus()['state'] ?? null) === 'RUN', 'runtime did not start');

        proc_terminate($runtime, SIGTERM);
        $this->waitFor(fn () => !proc_get_status($runtime)['running'], 'runtime did not stop on SIGTERM');
        self::assertSame('STOPPED', $this->runtimeStatus()['state']);
    }

    // ------------------------------------------------------------------

    private function deploy(string $source): void
    {
        file_put_contents($this->dir . '/data/project.scl.tmp', $source);
        rename($this->dir . '/data/project.scl.tmp', $this->dir . '/data/project.scl');
    }

    /** @return resource */
    private function startRuntime()
    {
        return $this->spawn([PHP_BINARY, dirname(__DIR__, 2) . '/bin/virtualplc', 'run'], [
            'VPLC_DATA_DIR' => $this->dir . '/data',
            'VPLC_MODBUS_BIND' => '127.0.0.1',
            'VPLC_MODBUS_PORT' => (string) $this->hmiPort,
            'VPLC_CYCLE_MS' => '20',
            'VPLC_RESTART_DELAY_MS' => '100',
            'VPLC_LOG_LEVEL' => 'error',
        ]);
    }

    /**
     * @param list<string>          $command
     * @param array<string, string> $env
     * @return resource
     */
    private function spawn(array $command, array $env)
    {
        $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['file', $this->dir . '/stdout.log', 'a'], 2 => ['file', $this->dir . '/stderr.log', 'a']], $pipes, null, $env + getenv());
        self::assertIsResource($process);
        $this->processes[] = $process;

        return $process;
    }

    /** @param list<bool> $inputs */
    private function setInputs(array $inputs): void
    {
        file_put_contents($this->dir . '/in.json.tmp', json_encode(array_pad($inputs, 8, false)));
        rename($this->dir . '/in.json.tmp', $this->dir . '/in.json');
    }

    /** @return list<bool> */
    private function outputs(): array
    {
        $outputs = json_decode((string) @file_get_contents($this->dir . '/out.json'), true);

        return is_array($outputs) ? $outputs : array_fill(0, 8, false);
    }

    /** @return array<string, mixed> */
    private function runtimeStatus(): array
    {
        $status = json_decode((string) @file_get_contents($this->dir . '/data/status.json'), true);

        return is_array($status) ? $status : [];
    }

    private function waitFor(callable $condition, string $message, float $timeout = 5.0): void
    {
        $deadline = microtime(true) + $timeout;
        while (microtime(true) < $deadline) {
            if ($condition()) {
                $this->addToAssertionCount(1);
                return;
            }
            usleep(20_000);
        }
        self::fail($message . "\n" . @file_get_contents($this->dir . '/stderr.log'));
    }

    private static function freePort(): int
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0');
        self::assertNotFalse($socket);
        $name = (string) stream_socket_get_name($socket, false);
        fclose($socket);

        return (int) substr($name, strrpos($name, ':') + 1);
    }
}
