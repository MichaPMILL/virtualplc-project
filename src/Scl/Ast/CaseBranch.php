<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class CaseBranch
{
    /**
     * @param list<array{0: int, 1: int}> $ranges inclusive [low, high] pairs; single labels have low === high
     * @param list<Stmt>                  $body
     */
    public function __construct(
        public readonly array $ranges,
        public readonly array $body,
    ) {
    }

    public function matches(int $value): bool
    {
        foreach ($this->ranges as [$low, $high]) {
            if ($value >= $low && $value <= $high) {
                return true;
            }
        }

        return false;
    }
}
