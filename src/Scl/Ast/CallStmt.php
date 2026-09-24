<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class CallStmt extends Stmt
{
    public function __construct(public readonly CallExpr $call)
    {
        parent::__construct($call->line);
    }
}
