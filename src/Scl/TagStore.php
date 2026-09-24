<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

/**
 * External access to program variables (HMI, Modbus slave, operator commands).
 * Names are case-insensitive.
 */
interface TagStore
{
    public function hasTag(string $name): bool;

    /** Returns the current value from memory, without triggering any I/O. */
    public function readTag(string $name): mixed;

    /** Writes a value with the variable's type coercion; bound outputs are propagated to the hardware. */
    public function writeTag(string $name, mixed $value): void;
}
