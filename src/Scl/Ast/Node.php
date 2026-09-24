<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/** Base class of every AST node. */
abstract class Node
{
    public function __construct(public readonly int $line)
    {
    }
}
