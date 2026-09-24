<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Scl;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use VirtualPLC\Scl\Lexer;
use VirtualPLC\Scl\SyntaxError;
use VirtualPLC\Scl\Token;
use VirtualPLC\Scl\TokenType;

final class LexerTest extends TestCase
{
    /** @return list<TokenType> */
    private static function types(string $source): array
    {
        return array_map(static fn (Token $t) => $t->type, (new Lexer($source))->tokenize());
    }

    public function testKeywordsAreCaseInsensitive(): void
    {
        self::assertSame(
            [TokenType::If, TokenType::Identifier, TokenType::Then, TokenType::EndIf, TokenType::Eof],
            self::types('if Foo Then end_if'),
        );
    }

    public function testIdentifiersKeepTheirCase(): void
    {
        $tokens = (new Lexer('MyVar'))->tokenize();
        self::assertSame('MyVar', $tokens[0]->value);
    }

    public function testOperators(): void
    {
        self::assertSame(
            [TokenType::Assign, TokenType::Neq, TokenType::Lte, TokenType::Gte, TokenType::Lt, TokenType::Gt,
             TokenType::Eq, TokenType::Range, TokenType::Plus, TokenType::Minus, TokenType::Star, TokenType::Slash, TokenType::Eof],
            self::types(':= <> <= >= < > = .. + - * /'),
        );
    }

    public function testCommentsAreSkipped(): void
    {
        self::assertSame(
            [TokenType::Identifier, TokenType::Identifier, TokenType::Identifier, TokenType::Eof],
            self::types("a // line comment\n(* block\ncomment *) b /* c-style */ c"),
        );
    }

    #[DataProvider('integers')]
    public function testIntegerLiterals(string $source, int $expected): void
    {
        self::assertSame($expected, (new Lexer($source))->tokenize()[0]->value);
    }

    /** @return iterable<array{string, int}> */
    public static function integers(): iterable
    {
        yield 'decimal' => ['42', 42];
        yield 'underscore' => ['1_000', 1000];
        yield 'hex' => ['16#FF', 255];
        yield 'octal' => ['8#17', 15];
        yield 'binary' => ['2#1010', 10];
    }

    public function testBooleanLiterals(): void
    {
        $tokens = (new Lexer('TRUE false'))->tokenize();
        self::assertSame(TokenType::Boolean, $tokens[0]->type);
        self::assertTrue($tokens[0]->value);
        self::assertFalse($tokens[1]->value);
    }

    public function testStringEscapes(): void
    {
        self::assertSame("it's \$ ok\n", (new Lexer("'it\$'s \$\$ ok\$N'"))->tokenize()[0]->value);
    }

    public function testPositionsAreTracked(): void
    {
        $tokens = (new Lexer("a\n  b"))->tokenize();
        self::assertSame([1, 1], [$tokens[0]->line, $tokens[0]->column]);
        self::assertSame([2, 3], [$tokens[1]->line, $tokens[1]->column]);
    }

    #[DataProvider('invalidSources')]
    public function testInvalidInputIsRejected(string $source, string $message): void
    {
        $this->expectException(SyntaxError::class);
        $this->expectExceptionMessage($message);
        (new Lexer($source))->tokenize();
    }

    /** @return iterable<array{string, string}> */
    public static function invalidSources(): iterable
    {
        yield 'unknown char' => ['a ? b', "Unexpected character '?'"];
        yield 'unterminated string' => ["'abc", 'Unterminated string'];
        yield 'unterminated comment' => ['(* abc', 'Unterminated comment'];
        yield 'bad base' => ['3#12', 'Unsupported numeric base'];
        yield 'bad digit' => ['2#102', 'Invalid base-2 literal'];
    }
}
