<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

/**
 * Bridge between the interpreter and physical I/O.
 *
 * The interpreter follows PLC process-image semantics: inputs are read through
 * this handler, outputs are written to it, and reading an output variable
 * returns the value last assigned by the program (it never hits the hardware).
 */
interface IoHandler
{
    /**
     * @param mixed $device the value stored in the device variable (as returned by CONNECT)
     * @return bool|null current input state, or null when unavailable (the last known value is kept)
     */
    public function readInput(mixed $device, int $address): ?bool;

    /** @param mixed $device the value stored in the device variable (as returned by CONNECT) */
    public function writeOutput(mixed $device, int $address, bool $value): void;
}
