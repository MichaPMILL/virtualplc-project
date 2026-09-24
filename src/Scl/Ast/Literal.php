<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class Literal extends Expr
{
    public function __construct(public readonly int|bool|string $value, int $line)
    {
        parent::__construct($line);
    }
}
