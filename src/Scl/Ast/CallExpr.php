<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class CallExpr extends Expr
{
    /** @param list<Expr> $args */
    public function __construct(
        public readonly string $name,
        public readonly array $args,
        int $line,
    ) {
        parent::__construct($line);
    }
}
