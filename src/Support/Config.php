<?php

declare(strict_types=1);

namespace VirtualPLC\Support;

/**
 * Runtime configuration, read from environment variables (12-factor style).
 *
 * | Variable                 | Default        | Meaning                                              |
 * |--------------------------|----------------|------------------------------------------------------|
 * | VPLC_DATA_DIR            | <root>/var     | Project, program, status and command files           |
 * | VPLC_API_TOKEN           | (empty)        | Bearer token required by the HTTP API (recommended)  |
 * | VPLC_MODBUS_ENABLED      | 1              | Start the Modbus TCP server for HMIs                 |
 * | VPLC_MODBUS_BIND         | 0.0.0.0        | Modbus server bind address                           |
 * | VPLC_MODBUS_PORT         | 5020           | Modbus server port                                   |
 * | VPLC_CYCLE_MS            | 100            | Scan cycle when the FC returns (implicit cycle)      |
 * | VPLC_WATCHDOG_MS         | 5000           | Max run time without yielding (0 = disabled)         |
 * | VPLC_IO_TIMEOUT_MS       | 1000           | Modbus client connect/read timeout                   |
 * | VPLC_RESTART_DELAY_MS    | 5000           | Delay before restarting after a fault                |
 * | VPLC_FAULT_OUTPUTS       | hold           | Outputs on fault/stop: "hold" or "off"               |
 * | VPLC_LOG_LEVEL           | info           | debug, info, warning, error                          |
 */
final class Config
{
    public function __construct(
        public readonly string $dataDir,
        public readonly string $apiToken = '',
        public readonly bool $modbusEnabled = true,
        public readonly string $modbusBind = '0.0.0.0',
        public readonly int $modbusPort = 5020,
        public readonly int $cycleMs = 100,
        public readonly int $watchdogMs = 5000,
        public readonly int $ioTimeoutMs = 1000,
        public readonly int $restartDelayMs = 5000,
        public readonly bool $outputsOffOnFault = false,
        public readonly string $logLevel = 'info',
    ) {
    }

    /** @param array<string, string|false>|null $env defaults to getenv() */
    public static function fromEnvironment(?array $env = null): self
    {
        $get = static function (string $key, string $default) use ($env): string {
            $value = $env === null ? getenv($key) : ($env[$key] ?? false);

            return $value === false || $value === '' ? $default : trim((string) $value);
        };
        $int = static function (string $key, int $default, int $min, int $max) use ($get): int {
            $raw = $get($key, (string) $default);
            if (!preg_match('/^\d+$/', $raw) || (int) $raw < $min || (int) $raw > $max) {
                throw new \InvalidArgumentException("{$key} must be an integer between {$min} and {$max}, got '{$raw}'");
            }

            return (int) $raw;
        };
        $bool = static fn (string $key, bool $default): bool => in_array(
            strtolower($get($key, $default ? '1' : '0')),
            ['1', 'true', 'yes', 'on'],
            true,
        );

        $faultOutputs = strtolower($get('VPLC_FAULT_OUTPUTS', 'hold'));
        if (!in_array($faultOutputs, ['hold', 'off'], true)) {
            throw new \InvalidArgumentException("VPLC_FAULT_OUTPUTS must be 'hold' or 'off', got '{$faultOutputs}'");
        }

        return new self(
            dataDir: rtrim($get('VPLC_DATA_DIR', dirname(__DIR__, 2) . '/var'), '/'),
            apiToken: $get('VPLC_API_TOKEN', ''),
            modbusEnabled: $bool('VPLC_MODBUS_ENABLED', true),
            modbusBind: $get('VPLC_MODBUS_BIND', '0.0.0.0'),
            modbusPort: $int('VPLC_MODBUS_PORT', 5020, 1, 65535),
            cycleMs: $int('VPLC_CYCLE_MS', 100, 1, 60000),
            watchdogMs: $int('VPLC_WATCHDOG_MS', 5000, 0, 3600000),
            ioTimeoutMs: $int('VPLC_IO_TIMEOUT_MS', 1000, 50, 60000),
            restartDelayMs: $int('VPLC_RESTART_DELAY_MS', 5000, 0, 3600000),
            outputsOffOnFault: $faultOutputs === 'off',
            logLevel: $get('VPLC_LOG_LEVEL', 'info'),
        );
    }

    public function projectFile(): string
    {
        return $this->dataDir . '/project.json';
    }

    public function programFile(): string
    {
        return $this->dataDir . '/project.scl';
    }

    public function statusFile(): string
    {
        return $this->dataDir . '/status.json';
    }

    public function commandFile(): string
    {
        return $this->dataDir . '/commands.jsonl';
    }
}
