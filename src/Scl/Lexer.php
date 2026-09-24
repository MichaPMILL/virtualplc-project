<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

/**
 * Converts SCL source text into a stream of tokens.
 *
 * Understands both the historical VirtualPLC syntax and IEC 61131-3 SCL (external sources):
 *  - comments: `// line`, `(* block *)`, `/* block *\/`; pragmas `{ ... }` are ignored
 *  - identifiers: `Name`, `"Global name"` (global, may contain spaces), `#local` (local)
 *  - integers: `42`, `1_000`, `16#FF`, `8#17`, `2#1010`; reals: `1.5`, `2.0E-3`
 *  - typed literals: `T#1h2m3s4ms`, `TIME#500ms`, `INT#5`, `WORD#16#FF`, `BOOL#TRUE`
 *  - direct addresses: `%I0.0`, `%IX1.7`, `%QB2`, `%MW10`, `%MD20`
 *  - strings: `'text'` with IEC escapes `$'`, `$$`, `$N`, `$L`, `$R`, `$T`
 */
final class Lexer
{
    private int $pos = 0;
    private int $line = 1;
    private int $col = 1;
    private readonly int $len;

    private const TWO_CHAR = [
        ':=' => TokenType::Assign,
        '=>' => TokenType::OutputAssign,
        '+=' => TokenType::PlusAssign,
        '-=' => TokenType::MinusAssign,
        '*=' => TokenType::StarAssign,
        '/=' => TokenType::SlashAssign,
        '**' => TokenType::Power,
        '<>' => TokenType::Neq,
        '<=' => TokenType::Lte,
        '>=' => TokenType::Gte,
        '..' => TokenType::Range,
    ];

    private const ONE_CHAR = [
        ';' => TokenType::Semicolon,
        ':' => TokenType::Colon,
        '.' => TokenType::Dot,
        '<' => TokenType::Lt,
        '>' => TokenType::Gt,
        ',' => TokenType::Comma,
        '(' => TokenType::LParen,
        ')' => TokenType::RParen,
        '[' => TokenType::LBracket,
        ']' => TokenType::RBracket,
        '+' => TokenType::Plus,
        '-' => TokenType::Minus,
        '*' => TokenType::Star,
        '/' => TokenType::Slash,
        '=' => TokenType::Eq,
        '&' => TokenType::And,
    ];

