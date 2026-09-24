<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Library;

use VirtualPLC\Scl\Value\StructValue;

/**
 * A function block implemented natively (IEC timers, counters, edge detection).
 * Instances are {@see StructValue}s holding inputs, outputs and hidden state
 * (members starting with "_").
 */
interface NativeFunctionBlock
{
    public function name(): string;

    /** @return array<string, string> input name => elementary type */
    public function inputs(): array;

    /** @return array<string, string> output name => elementary type */
    public function outputs(): array;

    /** @return array<string, mixed> hidden state name (starting with "_") => initial value */
    public function state(): array;

    /** @param int $now monotonic time in milliseconds */
    public function execute(StructValue $instance, int $now): void;
}
