<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Control;

/** @internal Unwinds the stack to the innermost loop on EXIT. */
final class ExitSignal extends \Exception
{
    public function __construct(public readonly int $sourceLine)
    {
        parent::__construct('EXIT');
    }
}
