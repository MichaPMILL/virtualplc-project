<?php

declare(strict_types=1);

namespace VirtualPLC\Support;

/**
 * Small leveled logger writing one line per entry:
 *   2026-01-01T12:00:00.123+00:00 [INFO] [modbus] message key=value
 *
 * Writes to STDERR by default, which plays well with systemd/journald and Docker.
 */
final class Logger
{
    public const DEBUG = 100;
    public const INFO = 200;
    public const WARNING = 300;
    public const ERROR = 400;

    private const NAMES = [self::DEBUG => 'DEBUG', self::INFO => 'INFO', self::WARNING => 'WARNING', self::ERROR => 'ERROR'];

    /** @var resource */
    private $stream;

    /**
     * @param resource|null $stream
     */
    public function __construct(
        private readonly int $minLevel = self::INFO,
        $stream = null,
        private readonly string $channel = 'plc',
    ) {
        $this->stream = $stream ?? (defined('STDERR') ? STDERR : fopen('php://stderr', 'w'));
    }

    public static function levelFromName(string $name): int
    {
        return match (strtolower($name)) {
            'debug' => self::DEBUG,
            'warning', 'warn' => self::WARNING,
            'error' => self::ERROR,
            default => self::INFO,
        };
    }

    public function withChannel(string $channel): self
    {
        return new self($this->minLevel, $this->stream, $channel);
    }

    /** @param array<string, scalar|null> $context */
    public function debug(string $message, array $context = []): void
    {
        $this->log(self::DEBUG, $message, $context);
    }

    /** @param array<string, scalar|null> $context */
    public function info(string $message, array $context = []): void
    {
        $this->log(self::INFO, $message, $context);
    }

    /** @param array<string, scalar|null> $context */
    public function warning(string $message, array $context = []): void
    {
        $this->log(self::WARNING, $message, $context);
    }

    /** @param array<string, scalar|null> $context */
    public function error(string $message, array $context = []): void
    {
        $this->log(self::ERROR, $message, $context);
    }

    /** @param array<string, scalar|null> $context */
    public function log(int $level, string $message, array $context = []): void
    {
        if ($level < $this->minLevel) {
            return;
        }

        $line = sprintf(
            '%s [%s] [%s] %s',
            (new \DateTimeImmutable())->format('Y-m-d\TH:i:s.vP'),
            self::NAMES[$level] ?? 'INFO',
            $this->channel,
            str_replace(["\r", "\n"], ' ', $message),
        );
        foreach ($context as $key => $value) {
            $value = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
            $line .= ' ' . $key . '=' . (preg_match('/[\s"]/', $value) === 1 ? json_encode($value) : $value);
        }

        @fwrite($this->stream, $line . "\n");
    }
}
