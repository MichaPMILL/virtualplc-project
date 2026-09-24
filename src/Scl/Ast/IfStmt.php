<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/**
 * IF / ELSIF / ELSE chain. `ELSE IF` (two words) is accepted as an alias of ELSIF
 * and shares the same closing END_IF.
 */
final class IfStmt extends Stmt
{
    /**
     * @param list<array{0: Expr, 1: list<Stmt>}> $branches condition/body pairs, evaluated in order
     * @param list<Stmt>|null                      $else
     */
    public function __construct(
        public readonly array $branches,
        public readonly ?array $else,
        int $line,
    ) {
        parent::__construct($line);
    }
}
