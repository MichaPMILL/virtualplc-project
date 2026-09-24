<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/**
 * Reference to a data type: an elementary type (BOOL, INT, REAL, TIME...),
 * a function block type (TON, user FBs) or a one-dimensional ARRAY.
 */
final class TypeRef
{
    /** Elementary types and their storage class. */
    public const ELEMENTARY = [
        'BOOL' => 'bool',
        'BYTE' => 'int', 'WORD' => 'int', 'DWORD' => 'int',
        'SINT' => 'int', 'USINT' => 'int',
        'INT' => 'int', 'UINT' => 'int',
        'DINT' => 'int', 'UDINT' => 'int', 'LINT' => 'int',
        'REAL' => 'float', 'LREAL' => 'float',
        'TIME' => 'int',
        'STRING' => 'string',
    ];

    /** Integer ranges: [bits, signed]. */
    public const INTEGER_RANGES = [
        'BYTE' => [8, false], 'USINT' => [8, false], 'SINT' => [8, true],
        'WORD' => [16, false], 'UINT' => [16, false], 'INT' => [16, true],
        'DWORD' => [32, false], 'UDINT' => [32, false], 'DINT' => [32, true], 'TIME' => [32, true],
        'LINT' => [64, true],
    ];

    /** Common aliases found in IEC sources. */
    private const ALIASES = ['IEC_TIMER' => 'TON', 'TON_TIME' => 'TON', 'TOF_TIME' => 'TOF', 'TP_TIME' => 'TP', 'IEC_COUNTER' => 'CTUD'];

    public readonly string $name;

    public function __construct(
        string $name,
        public readonly ?TypeRef $element = null,
        public readonly int $low = 0,
        public readonly int $high = 0,
    ) {
        $upper = strtoupper($name);
        $upper = self::ALIASES[$upper] ?? $upper;
        $this->name = isset(self::ELEMENTARY[$upper]) || $element !== null ? $upper : $name;
    }

    public static function of(string $name): self
    {
        return new self($name);
    }

    public static function array(TypeRef $element, int $low, int $high): self
    {
        return new self('ARRAY', $element, $low, $high);
    }

    public function isArray(): bool
    {
        return $this->element !== null;
    }

    public function isElementary(): bool
    {
        return !$this->isArray() && isset(self::ELEMENTARY[$this->name]);
    }

    /** Upper-case key used to look up function block types. */
    public function key(): string
    {
        return strtoupper($this->name);
    }

    public function __toString(): string
    {
        return $this->isArray() ? "Array[{$this->low}..{$this->high}] of {$this->element}" : $this->name;
    }
}
