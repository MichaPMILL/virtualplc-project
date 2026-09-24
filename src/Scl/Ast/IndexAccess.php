<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class IndexAccess extends Expr
{
    public function __construct(
        public readonly Expr $base,
        public readonly Expr $index,
        int $line,
    ) {
        parent::__construct($line);
    }
}
