<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class Literal extends Expr
{
    /** @param string|null $type explicit type of typed literals (TIME for T#...) */
    public function __construct(
        public readonly int|float|bool|string $value,
        int $line,
        public readonly ?string $type = null,
    ) {
        parent::__construct($line);
    }
}
