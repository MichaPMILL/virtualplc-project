<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Value;

use VirtualPLC\Scl\Ast\TypeRef;

/**
 * A set of named, typed values: a function block instance, a data block,
 * or the local variables of a call. Member names are case-insensitive.
 */
final class StructValue
{
    /** @var array<string, mixed> canonical name => value */
    public array $values = [];

    /** @var array<string, TypeRef> canonical name => type */
    public array $types = [];

    /** @var array<string, string> upper-case name => canonical name */
    private array $names = [];

    /** @param string|null $typeName function block type of an instance, null for a plain structure */
    public function __construct(public readonly ?string $typeName = null)
    {
    }

    public function define(string $name, TypeRef $type, mixed $value): void
    {
        $this->names[strtoupper($name)] = $name;
        $this->types[$name] = $type;
        $this->values[$name] = $value;
    }

    public function canonical(string $name): ?string
    {
        return $this->names[strtoupper($name)] ?? null;
    }

    public function has(string $name): bool
    {
        return isset($this->names[strtoupper($name)]);
    }

    public function get(string $name): mixed
    {
        $canonical = $this->names[strtoupper($name)] ?? null;

        return $canonical === null ? null : $this->values[$canonical];
    }

    public function type(string $name): ?TypeRef
    {
        $canonical = $this->names[strtoupper($name)] ?? null;

        return $canonical === null ? null : $this->types[$canonical];
    }

    /** Raw write (no coercion): the interpreter coerces before calling it. */
    public function set(string $name, mixed $value): void
    {
        $canonical = $this->names[strtoupper($name)] ?? $name;
        $this->values[$canonical] = $value;
    }

    /** Plain PHP representation (for status / monitoring), hidden members (starting with "_") omitted. */
    public function export(): array
    {
        $out = [];
        foreach ($this->values as $name => $value) {
            if (str_starts_with($name, '_')) {
                continue;
            }
            $out[$name] = self::exportValue($value);
        }

        return $out;
    }

    public static function exportValue(mixed $value): mixed
    {
        return match (true) {
            $value instanceof self => $value->export(),
            $value instanceof ArrayValue => array_map(self::exportValue(...), $value->items),
            is_float($value) && (is_nan($value) || is_infinite($value)) => (string) $value,
            default => $value,
        };
    }

    public function __clone()
    {
        foreach ($this->values as $name => $value) {
            if (is_object($value)) {
                $this->values[$name] = clone $value;
            }
        }
    }
}
