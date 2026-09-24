<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Library;

use VirtualPLC\Scl\Value\StructValue;

/**
 * IEC 61131-3 timers, (TON, TOF, TP):
 *
 *  - TON: on-delay, Q goes TRUE when IN has been TRUE for PT
 *  - TOF: off-delay, Q stays TRUE for PT after IN goes FALSE
 *  - TP:  pulse, Q is TRUE for PT after a rising edge of IN (not retriggerable)
 */
final class Timer implements NativeFunctionBlock
{
    public const TON = 'TON';
    public const TOF = 'TOF';
    public const TP = 'TP';

    public function __construct(private readonly string $kind)
    {
    }

    public function name(): string
    {
        return $this->kind;
    }

    public function inputs(): array
    {
        return ['IN' => 'BOOL', 'PT' => 'TIME'];
    }

    public function outputs(): array
    {
        return ['Q' => 'BOOL', 'ET' => 'TIME'];
    }

    public function state(): array
    {
        return ['_start' => 0, '_running' => false, '_lastIn' => false];
    }

    public function execute(StructValue $t, int $now): void
    {
        $in = (bool) $t->values['IN'];
        $pt = max(0, (int) $t->values['PT']);
        $rising = $in && !$t->values['_lastIn'];
        $falling = !$in && $t->values['_lastIn'];
        $t->values['_lastIn'] = $in;

        switch ($this->kind) {
            case self::TON:
                if (!$in) {
                    $t->values['_running'] = false;
                    $t->values['Q'] = false;
                    $t->values['ET'] = 0;
                    return;
                }
                if ($rising || !$t->values['_running']) {
                    $t->values['_running'] = true;
                    $t->values['_start'] = $now;
                }
                $t->values['ET'] = min($pt, $now - $t->values['_start']);
                $t->values['Q'] = $t->values['ET'] >= $pt;
                return;

            case self::TOF:
                if ($in) {
                    $t->values['_running'] = false;
                    $t->values['Q'] = true;
                    $t->values['ET'] = 0;
                    return;
                }
                if ($falling) {
                    $t->values['_running'] = true;
                    $t->values['_start'] = $now;
                }
                if ($t->values['_running']) {
                    $t->values['ET'] = min($pt, $now - $t->values['_start']);
                    if ($t->values['ET'] >= $pt) {
                        $t->values['_running'] = false;
                        $t->values['Q'] = false;
                    }
                }
                return;

            default: // TP
                if ($rising && !$t->values['_running'] && !$t->values['Q']) {
                    $t->values['_running'] = true;
                    $t->values['_start'] = $now;
                    $t->values['Q'] = true;
                }
                if ($t->values['_running']) {
                    $t->values['ET'] = min($pt, $now - $t->values['_start']);
                    if ($t->values['ET'] >= $pt) {
                        $t->values['_running'] = false;
                        $t->values['Q'] = false;
                    }
                }
                if (!$in && !$t->values['_running']) {
                    $t->values['ET'] = 0;
                }
                return;
        }
    }
}
