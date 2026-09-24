<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/** A call argument: positional, `name := value` (input) or `name => target` (output). */
final class CallArg
{
    public function __construct(
        public readonly ?string $name,
        public readonly Expr $value,
        public readonly bool $output = false,
    ) {
    }
}
