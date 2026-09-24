<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/**
 * Call of a function, a block, or a function block instance:
 *   LOG(...);  "MyFC"(a := 1);  "Motor_DB"(Start := x, Running => y);  #Timer(IN := x, PT := T#5s);
 */
final class CallExpr extends Expr
{
    /** @param list<CallArg> $args */
    public function __construct(
        public readonly Expr $callee,
        public readonly array $args,
        int $line,
    ) {
        parent::__construct($line);
    }

    /** Name of the callee when it is a plain identifier (function / FC / instance name). */
    public function name(): ?string
    {
        return $this->callee instanceof VariableRef ? $this->callee->name : null;
    }
}
