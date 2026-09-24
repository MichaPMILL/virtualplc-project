<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class AddressRef extends Expr
{
    public function __construct(public readonly Address $address, int $line)
    {
        parent::__construct($line);
    }
}
