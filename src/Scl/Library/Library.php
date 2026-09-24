<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Library;

/** Registry of the native function block types (TON, CTU, R_TRIG, ...). */
final class Library
{
    /** @return array<string, NativeFunctionBlock> upper-case name => implementation */
    public static function functionBlocks(): array
    {
        static $blocks = null;

        return $blocks ??= [
            'TON' => new Timer(Timer::TON),
            'TOF' => new Timer(Timer::TOF),
            'TP' => new Timer(Timer::TP),
            'R_TRIG' => new EdgeTrigger(true),
            'F_TRIG' => new EdgeTrigger(false),
            'CTU' => new Counter('CTU'),
            'CTD' => new Counter('CTD'),
            'CTUD' => new Counter('CTUD'),
        ];
    }

    public static function functionBlock(string $name): ?NativeFunctionBlock
    {
        return self::functionBlocks()[strtoupper($name)] ?? null;
    }

    private function __construct()
    {
    }
}
