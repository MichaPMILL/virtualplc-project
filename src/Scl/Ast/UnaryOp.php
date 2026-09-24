<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

use VirtualPLC\Scl\TokenType;

final class UnaryOp extends Expr
{
    public function __construct(
        public readonly TokenType $op,
        public readonly Expr $operand,
        int $line,
    ) {
        parent::__construct($line);
    }
}
