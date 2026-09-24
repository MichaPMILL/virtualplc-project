<?php

declare(strict_types=1);

namespace VirtualPLC\Runtime;

use VirtualPLC\Modbus\ModbusTcpClient;
use VirtualPLC\Scl\IoHandler;
use VirtualPLC\Scl\RuntimeError;
use VirtualPLC\Support\Logger;

/**
 * Owns the connections to remote I/O modules and implements the
 * interpreter's I/O bridge. Device handles are small integers returned by
 * CONNECT() and stored in the SCL device variables.
 */
final class DeviceManager implements IoHandler
{
    /** @var list<Device> */
    private array $devices = [];

    /** @var \Closure(string, int, int, float): ModbusTcpClient */
    private \Closure $clientFactory;

    /**
     * @param (callable(string, int, int, float): ModbusTcpClient)|null $clientFactory
     */
    public function __construct(
        private readonly Logger $logger,
        private readonly float $timeout = 1.0,
        ?callable $clientFactory = null,
    ) {
        $this->clientFactory = $clientFactory !== null
            ? \Closure::fromCallable($clientFactory)
            : static fn (string $host, int $port, int $unit, float $timeout) => new ModbusTcpClient($host, $port, $unit, $timeout);
    }

    /** Implementation of the SCL CONNECT(host, port, unit) function. */
    public function connect(mixed $host, mixed $port = 502, mixed $unitId = 1): int
    {
        if (!is_string($host) || $host === '') {
            throw new RuntimeError('CONNECT: host must be a non-empty string');
        }
        if (!is_int($port) || $port < 1 || $port > 65535) {
            throw new RuntimeError('CONNECT: port must be between 1 and 65535');
        }
        if (!is_int($unitId) || $unitId < 0 || $unitId > 255) {
            throw new RuntimeError('CONNECT: unit id must be between 0 and 255');
        }

        $device = new Device(($this->clientFactory)($host, $port, $unitId, $this->timeout), $this->logger);
        $device->connect();
        $this->devices[] = $device;

        return count($this->devices) - 1;
    }

    public function readInput(mixed $device, int $address): ?bool
    {
        return $this->device($device)->readInput($address);
    }

    public function writeOutput(mixed $device, int $address, bool $value): void
    {
        $this->device($device)->writeOutput($address, $value);
    }

    public function isOnline(mixed $device): bool
    {
        return $this->device($device)->isOnline();
    }

    public function beginScan(): void
    {
        foreach ($this->devices as $device) {
            $device->beginScan();
        }
    }

    public function flush(): void
    {
        foreach ($this->devices as $device) {
            $device->flush();
        }
    }

    public function allOutputsOff(): void
    {
        foreach ($this->devices as $device) {
            $device->allOutputsOff();
        }
    }

    /** Flushes pending outputs, then closes every connection (they reopen on next use). */
    public function disconnectAll(bool $flush = true): void
    {
        if ($flush) {
            $this->flush();
        }
        foreach ($this->devices as $device) {
            $device->disconnect();
        }
    }

    /** @return list<array{device: string, online: bool, error: string|null}> */
    public function status(): array
    {
        return array_map(static fn (Device $d) => $d->status(), $this->devices);
    }

    private function device(mixed $handle): Device
    {
        if (!is_int($handle) || !isset($this->devices[$handle])) {
            throw new RuntimeError('Invalid device handle (was the device declared with CONNECT in HARDWARE?)');
        }

        return $this->devices[$handle];
    }
}
