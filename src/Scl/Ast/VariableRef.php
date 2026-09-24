<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class VariableRef extends Expr
{
    /** @param string|null $scope "global" for "quoted" names, "local" for #names */
    public function __construct(
        public readonly string $name,
        int $line,
        public readonly ?string $scope = null,
    ) {
        parent::__construct($line);
    }
}
