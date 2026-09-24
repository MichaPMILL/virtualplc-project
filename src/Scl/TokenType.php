<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

enum TokenType: string
{
    // Program sections
    case Hardware = 'HARDWARE';
    case EndHardware = 'END_HARDWARE';
    case Var = 'VAR';
    case EndVar = 'END_VAR';
    case Db = 'DB';
    case EndDb = 'END_DB';
    case Fc = 'FC';
    case EndFc = 'END_FC';
    case Block = 'BLOCK';
    case EndBlock = 'END_BLOCK';

    // Types
    case TypeInt = 'INT';
    case TypeBool = 'BOOL';

    // Control flow
    case If = 'IF';
    case Then = 'THEN';
    case Elsif = 'ELSIF';
    case Else = 'ELSE';
    case EndIf = 'END_IF';
    case While = 'WHILE';
    case Do = 'DO';
    case EndWhile = 'END_WHILE';
    case For = 'FOR';
    case To = 'TO';
    case By = 'BY';
    case EndFor = 'END_FOR';
    case Repeat = 'REPEAT';
    case Until = 'UNTIL';
    case EndRepeat = 'END_REPEAT';
    case Case = 'CASE';
    case Of = 'OF';
    case EndCase = 'END_CASE';
    case Exit = 'EXIT';
    case Return = 'RETURN';

    // Operators (keywords)
    case And = 'AND';
    case Or = 'OR';
    case Xor = 'XOR';
    case Not = 'NOT';
    case Mod = 'MOD';

    // Literals & identifiers
    case Integer = 'INTEGER';
    case Boolean = 'BOOLEAN';
    case String = 'STRING';
    case Identifier = 'IDENTIFIER';

    // Punctuation
    case Assign = ':=';
    case Colon = ':';
    case Semicolon = ';';
    case Comma = ',';
    case Dot = '.';
    case Range = '..';
    case LParen = '(';
    case RParen = ')';

    // Arithmetic / comparison operators
    case Plus = '+';
    case Minus = '-';
    case Star = '*';
    case Slash = '/';
    case Eq = '=';
    case Neq = '<>';
    case Lt = '<';
    case Lte = '<=';
    case Gt = '>';
    case Gte = '>=';

    case Eof = 'EOF';

    /** Keywords recognised by the lexer (case-insensitive). */
    public static function keyword(string $upper): ?self
    {
        static $map = null;
        if ($map === null) {
            $map = [];
            foreach (self::cases() as $case) {
                if (preg_match('/^[A-Z_]+$/', $case->value) === 1
                    && !in_array($case, [self::Integer, self::Boolean, self::String, self::Identifier, self::Eof], true)) {
                    $map[$case->value] = $case;
                }
            }
        }

        return $map[$upper] ?? null;
    }

    public function describe(): string
    {
        return match ($this) {
            self::Integer => 'integer literal',
            self::Boolean => 'boolean literal',
            self::String => 'string literal',
            self::Identifier => 'identifier',
            self::Eof => 'end of input',
            default => "'{$this->value}'",
        };
    }
}
