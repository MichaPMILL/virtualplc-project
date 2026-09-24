<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

use VirtualPLC\Scl\TokenType;

final class AssignStmt extends Stmt
{
    /** @param TokenType|null $operator arithmetic operator of a compound assignment (+=, -=, ...) */
    public function __construct(
        public readonly Expr $target,
        public readonly Expr $value,
        int $line,
        public readonly ?TokenType $operator = null,
    ) {
        parent::__construct($line);
    }
}
