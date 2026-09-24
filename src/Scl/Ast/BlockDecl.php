<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class BlockDecl extends Node
{
    /** @param list<Stmt> $body */
    public function __construct(
        public readonly string $name,
        public readonly array $body,
        int $line,
    ) {
        parent::__construct($line);
    }
}
