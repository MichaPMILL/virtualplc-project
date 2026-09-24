<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Library;

use VirtualPLC\Scl\Value\StructValue;

/** R_TRIG / F_TRIG: Q is TRUE for one call on a rising / falling edge of CLK. */
final class EdgeTrigger implements NativeFunctionBlock
{
    public function __construct(private readonly bool $rising)
    {
    }

    public function name(): string
    {
        return $this->rising ? 'R_TRIG' : 'F_TRIG';
    }

    public function inputs(): array
    {
        return ['CLK' => 'BOOL'];
    }

    public function outputs(): array
    {
        return ['Q' => 'BOOL'];
    }

    public function state(): array
    {
        // A falling edge detector starts "high" so that it does not fire on the first call.
        return ['_mem' => !$this->rising];
    }

    public function execute(StructValue $i, int $now): void
    {
        $clk = (bool) $i->values['CLK'];
        $i->values['Q'] = $this->rising ? ($clk && !$i->values['_mem']) : (!$clk && $i->values['_mem']);
        $i->values['_mem'] = $clk;
    }
}
