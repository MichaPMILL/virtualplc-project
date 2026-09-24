<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

/**
 * Converts SCL source text into a stream of tokens.
 *
 * Supported lexical elements:
 *  - comments: `// line`, `(* block *)`, `/* block *\/`
 *  - integers: `42`, `1_000`, `16#FF`, `8#17`, `2#1010`
 *  - strings:  `'text'` with IEC escapes `$'`, `$$`, `$N`, `$L`, `$R`, `$T`
 *  - identifiers and case-insensitive keywords
 */
final class Lexer
{
    private int $pos = 0;
    private int $line = 1;
    private int $col = 1;
    private readonly int $len;

    private const TWO_CHAR = [
        ':=' => TokenType::Assign,
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
        '+' => TokenType::Plus,
        '-' => TokenType::Minus,
        '*' => TokenType::Star,
        '/' => TokenType::Slash,
        '=' => TokenType::Eq,
    ];

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
        $nextChar = $this->peek(1);

        if (ctype_digit($char)) {
            return new Token(TokenType::Integer, $this->readNumber(), $line, $col);
        }
        if ($char === "'") {
            return new Token(TokenType::String, $this->readString(), $line, $col);
        }
        if (ctype_alpha($char) || $char === '_') {
            return $this->readWord($line, $col);
        }

        $two = $char . $nextChar;
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
                $this->skipBlockComment('*)');
            } elseif ($char === '/' && $next === '*') {
                $this->skipBlockComment('*/');
            } else {
                return;
            }
        }
    }

    private function skipBlockComment(string $terminator): void
    {
        $line = $this->line;
        $col = $this->col;
        $end = strpos($this->input, $terminator, $this->pos + 2);
        if ($end === false) {
            throw new SyntaxError('Unterminated comment', $line, $col);
        }
        $this->advance($end + 2 - $this->pos);
    }

    private function readNumber(): int
    {
        $line = $this->line;
        $col = $this->col;
        $digits = $this->consumeWhile(static fn (string $c): bool => ctype_digit($c) || $c === '_');

        // Based literal: 16#FF, 8#17, 2#1010
        if ($this->peek(0) === '#') {
            $base = (int) str_replace('_', '', $digits);
            if (!in_array($base, [2, 8, 16], true)) {
                throw new SyntaxError("Unsupported numeric base {$base}", $line, $col);
            }
            $this->advance(1);
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

        return (int) str_replace('_', '', $digits);
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

    private function readWord(int $line, int $col): Token
    {
        $word = $this->consumeWhile(static fn (string $c): bool => ctype_alnum($c) || $c === '_');
        $upper = strtoupper($word);

        if ($upper === 'TRUE' || $upper === 'FALSE') {
            return new Token(TokenType::Boolean, $upper === 'TRUE', $line, $col);
        }

        $keyword = TokenType::keyword($upper);

        return $keyword !== null
            ? new Token($keyword, $upper, $line, $col)
            : new Token(TokenType::Identifier, $word, $line, $col);
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
