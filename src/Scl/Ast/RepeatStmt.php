<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class RepeatStmt extends Stmt
{
    /** @param list<Stmt> $body */
    public function __construct(
        public readonly array $body,
        public readonly Expr $until,
        int $line,
    ) {
        parent::__construct($line);
    }
}
