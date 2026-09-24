<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class AssignStmt extends Stmt
{
    public function __construct(
        public readonly string $target,
        public readonly Expr $value,
        int $line,
    ) {
        parent::__construct($line);
    }
}
