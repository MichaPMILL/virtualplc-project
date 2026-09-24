<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class VarDecl extends Node
{
    public const GLOBAL = 'global';
    public const INPUT = 'input';
    public const OUTPUT = 'output';
    public const IN_OUT = 'inout';
    public const STATIC = 'static';
    public const TEMP = 'temp';
    public const CONSTANT = 'constant';

    /** @deprecated kept for the historical syntax; use $type */
    public const BOOL = 'BOOL';
    /** @deprecated kept for the historical syntax; use $type */
    public const INT = 'INT';

    public function __construct(
        public readonly string $name,
        public readonly TypeRef $type,
        public readonly ?IoBinding $binding,
        public readonly ?Expr $initial,
        int $line,
        public readonly string $section = self::GLOBAL,
        public readonly ?Address $address = null,
    ) {
        parent::__construct($line);
    }
}
