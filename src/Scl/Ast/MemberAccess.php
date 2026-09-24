<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/** instance.member, e.g. "Timer_DB".Q or #Motor.Running */
final class MemberAccess extends Expr
{
    public function __construct(
        public readonly Expr $base,
        public readonly string $member,
        int $line,
    ) {
        parent::__construct($line);
    }
}
