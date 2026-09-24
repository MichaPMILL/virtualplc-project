<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/** DATA_BLOCK: either a global DB with its own variables, or an instance DB of a function block. */
final class DataBlockDecl extends Node
{
    /**
     * @param list<VarDecl> $fields
     * @param list<Stmt>    $init   assignments of the BEGIN section (start values)
     */
    public function __construct(
        public readonly string $name,
        public readonly ?string $instanceOf,
        public readonly array $fields,
        public readonly array $init,
        int $line,
    ) {
        parent::__construct($line);
    }
}
