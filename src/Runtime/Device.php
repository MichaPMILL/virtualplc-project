<?php

declare(strict_types=1);

namespace VirtualPLC\Runtime;

use VirtualPLC\Modbus\ModbusException;
use VirtualPLC\Modbus\ModbusTcpClient;
use VirtualPLC\Support\Logger;

/**
 * A remote Modbus I/O module with PLC process-image semantics.
 *
 * - Inputs are read at most once per scan (lazily, on first access).
 * - Outputs are buffered during the scan and written at the end of the scan,
 *   only when they changed, so a variable toggled several times within one
 *   scan never makes a relay chatter.
 * - Communication failures mark the device offline and trigger reconnection
 *   with exponential backoff (1s .. 30s), without blocking every scan on a
 *   dead device. On reconnection all outputs are re-sent.
 */
final class Device
{
    private const MIN_BACKOFF = 1.0;
    private const MAX_BACKOFF = 30.0;
    /** Outputs are re-sent periodically in case the module reset them on its own. */
    private const RESYNC_INTERVAL = 30.0;

    /** @var list<bool>|null input image for the current scan */
    private ?array $inputs = null;
    private int $inputSpan = 8;

    /** @var array<int, bool> output image requested by the program */
    private array $desired = [];

    /** @var array<int, bool> last values acknowledged by the device */
    private array $written = [];

    private bool $online = false;
    private bool $everConnected = false;
    private ?string $lastError = null;
    private float $retryAt = 0.0;
    private float $backoff = self::MIN_BACKOFF;
    private float $lastResync = 0.0;

    public function __construct(
        private readonly ModbusTcpClient $client,
        private readonly Logger $logger,
    ) {
    }

    public function label(): string
    {
        return "{$this->client->host}:{$this->client->port}#{$this->client->unitId}";
    }

    public function connect(): bool
    {
        try {
            $this->client->connect();
            $this->markOnline();
        } catch (ModbusException $e) {
            $this->markOffline($e);
        }

        return $this->online;
    }

    public function isOnline(): bool
    {
        return $this->online;
    }

    public function beginScan(): void
    {
        $this->inputs = null;
    }

    public function readInput(int $address): ?bool
    {
        if ($this->inputs === null || $address >= count($this->inputs)) {
            if (!$this->canAttempt()) {
                return null;
            }
            $this->inputSpan = max($this->inputSpan, $address + 1);
            try {
                $this->inputs = $this->client->readDiscreteInputs(0, $this->inputSpan);
                $this->markOnline();
            } catch (ModbusException $e) {
                $this->markOffline($e);

                return null;
            }
        }

        return $this->inputs[$address];
    }

    public function writeOutput(int $address, bool $value): void
    {
        $this->desired[$address] = $value;
    }

    /** Writes changed outputs to the device. */
    public function flush(): void
    {
        if ($this->desired === [] || !$this->canAttempt()) {
            return;
        }
        $now = microtime(true);
        if ($now - $this->lastResync >= self::RESYNC_INTERVAL) {
            $this->written = [];
            $this->lastResync = $now;
        }

        foreach ($this->desired as $address => $value) {
            if (($this->written[$address] ?? null) === $value) {
                continue;
            }
            try {
                $this->client->writeSingleCoil($address, $value);
                $this->written[$address] = $value;
                $this->markOnline();
            } catch (ModbusException $e) {
                $this->markOffline($e);

                return;
            }
        }
    }

    /** Drives every output the program has used to OFF (fail-safe) and flushes. */
    public function allOutputsOff(): void
    {
        foreach (array_keys($this->desired) as $address) {
            $this->desired[$address] = false;
        }
        $this->retryAt = 0.0;
        $this->flush();
    }

    /**
     * Closes the connection on purpose (DISCONNECT_ALL). The output image is
     * kept, so unchanged outputs do not cause a reconnection on the next flush.
     */
    public function disconnect(): void
    {
        $this->client->disconnect();
        $this->online = false;
        $this->inputs = null;
        $this->retryAt = 0.0;
    }

    /** @return array{device: string, online: bool, error: string|null} */
    public function status(): array
    {
        return ['device' => $this->label(), 'online' => $this->online, 'error' => $this->lastError];
    }

    private function canAttempt(): bool
    {
        return $this->online || microtime(true) >= $this->retryAt;
    }

    private function markOnline(): void
    {
        if (!$this->online) {
            $context = ['device' => $this->label()];
            if (!$this->everConnected) {
                $this->logger->info('I/O device connected', $context);
            } elseif ($this->lastError !== null) {
                $this->logger->info('I/O device reconnected', $context);
            } else {
                $this->logger->debug('I/O device reconnected', $context);
            }
            $this->online = true;
            $this->everConnected = true;
        }
        $this->lastError = null;
        $this->backoff = self::MIN_BACKOFF;
    }

    private function markOffline(ModbusException $e): void
    {
        if ($this->online || $this->lastError === null) {
            $this->logger->warning('I/O device offline', [
                'device' => $this->label(),
                'error' => $e->getMessage(),
                'retry_in_s' => $this->backoff,
            ]);
        }
        $this->client->disconnect();
        $this->online = false;
        $this->lastError = $e->getMessage();
        $this->written = []; // unknown device state: re-send every output once back online
        $this->inputs = null;
        $this->retryAt = microtime(true) + $this->backoff;
        $this->backoff = min($this->backoff * 2, self::MAX_BACKOFF);
    }
}
