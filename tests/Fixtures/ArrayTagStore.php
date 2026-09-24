<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Fixtures;

use VirtualPLC\Scl\RuntimeError;
use VirtualPLC\Scl\TagStore;

/** In-memory TagStore used to simulate I/O modules and HMIs in tests. */
final class ArrayTagStore implements TagStore
{
    /** @param array<string, mixed> $values */
    public function __construct(public array $values = [])
    {
    }

    public function hasTag(string $name): bool
    {
        return array_key_exists($name, $this->values);
    }

    public function readTag(string $name): mixed
    {
        return $this->values[$name] ?? throw new RuntimeError("Unknown tag {$name}");
    }

    public function writeTag(string $name, mixed $value): void
    {
        if (!$this->hasTag($name)) {
            throw new RuntimeError("Unknown tag {$name}");
        }
        $this->values[$name] = $value;
    }
}
