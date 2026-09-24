<?php

declare(strict_types=1);

namespace VirtualPLC\Modbus;

use VirtualPLC\Scl\Ast\IoBinding;
use VirtualPLC\Scl\Ast\VarDecl;

/**
 * Exposes program variables to Modbus clients (HMI/SCADA).
 *
 * Each variable gets the address equal to its position in the VAR section
 * (the "REG" number shown in the web IDE):
 *
 *   - BOOL bound to an input      -> Discrete input  (1x, read-only)
 *   - other BOOL                  -> Coil            (0x, read/write)
 *   - INT                         -> Holding register (4x, read/write)
 *                                    and Input register (3x, read-only mirror)
 *
 * Tag names can be discovered through input registers starting at
 * NAME_TABLE_BASE: variable n occupies NAME_SLOT_REGISTERS registers
 * (2 ASCII chars per register, NUL padded) at NAME_TABLE_BASE + n * NAME_SLOT_REGISTERS.
 */
final class RegisterMap
{
    public const NAME_TABLE_BASE = 1000;
    public const NAME_SLOT_REGISTERS = 10;

    /**
     * @param array<int, string> $coils
     * @param array<int, string> $discreteInputs
     * @param array<int, string> $holdingRegisters
     * @param array<int, string> $inputRegisters
     * @param list<string>       $names
     */
    public function __construct(
        public readonly array $coils = [],
        public readonly array $discreteInputs = [],
        public readonly array $holdingRegisters = [],
        public readonly array $inputRegisters = [],
        public readonly array $names = [],
    ) {
    }

    /** @param iterable<VarDecl> $declarations */
    public static function fromDeclarations(iterable $declarations): self
    {
        $coils = $di = $hr = $ir = [];
        $names = [];
        $index = 0;
        foreach ($declarations as $var) {
            $names[] = $var->name;
            if ($var->type === VarDecl::INT) {
                $hr[$index] = $var->name;
                $ir[$index] = $var->name;
            } elseif ($var->binding?->io === IoBinding::INPUT) {
                $di[$index] = $var->name;
            } else {
                $coils[$index] = $var->name;
            }
            $index++;
        }

        return new self($coils, $di, $hr, $ir, $names);
    }

    /** @return array{coils: array<int, string>, discrete_inputs: array<int, string>, holding_registers: array<int, string>, input_registers: array<int, string>} */
    public function toArray(): array
    {
        return [
            'coils' => $this->coils,
            'discrete_inputs' => $this->discreteInputs,
            'holding_registers' => $this->holdingRegisters,
            'input_registers' => $this->inputRegisters,
        ];
    }

    /** Value of the name-table register at $address (>= NAME_TABLE_BASE). */
    public function nameRegister(int $address): int
    {
        $offset = $address - self::NAME_TABLE_BASE;
        $name = $this->names[intdiv($offset, self::NAME_SLOT_REGISTERS)] ?? '';
        $chars = str_pad(substr($name, ($offset % self::NAME_SLOT_REGISTERS) * 2, 2), 2, "\0");

        return (ord($chars[0]) << 8) | ord($chars[1]);
    }
}
