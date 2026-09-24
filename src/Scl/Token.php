<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

final class Token
{
    public function __construct(
        public readonly TokenType $type,
        public readonly int|bool|string|null $value,
        public readonly int $line,
        public readonly int $column,
    ) {
    }

    public function describe(): string
    {
        return match ($this->type) {
            TokenType::Identifier => "identifier '{$this->value}'",
            TokenType::Integer => "integer {$this->value}",
            TokenType::Boolean => $this->value ? 'TRUE' : 'FALSE',
            TokenType::String => "string '{$this->value}'",
            default => $this->type->describe(),
        };
    }
}