    /** Types allowed as prefix of a typed literal (INT#5). */
    private const TYPED_PREFIXES = ['BOOL', 'BYTE', 'WORD', 'DWORD', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL'];

    public function __construct(private readonly string $input)
    {
        $this->len = strlen($input);
    }

    /** @return list<Token> */
    public function tokenize(): array
    {
        $tokens = [];
        do {
            $token = $this->next();
            $tokens[] = $token;
        } while ($token->type !== TokenType::Eof);

        return $tokens;
    }

    public function next(): Token
    {
        $this->skipWhitespaceAndComments();

        if ($this->pos >= $this->len) {
            return new Token(TokenType::Eof, null, $this->line, $this->col);
        }

        $line = $this->line;
        $col = $this->col;
        $char = $this->input[$this->pos];

        if (ctype_digit($char)) {
            return $this->readNumber($line, $col);
        }
        if ($char === "'") {
            return new Token(TokenType::String, $this->readString(), $line, $col);
        }
        if ($char === '"') {
            return new Token(TokenType::Identifier, $this->readQuotedIdentifier(), $line, $col, 'global');
        }
        if ($char === '#' && $this->isIdentifierStart($this->peek(1))) {
            $this->advance(1);
            $name = $this->consumeWhile(static fn (string $c): bool => ctype_alnum($c) || $c === '_');

            return new Token(TokenType::Identifier, $name, $line, $col, 'local');
        }
        if ($char === '%') {
            return new Token(TokenType::Address, $this->readAddress(), $line, $col);
        }
        if ($this->isIdentifierStart($char)) {
            return $this->readWord($line, $col);
        }

        $two = $char . $this->peek(1);
        if (isset(self::TWO_CHAR[$two])) {
            $this->advance(2);

            return new Token(self::TWO_CHAR[$two], $two, $line, $col);
        }

        if (isset(self::ONE_CHAR[$char])) {
            $this->advance(1);

            return new Token(self::ONE_CHAR[$char], $char, $line, $col);
        }

        throw new SyntaxError(sprintf("Unexpected character '%s'", $char), $line, $col);
    }

    private function isIdentifierStart(?string $char): bool
    {
        return $char !== null && (ctype_alpha($char) || $char === '_');
    }

    private function skipWhitespaceAndComments(): void
    {
        while ($this->pos < $this->len) {
            $char = $this->input[$this->pos];
            $next = $this->peek(1);

            if (ctype_space($char)) {
                $this->advance(1);
            } elseif ($char === '/' && $next === '/') {
                while ($this->pos < $this->len && $this->input[$this->pos] !== "\n") {
                    $this->advance(1);
                }
            } elseif ($char === '(' && $next === '*') {
                $this->skipUntil('*)', 2, 'Unterminated comment');
            } elseif ($char === '/' && $next === '*') {
                $this->skipUntil('*/', 2, 'Unterminated comment');
            } elseif ($char === '{') {
                // Pragma / attribute, e.g. { Attribute := 'TRUE' }
                $this->skipUntil('}', 1, 'Unterminated pragma');
            } else {
                return;
            }
        }
    }

    private function skipUntil(string $terminator, int $openLength, string $error): void
    {
        $line = $this->line;
        $col = $this->col;
        $end = strpos($this->input, $terminator, $this->pos + $openLength);
        if ($end === false) {
            throw new SyntaxError($error, $line, $col);
        }
        $this->advance($end + strlen($terminator) - $this->pos);
    }

    private function readNumber(int $line, int $col): Token
    {
        $digits = $this->consumeWhile(static fn (string $c): bool => ctype_digit($c) || $c === '_');

        // Based literal: 16#FF, 8#17, 2#1010
        if ($this->peek(0) === '#') {
            return new Token(TokenType::Integer, $this->readBased((int) str_replace('_', '', $digits), $line, $col), $line, $col);
        }

        $number = str_replace('_', '', $digits);
        $isReal = false;
        // Fraction (but not the ".." range operator)
        if ($this->peek(0) === '.' && ctype_digit((string) $this->peek(1))) {
            $this->advance(1);
            $number .= '.' . str_replace('_', '', $this->consumeWhile(static fn (string $c): bool => ctype_digit($c) || $c === '_'));
            $isReal = true;
        }
        // Exponent
        $e = $this->peek(0);
        if (($e === 'e' || $e === 'E')
            && (ctype_digit((string) $this->peek(1)) || (in_array($this->peek(1), ['+', '-'], true) && ctype_digit((string) $this->peek(2))))) {
            $number .= 'e' . $this->input[$this->pos + 1];
            $this->advance(2);
            $number .= $this->consumeWhile(static fn (string $c): bool => ctype_digit($c));
            $isReal = true;
        }

        return $isReal
            ? new Token(TokenType::Real, (float) $number, $line, $col)
            : new Token(TokenType::Integer, (int) $number, $line, $col);
    }

    private function readBased(int $base, int $line, int $col): int
    {
        if (!in_array($base, [2, 8, 16], true)) {
            throw new SyntaxError("Unsupported numeric base {$base}", $line, $col);
        }
        $this->advance(1); // '#'
        $raw = $this->consumeWhile(static fn (string $c): bool => ctype_xdigit($c) || $c === '_');
        $clean = str_replace('_', '', $raw);
        $valid = match ($base) {
            2 => '/^[01]+$/',
            8 => '/^[0-7]+$/',
            16 => '/^[0-9a-fA-F]+$/',
        };
        if (preg_match($valid, $clean) !== 1) {
            throw new SyntaxError("Invalid base-{$base} literal '{$raw}'", $line, $col);
        }

        return intval($clean, $base);
    }

    private function readString(): string
    {
        $line = $this->line;
        $col = $this->col;
        $this->advance(1); // opening quote
        $result = '';

        while ($this->pos < $this->len) {
            $char = $this->input[$this->pos];
            if ($char === "'") {
                $this->advance(1);

                return $result;
            }
            if ($char === "\n") {
                break;
            }
            if ($char === '$') {
                $escaped = $this->peek(1);
                $result .= match (strtoupper($escaped ?? '')) {
                    "'" => "'",
                    '$' => '$',
                    'N', 'L' => "\n",
                    'R' => "\r",
                    'T' => "\t",
                    default => throw new SyntaxError("Invalid escape sequence '\${$escaped}'", $this->line, $this->col),
                };
                $this->advance(2);
                continue;
            }
            $result .= $char;
            $this->advance(1);
        }

        throw new SyntaxError('Unterminated string literal', $line, $col);
    }

    private function readQuotedIdentifier(): string
    {
        $line = $this->line;
        $col = $this->col;
        $this->advance(1);
        $name = $this->consumeWhile(static fn (string $c): bool => $c !== '"' && $c !== "\n");
        if ($this->peek(0) !== '"') {
            throw new SyntaxError('Unterminated quoted identifier', $line, $col);
        }
        $this->advance(1);
        if (trim($name) === '') {
            throw new SyntaxError('Empty quoted identifier', $line, $col);
        }

        // Quoted names may contain spaces and special characters.
        return $name;
    }

    /** %I0.0, %IX0.0, %IB1, %QW2, %MD4 -> canonical "I0.0", "IB1", "QW2", "MD4" */
    private function readAddress(): string
    {
        $line = $this->line;
        $col = $this->col;
        $this->advance(1); // '%'
        $raw = strtoupper($this->consumeWhile(static fn (string $c): bool => ctype_alnum($c)));
        if ($this->peek(0) === '.' && ctype_digit((string) $this->peek(1))) {
            $this->advance(1);
            $raw .= '.' . $this->consumeWhile(static fn (string $c): bool => ctype_digit($c));
        }
        if (preg_match('/^([IQM])X?(\d+)\.([0-7])$/', $raw, $m) === 1) {
            return "{$m[1]}{$m[2]}.{$m[3]}";
        }
        if (preg_match('/^([IQM])([BWD])(\d+)$/', $raw, $m) === 1) {
            return "{$m[1]}{$m[2]}{$m[3]}";
        }

        throw new SyntaxError("Invalid address '%{$raw}' (expected e.g. %I0.0, %QW2, %MD10)", $line, $col);
    }

    private function readWord(int $line, int $col): Token
    {
        $word = $this->consumeWhile(static fn (string $c): bool => ctype_alnum($c) || $c === '_');
        $upper = strtoupper($word);

        // Typed literals: T#5s, TIME#1m, INT#5, WORD#16#FF, BOOL#TRUE
        if ($this->peek(0) === '#') {
            if ($upper === 'T' || $upper === 'TIME') {
                $this->advance(1);

                return new Token(TokenType::Time, $this->readDuration($line, $col), $line, $col);
            }
            if (in_array($upper, self::TYPED_PREFIXES, true)) {
                $this->advance(1);
                $negative = false;
                if ($this->peek(0) === '-') {
                    $negative = true;
                    $this->advance(1);
                }
                $token = $this->next();
                if ($token->type === TokenType::Integer || $token->type === TokenType::Real) {
                    $value = $negative ? -$token->value : $token->value;

                    return new Token($token->type, $value, $line, $col);
                }
                if ($token->type === TokenType::Boolean && !$negative) {
                    return new Token(TokenType::Boolean, $token->value, $line, $col);
                }
                throw new SyntaxError("Invalid {$upper}# literal", $line, $col);
            }
        }

        if ($upper === 'TRUE' || $upper === 'FALSE') {
            return new Token(TokenType::Boolean, $upper === 'TRUE', $line, $col);
        }

        $keyword = TokenType::keyword($upper);

        return $keyword !== null
            ? new Token($keyword, $upper, $line, $col)
            : new Token(TokenType::Identifier, $word, $line, $col);
    }

    /** Parses the part after T# into milliseconds: 1d2h3m4s5ms, 1.5s, -500ms. */
    private function readDuration(int $line, int $col): int
    {
        $raw = $this->consumeWhile(static fn (string $c): bool => ctype_alnum($c) || in_array($c, ['_', '.', '-'], true));
        $text = strtolower(str_replace('_', '', $raw));
        $negative = str_starts_with($text, '-');
        $text = ltrim($text, '-');

        if ($text === '' || preg_match_all('/(\d+(?:\.\d+)?)(ms|d|h|m|s)/', $text, $parts, PREG_SET_ORDER) === 0
            || implode('', array_map(static fn (array $p) => $p[0], $parts)) !== $text) {
            throw new SyntaxError("Invalid time literal 'T#{$raw}'", $line, $col);
        }

        $factor = ['d' => 86_400_000, 'h' => 3_600_000, 'm' => 60_000, 's' => 1000, 'ms' => 1];
        $ms = 0.0;
        foreach ($parts as [, $amount, $unit]) {
            $ms += (float) $amount * $factor[$unit];
        }

        return (int) round($negative ? -$ms : $ms);
    }

    /** @param callable(string): bool $predicate */
    private function consumeWhile(callable $predicate): string
    {
        $start = $this->pos;
        while ($this->pos < $this->len && $predicate($this->input[$this->pos])) {
            $this->advance(1);
        }

        return substr($this->input, $start, $this->pos - $start);
    }

    private function peek(int $offset): ?string
    {
        $index = $this->pos + $offset;

        return $index < $this->len ? $this->input[$index] : null;
    }

    private function advance(int $count): void
    {
        for ($i = 0; $i < $count && $this->pos < $this->len; $i++) {
            if ($this->input[$this->pos] === "\n") {
                $this->line++;
                $this->col = 1;
            } else {
                $this->col++;
            }
            $this->pos++;
        }
    }
}
