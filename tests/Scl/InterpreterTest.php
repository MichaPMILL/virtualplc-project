<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Scl;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use VirtualPLC\Scl\Interpreter;
use VirtualPLC\Scl\IoHandler;
use VirtualPLC\Scl\Parser;
use VirtualPLC\Scl\RuntimeError;
use VirtualPLC\Scl\SemanticError;

final class InterpreterTest extends TestCase
{
    /** @return array<string, mixed> */
    private function execute(string $vars, string $fc, ?Interpreter $interpreter = null): array
    {
        $interpreter ??= new Interpreter();
        $interpreter->run(Parser::parseSource("VAR\n{$vars}\nEND_VAR\nFC\n{$fc}\nEND_FC"));

        return $interpreter->memory();
    }

    #[DataProvider('expressions')]
    public function testExpressions(string $expression, int|bool $expected): void
    {
        $type = is_bool($expected) ? 'BOOL' : 'INT';
        self::assertSame($expected, $this->execute("r : {$type};", "r := {$expression};")['r']);
    }

    /** @return iterable<array{string, int|bool}> */
    public static function expressions(): iterable
    {
        yield 'precedence' => ['2 + 3 * 4', 14];
        yield 'parentheses' => ['(2 + 3) * 4', 20];
        yield 'integer division truncates' => ['7 / 2', 3];
        yield 'negative division truncates toward zero' => ['-7 / 2', -3];
        yield 'mod' => ['7 MOD 3', 1];
        yield 'unary minus' => ['-(3 - 5)', 2];
        yield 'INT overflow wraps' => ['32767 + 1', -32768];
        yield 'hex literal' => ['16#7F', 127];
        yield 'comparison' => ['3 >= 3 AND 2 <= 1 = FALSE', true];
        yield 'not' => ['NOT (1 > 2)', true];
        yield 'xor' => ['TRUE XOR TRUE', false];
        yield 'bitwise and on INT' => ['12 AND 10', 8];
        yield 'bool equals int' => ['TRUE = 1', true];
        yield 'abs' => ['ABS(-5)', 5];
        yield 'min / max' => ['MIN(4, 2, 8) + MAX(1, 9)', 11];
        yield 'limit' => ['LIMIT(0, 150, 100)', 100];
    }

    public function testVariablesAreTypedAndInitialised(): void
    {
        $memory = $this->execute('b : BOOL; i : INT; j : INT := -3;', 'b := 5; i := TRUE;');
        self::assertTrue($memory['b']);
        self::assertSame(1, $memory['i']);
        self::assertSame(-3, $memory['j']);
    }

    public function testIdentifiersAreCaseInsensitive(): void
    {
        $memory = $this->execute('Counter : INT;', 'counter := 1; COUNTER := Counter + 1;');
        self::assertSame(2, $memory['Counter']);
    }

    public function testControlFlow(): void
    {
        $memory = $this->execute(
            'sum : INT; n : INT; r : INT; c : INT;',
            <<<'SCL'
            FOR i := 1 TO 10 DO sum := sum + i; END_FOR;
            FOR i := 10 TO 1 BY -3 DO c := c + 1; END_FOR;
            WHILE n < 5 DO n := n + 1; IF n = 3 THEN EXIT; END_IF; END_WHILE;
            REPEAT r := r + 2; UNTIL r >= 6 END_REPEAT;
            SCL,
        );
        self::assertSame(55, $memory['sum']);
        self::assertSame(4, $memory['c']); // 10, 7, 4, 1
        self::assertSame(3, $memory['n']);
        self::assertSame(6, $memory['r']);
    }

    #[DataProvider('caseValues')]
    public function testCase(int $selector, int $expected): void
    {
        $memory = $this->execute('n : INT; r : INT;', "n := {$selector}; CASE n OF 1, 2: r := 10; 3..5: r := 20; ELSE r := 99; END_CASE;");
        self::assertSame($expected, $memory['r']);
    }

    /** @return iterable<array{int, int}> */
    public static function caseValues(): iterable
    {
        yield [1, 10];
        yield [2, 10];
        yield [4, 20];
        yield [6, 99];
    }

    public function testIfElsifChainStopsAtFirstMatch(): void
    {
        $memory = $this->execute('r : INT;', 'IF FALSE THEN r := 1; ELSIF TRUE THEN r := 2; ELSIF TRUE THEN r := 3; ELSE r := 4; END_IF;');
        self::assertSame(2, $memory['r']);
    }

    public function testBlocksAndReturn(): void
    {
        $interpreter = new Interpreter();
        $interpreter->run(Parser::parseSource(<<<'SCL'
            VAR a : INT; b : INT; END_VAR
            BLOCK Inc
                a := a + 1;
                IF a > 1 THEN RETURN; END_IF;
                b := b + 1;
            END_BLOCK
            FC Inc(); inc(); INC(); END_FC
            SCL));
        self::assertSame(3, $interpreter->memory()['a']);
        self::assertSame(1, $interpreter->memory()['b']);
    }

    public function testNativeFunctions(): void
    {
        $interpreter = new Interpreter();
        $logged = [];
        $interpreter->registerFunction('LOG', function (string $m) use (&$logged): void {
            $logged[] = $m;
        });
        $interpreter->registerFunction('Twice', static fn (int $x): int => $x * 2);
        $this->execute('r : INT;', "LOG('hello'); r := twice(21);", $interpreter);
        self::assertSame(['hello'], $logged);
        self::assertSame(42, $interpreter->memory()['r']);
    }

