<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class VarDecl extends Node
{
    public const BOOL = 'BOOL';
    public const INT = 'INT';

    public function __construct(
        public readonly string $name,
        public readonly string $type,
        public readonly ?IoBinding $binding,
        public readonly ?Expr $initial,
        int $line,
    ) {
        parent::__construct($line);
    }
}
