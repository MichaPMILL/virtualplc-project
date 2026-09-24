<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class VariableRef extends Expr
{
    public function __construct(public readonly string $name, int $line)
    {
        parent::__construct($line);
    }
}
