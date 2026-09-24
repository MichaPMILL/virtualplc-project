<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class WhileStmt extends Stmt
{
    /** @param list<Stmt> $body */
    public function __construct(
        public readonly Expr $condition,
        public readonly array $body,
        int $line,
    ) {
        parent::__construct($line);
    }
}
