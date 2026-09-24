<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/** A direct address of the process image: %I0.0, %QW2, %MD10 ... */
final class Address
{
    /**
     * @param string $area I (inputs), Q (outputs) or M (memory / markers)
     * @param string $size X (bit), B (byte), W (word), D (double word)
     */
    public function __construct(
        public readonly string $area,
        public readonly string $size,
        public readonly int $byte,
        public readonly int $bit = 0,
    ) {
    }

    /** Parses "I0.0", "IX0.0", "QW2", "%MD10". */
    public static function parse(string $text): ?self
    {
        $text = strtoupper(ltrim(trim($text), '%'));
        if (preg_match('/^([IQM])X?(\d{1,5})\.([0-7])$/', $text, $m) === 1) {
            return new self($m[1], 'X', (int) $m[2], (int) $m[3]);
        }
        if (preg_match('/^([IQM])([BWD])(\d{1,5})$/', $text, $m) === 1) {
            return new self($m[1], $m[2], (int) $m[3]);
        }

        return null;
    }

    /** Default elementary type for a direct access of this size. */
    public function defaultType(): string
    {
        return match ($this->size) {
            'X' => 'BOOL',
            'B' => 'BYTE',
            'W' => 'WORD',
            default => 'DWORD',
        };
    }

    /** Whether a variable of the given elementary type fits this address. */
    public function accepts(string $type): bool
    {
        return match ($this->size) {
            'X' => $type === 'BOOL',
            'B' => in_array($type, ['BYTE', 'SINT', 'USINT'], true),
            'W' => in_array($type, ['WORD', 'INT', 'UINT'], true),
            default => in_array($type, ['DWORD', 'DINT', 'UDINT', 'REAL', 'TIME'], true),
        };
    }

    public function __toString(): string
    {
        return '%' . $this->area . ($this->size === 'X' ? "{$this->byte}.{$this->bit}" : "{$this->size}{$this->byte}");
    }
}