    public function testIoBindingsUseTheHandler(): void
    {
        $io = new class implements IoHandler {
            /** @var array<int, bool> */
            public array $inputs = [0 => true];
            /** @var list<array{mixed, int, bool}> */
            public array $writes = [];

            public function readInput(mixed $device, int $address): ?bool
            {
                return $this->inputs[$address] ?? null;
            }

            public function writeOutput(mixed $device, int $address, bool $value): void
            {
                $this->writes[] = [$device, $address, $value];
            }
        };
        $interpreter = new Interpreter($io);
        $interpreter->registerFunction('CONNECT', static fn (): int => 7);
        $interpreter->run(Parser::parseSource(<<<'SCL'
            HARDWARE Dev := CONNECT('1.2.3.4', 502, 1); END_HARDWARE
            VAR Button : Dev.INPUT.0; Missing : Dev.INPUT.5; Lamp : Dev.OUTPUT.2; END_VAR
            FC Lamp := Button AND NOT Missing; END_FC
            SCL));

        self::assertSame([[7, 2, true]], $io->writes);
        self::assertTrue($interpreter->readTag('lamp'));
        self::assertFalse($interpreter->readTag('Missing'), 'unavailable input keeps its last value');
    }

    public function testWriteTagRejectsInputs(): void
    {
        $interpreter = new Interpreter();
        $interpreter->registerFunction('CONNECT', static fn (): int => 0);
        $interpreter->load(Parser::parseSource("HARDWARE D := CONNECT('h', 502, 1); END_HARDWARE VAR In : D.INPUT.0; X : INT; END_VAR"));
        $interpreter->writeTag('x', 40000);
        self::assertSame(40000 - 65536, $interpreter->readTag('X'));

        $this->expectException(RuntimeError::class);
        $interpreter->writeTag('In', true);
    }

    #[DataProvider('runtimeErrors')]
    public function testRuntimeErrors(string $fc, string $message): void
    {
        $interpreter = new Interpreter();
        $interpreter->setWatchdog(0.05);
        $interpreter->registerFunction('FAIL', static function (): never {
            throw new \LogicException('boom');
        });
        try {
            $this->execute('x : INT; b : BOOL;', $fc, $interpreter);
            self::fail('RuntimeError expected');
        } catch (RuntimeError $e) {
            self::assertStringContainsString($message, $e->getMessage());
        }
    }

    /** @return iterable<array{string, string}> */
    public static function runtimeErrors(): iterable
    {
        yield 'division by zero' => ["x := 0;\nx := 1 / x;", 'Line 6: Division by zero'];
        yield 'mod by zero' => ['x := 1 MOD 0;', 'Division by zero'];
        yield 'watchdog' => ['WHILE TRUE DO x := 1; END_WHILE;', 'Watchdog'];
        yield 'string in condition' => ["IF 'a' THEN x := 1; END_IF;", 'Expected a boolean condition'];
        yield 'string to bool' => ["b := 'a';", 'Cannot assign a string'];
        yield 'function failure' => ['FAIL();', 'FAIL(): boom'];
        yield 'arity' => ['x := ABS();', 'Wrong number of arguments'];
        yield 'exit outside loop' => ['EXIT;', 'EXIT/CONTINUE used outside of a loop'];
        yield 'zero step' => ['FOR i := 1 TO 2 BY 0 DO x := 1; END_FOR;', 'step cannot be 0'];
    }

    public function testInfiniteRecursionIsStopped(): void
    {
        $this->expectException(RuntimeError::class);
        $this->expectExceptionMessage('Maximum call depth');
        (new Interpreter())->run(Parser::parseSource('BLOCK Loop Loop(); END_BLOCK FC Loop(); END_FC'));
    }

    #[DataProvider('semanticErrors')]
    public function testSemanticErrorsAreDetectedBeforeRunning(string $source, string $message): void
    {
        $interpreter = new Interpreter();
        $interpreter->registerFunction('CONNECT', static fn (): int => 0);
        try {
            $interpreter->load(Parser::parseSource($source));
            self::fail('SemanticError expected');
        } catch (SemanticError $e) {
            self::assertStringContainsString($message, $e->getMessage());
        }
    }

    /** @return iterable<array{string, string}> */
    public static function semanticErrors(): iterable
    {
        yield 'undeclared read' => ["VAR a : INT; END_VAR\nFC a := b; END_FC", "Line 2: Undeclared variable 'b'"];
        yield 'undeclared write' => ['FC zz := 1; END_FC', "undeclared variable 'zz'"];
        yield 'unknown function' => ['FC Nope(); END_FC', "Unknown function or block 'Nope'"];
        yield 'write to input' => ["HARDWARE D := CONNECT('h', 1, 1); END_HARDWARE VAR i : D.INPUT.0; END_VAR FC i := TRUE; END_FC", 'Cannot assign to input'];
        yield 'unknown device' => ['VAR i : Nope.INPUT.0; END_VAR', "unknown device 'Nope'"];
        yield 'duplicate var' => ['VAR a : INT; A : BOOL; END_VAR', "Duplicate declaration of 'A'"];
        yield 'block with arguments' => ['BLOCK B END_BLOCK FC B(1); END_FC', "Too many arguments for 'B'"];
        yield 'block shadows builtin' => ['BLOCK Abs END_BLOCK', 'name of a built-in instruction'];
    }
}
