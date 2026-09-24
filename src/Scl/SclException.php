<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

/**
 * Base class for every error raised by the SCL toolchain.
 * Carries an optional source position (1-based line/column).
 */
class SclException extends \RuntimeException
{
    public function __construct(
        string $message,
        public readonly ?int $sourceLine = null,
        public readonly ?int $sourceColumn = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct(self::format($message, $sourceLine, $sourceColumn), 0, $previous);
    }

    /** Error message without the position prefix. */
    public function getRawMessage(): string
    {
        return preg_replace('/^Line \d+(, column \d+)?: /', '', $this->getMessage()) ?? $this->getMessage();
    }

    private static function format(string $message, ?int $line, ?int $column): string
    {
        if ($line === null) {
            return $message;
        }

        return $column === null
            ? "Line {$line}: {$message}"
            : "Line {$line}, column {$column}: {$message}";
    }
}
