<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class CaseStmt extends Stmt
{
    /**
     * @param list<CaseBranch> $branches
     * @param list<Stmt>|null  $else
     */
    public function __construct(
        public readonly Expr $selector,
        public readonly array $branches,
        public readonly ?array $else,
        int $line,
    ) {
        parent::__construct($line);
    }
}
