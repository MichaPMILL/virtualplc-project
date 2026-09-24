<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class ForStmt extends Stmt
{
    /** @param list<Stmt> $body */
    public function __construct(
        public readonly string $variable,
        public readonly Expr $start,
        public readonly Expr $end,
        public readonly ?Expr $step,
        public readonly array $body,
        int $line,
    ) {
        parent::__construct($line);
    }
}
