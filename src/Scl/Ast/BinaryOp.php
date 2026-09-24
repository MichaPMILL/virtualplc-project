<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

use VirtualPLC\Scl\TokenType;

final class BinaryOp extends Expr
{
    public function __construct(
        public readonly TokenType $op,
        public readonly Expr $left,
        public readonly Expr $right,
        int $line,
    ) {
        parent::__construct($line);
    }
}
