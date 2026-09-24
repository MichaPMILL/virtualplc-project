<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Library;

use VirtualPLC\Scl\Value\StructValue;

/**
 * IEC counters (INT range, counting on rising edges):
 *  - CTU:  CU, R, PV -> Q (CV >= PV), CV
 *  - CTD:  CD, LD, PV -> Q (CV <= 0), CV
 *  - CTUD: CU, CD, R, LD, PV -> QU, QD, CV
 */
final class Counter implements NativeFunctionBlock
{
    private const MAX = 32767;
    private const MIN = -32768;

    public function __construct(private readonly string $kind)
    {
    }

    public function name(): string
    {
        return $this->kind;
    }

    public function inputs(): array
    {
        return match ($this->kind) {
            'CTU' => ['CU' => 'BOOL', 'R' => 'BOOL', 'PV' => 'INT'],
            'CTD' => ['CD' => 'BOOL', 'LD' => 'BOOL', 'PV' => 'INT'],
            default => ['CU' => 'BOOL', 'CD' => 'BOOL', 'R' => 'BOOL', 'LD' => 'BOOL', 'PV' => 'INT'],
        };
    }

    public function outputs(): array
    {
        return match ($this->kind) {
            'CTU', 'CTD' => ['Q' => 'BOOL', 'CV' => 'INT'],
            default => ['QU' => 'BOOL', 'QD' => 'BOOL', 'CV' => 'INT'],
        };
    }

    public function state(): array
    {
        return ['_lastUp' => false, '_lastDown' => false];
    }

    public function execute(StructValue $c, int $now): void
    {
        $v = &$c->values;
        $up = (bool) ($v['CU'] ?? false);
        $down = (bool) ($v['CD'] ?? false);
        $upEdge = $up && !$v['_lastUp'];
        $downEdge = $down && !$v['_lastDown'];
        $v['_lastUp'] = $up;
        $v['_lastDown'] = $down;
        $pv = (int) $v['PV'];

        if (($v['R'] ?? false) === true) {
            $v['CV'] = 0;
        } elseif (($v['LD'] ?? false) === true) {
            $v['CV'] = $pv;
        } else {
            if ($upEdge && $v['CV'] < self::MAX && $this->kind !== 'CTD') {
                $v['CV']++;
            }
            if ($downEdge && $v['CV'] > self::MIN && $this->kind !== 'CTU') {
                $v['CV']--;
            }
        }

        match ($this->kind) {
            'CTU' => $v['Q'] = $v['CV'] >= $pv,
            'CTD' => $v['Q'] = $v['CV'] <= 0,
            default => [$v['QU'], $v['QD']] = [$v['CV'] >= $pv, $v['CV'] <= 0],
        };
    }
}
