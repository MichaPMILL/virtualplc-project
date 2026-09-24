<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/** Maps a variable onto a physical I/O point: `Device.INPUT.3`. */
final class IoBinding
{
    public const INPUT = 'INPUT';
    public const OUTPUT = 'OUTPUT';

    public function __construct(
        public readonly string $device,
        public readonly string $io,
        public readonly int $address,
    ) {
    }
}
