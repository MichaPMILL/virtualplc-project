<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Scl;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use VirtualPLC\Scl\Ast\AssignStmt;
use VirtualPLC\Scl\Ast\BinaryOp;
use VirtualPLC\Scl\Ast\CaseStmt;
use VirtualPLC\Scl\Ast\IfStmt;
use VirtualPLC\Scl\Ast\IoBinding;
use VirtualPLC\Scl\Parser;
use VirtualPLC\Scl\SyntaxError;
use VirtualPLC\Scl\TokenType;

final class ParserTest extends TestCase
{
    public function testParsesAllSections(): void
    {
        $program = Parser::parseSource(<<<'SCL'
            HARDWARE
                Io := CONNECT('10.0.0.1', 502, 1);
            END_HARDWARE
            VAR
                A : BOOL;
                N : INT := 5;
                Lamp : Io.OUTPUT.3;
            END_VAR
            DB
                A := TRUE;
            END_DB
            BLOCK Logic
                Lamp := A;
            END_BLOCK
            FC
                Logic();
            END_FC
            SCL);

        self::assertCount(1, $program->hardware ?? []);
        self::assertCount(3, $program->vars);
        self::assertSame('INT', $program->vars[1]->type->name);
        self::assertNotNull($program->vars[1]->initial);
        self::assertEquals(new IoBinding('Io', IoBinding::OUTPUT, 3), $program->vars[2]->binding);
        self::assertArrayHasKey('LOGIC', $program->pous);
        self::assertArrayHasKey('MAIN', $program->pous);
        self::assertCount(1, $program->mainOb()->body ?? []);
    }

    public function testOperatorPrecedence(): void
    {
        $program = Parser::parseSource('FC x := a OR b AND c = 1 + 2 * 3; END_FC');
        $assign = ($program->mainOb()?->body ?? [])[0];
        self::assertInstanceOf(AssignStmt::class, $assign);

        $or = $assign->value;
        self::assertInstanceOf(BinaryOp::class, $or);
        self::assertSame(TokenType::Or, $or->op);
        $and = $or->right;
        self::assertInstanceOf(BinaryOp::class, $and);
        self::assertSame(TokenType::And, $and->op);
        $eq = $and->right;
        self::assertInstanceOf(BinaryOp::class, $eq);
        self::assertSame(TokenType::Eq, $eq->op);
        $plus = $eq->right;
        self::assertInstanceOf(BinaryOp::class, $plus);
        self::assertSame(TokenType::Plus, $plus->op);
        self::assertInstanceOf(BinaryOp::class, $plus->right);
        self::assertSame(TokenType::Star, $plus->right->op);
    }

    public function testElseIfOnOneLineIsAnElsifAlias(): void
    {
        $program = Parser::parseSource("FC\nIF a THEN x := 1;\nELSE IF b THEN x := 2;\nELSIF c THEN x := 3;\nELSE x := 4;\nEND_IF;\nEND_FC");
        $if = ($program->mainOb()?->body ?? [])[0];
        self::assertInstanceOf(IfStmt::class, $if);
        self::assertCount(3, $if->branches);
        self::assertNotNull($if->else);
    }

    public function testIfOnTheLineAfterElseIsNested(): void
    {
        $program = Parser::parseSource("FC\nIF a THEN x := 1;\nELSE\n  IF b THEN x := 2; END_IF;\nEND_IF;\nEND_FC");
        $if = ($program->mainOb()?->body ?? [])[0];
        self::assertInstanceOf(IfStmt::class, $if);
        self::assertCount(1, $if->branches);
        self::assertInstanceOf(IfStmt::class, ($if->else ?? [])[0]);
    }

    public function testCaseStatement(): void
    {
        $program = Parser::parseSource("FC\nCASE n OF\n 1, 2: x := 1;\n 3..5: x := 2; y := 3;\n -1: x := 0;\nELSE x := 9;\nEND_CASE;\nEND_FC");
        $case = ($program->mainOb()?->body ?? [])[0];
        self::assertInstanceOf(CaseStmt::class, $case);
        self::assertCount(3, $case->branches);
        self::assertSame([[1, 1], [2, 2]], $case->branches[0]->ranges);
        self::assertSame([[3, 5]], $case->branches[1]->ranges);
        self::assertCount(2, $case->branches[1]->body);
        self::assertSame([[-1, -1]], $case->branches[2]->ranges);
        self::assertNotNull($case->else);
    }

    public function testSemicolonAfterEndKeywordsIsOptional(): void
    {
        $program = Parser::parseSource('FC WHILE a DO x := 1; END_WHILE FOR i := 1 TO 3 BY 1 DO x := i; END_FOR REPEAT x := 1; UNTIL a END_REPEAT END_FC');
        self::assertCount(3, $program->mainOb()?->body ?? []);
    }

    #[DataProvider('syntaxErrors')]
    public function testSyntaxErrorsReportPositions(string $source, string $message): void
    {
        try {
            Parser::parseSource($source);
            self::fail('SyntaxError expected');
        } catch (SyntaxError $e) {
            self::assertStringContainsString($message, $e->getMessage());
            self::assertNotNull($e->sourceLine);
        }
    }

    /** @return iterable<array{string, string}> */
    public static function syntaxErrors(): iterable
    {
        yield 'missing semicolon' => ["FC\nx := 1\ny := 2;\nEND_FC", "Line 3, column 1: Expected ';', found identifier 'y'"];
        yield 'missing END_IF' => ["FC\nIF a THEN x := 1;\nEND_FC", 'Expected'];
        yield 'garbage statement' => ['FC 42; END_FC', 'Expected a statement'];
        yield 'bad io kind' => ['VAR a : Dev.INOUT.1; END_VAR', 'I/O type must be INPUT or OUTPUT'];
        yield 'duplicate block' => ['BLOCK a END_BLOCK BLOCK A END_BLOCK', "Duplicate block 'A'"];
        yield 'duplicate section' => ['FC END_FC FC END_FC', 'Duplicate FC section'];
        yield 'bare identifier' => ['FC foo; END_FC', "Expected ':=' or '('"];
        yield 'top-level garbage' => ['x := 1;', 'Expected a block'];
    }
}
