<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

final class Token
{
    public function __construct(
        public readonly TokenType $type,
        public readonly int|float|bool|string|null $value,
        public readonly int $line,
        public readonly int $column,
        /** For identifiers: 'global' for "quoted" names, 'local' for #names, null otherwise. */
        public readonly ?string $scope = null,
    ) {
    }

    public function describe(): string
    {
        return match ($this->type) {
            TokenType::Identifier => "identifier '" . ($this->scope === 'global' ? "\"{$this->value}\"" : ($this->scope === 'local' ? "#{$this->value}" : $this->value)) . "'",
            TokenType::Integer, TokenType::Real => "number {$this->value}",
            TokenType::Time => "time literal",
            TokenType::Address => "address %{$this->value}",
            TokenType::Boolean => $this->value ? 'TRUE' : 'FALSE',
            TokenType::String => "string '{$this->value}'",
            default => $this->type->describe(),
        };
    }
}
