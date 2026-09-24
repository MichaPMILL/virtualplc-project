<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Control;

/** @internal Skips to the next iteration of the innermost loop on CONTINUE. */
final class ContinueSignal extends \Exception
{
    public function __construct(public readonly int $sourceLine)
    {
        parent::__construct('CONTINUE');
    }
}
