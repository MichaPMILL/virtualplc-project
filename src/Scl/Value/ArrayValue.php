<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Value;

use VirtualPLC\Scl\Ast\TypeRef;

final class ArrayValue
{
    /** @param list<mixed> $items */
    public function __construct(
        public readonly TypeRef $type,
        public array $items,
    ) {
    }

    public function inBounds(int $index): bool
    {
        return $index >= $this->type->low && $index <= $this->type->high;
    }

    public function get(int $index): mixed
    {
        return $this->items[$index - $this->type->low];
    }

    public function set(int $index, mixed $value): void
    {
        $this->items[$index - $this->type->low] = $value;
    }

    public function __clone()
    {
        foreach ($this->items as $i => $value) {
            if (is_object($value)) {
                $this->items[$i] = clone $value;
            }
        }
    }
}
