<?php

declare(strict_types=1);

namespace VirtualPLC\Tests\Project;

use PHPUnit\Framework\TestCase;
use VirtualPLC\Project\ProjectCompiler;
use VirtualPLC\Project\ProjectException;
use VirtualPLC\Scl\Parser;

final class ProjectCompilerTest extends TestCase
{
    /** @return array<string, mixed> */
    private static function project(): array
    {
        return [
            'hardware' => [['name' => 'Io', 'ip' => '10.0.0.5', 'port' => '502', 'slave' => 1]],
            'vars' => [
                ['name' => 'Run', 'mode' => 'simple', 'type' => 'BOOL', 'device' => '', 'io' => 'OUTPUT', 'addr' => 0],
                ['name' => 'Count', 'mode' => 'simple', 'type' => 'INT', 'device' => '', 'io' => 'OUTPUT', 'addr' => 0],
                ['name' => 'Button', 'mode' => 'binding', 'type' => 'BOOL', 'device' => 'Io', 'io' => 'INPUT', 'addr' => '1'],
                ['name' => 'Lamp', 'mode' => 'binding', 'type' => 'BOOL', 'device' => 'Io', 'io' => 'OUTPUT', 'addr' => 2],
            ],
            'db' => [['name' => 'Run', 'val' => 'true'], ['name' => 'Count', 'val' => '-5']],
            'blocks' => [['name' => 'Logic', 'code' => "IF Run AND Button THEN\n    Lamp := TRUE;\nEND_IF;"]],
            'fc' => "Logic();\nWAIT(100);",
        ];
    }

    public function testCompilesTheExampleProject(): void
    {
        $json = (string) file_get_contents(dirname(__DIR__, 2) . '/examples/project.json');
        $compiled = (new ProjectCompiler())->compile(json_decode($json, true));
        $program = Parser::parseSource($compiled->source);
        self::assertCount(11, $program->vars);
        self::assertCount(5, $program->blocks);
    }

    public function testGeneratesTheExpectedSource(): void
    {
        $source = (new ProjectCompiler())->compile(self::project())->source;
        self::assertStringContainsString("Io := CONNECT('10.0.0.5', 502, 1);", $source);
        self::assertStringContainsString('Button : Io.INPUT.1;', $source);
        self::assertStringContainsString('Count : INT;', $source);
        self::assertStringContainsString('Run := TRUE;', $source);
        self::assertStringContainsString('Count := -5;', $source);
        self::assertStringContainsString("BLOCK Logic\nIF Run AND Button THEN", $source);
    }

    /**
     * @param callable(array<string, mixed>): array<string, mixed> $mutate
     */
    private function assertInvalid(callable $mutate, string $expected): void
    {
        try {
            (new ProjectCompiler())->compile($mutate(self::project()));
            self::fail('ProjectException expected');
        } catch (ProjectException $e) {
            self::assertStringContainsString($expected, implode("\n", $e->errors));
        }
    }

    public function testRejectsCodeInjectionThroughConfigurationFields(): void
    {
        $this->assertInvalid(static function (array $p): array {
            $p['hardware'][0]['ip'] = "1.2.3.4', 502, 1); END_HARDWARE FC LOG('pwned";
            return $p;
        }, 'invalid IP address');
        $this->assertInvalid(static function (array $p): array {
            $p['vars'][0]['name'] = 'Run; X';
            return $p;
        }, 'invalid name');
        $this->assertInvalid(static function (array $p): array {
            $p['db'][0]['val'] = 'TRUE; Lamp := TRUE';
            return $p;
        }, 'value must be TRUE or FALSE');
    }

    public function testValidationErrors(): void
    {
        $this->assertInvalid(static fn (array $p) => ['vars' => [['name' => 'IF']]] + $p, 'reserved keyword');
        $this->assertInvalid(static function (array $p): array {
            $p['vars'][] = ['name' => 'run', 'mode' => 'simple', 'type' => 'BOOL'];
            return $p;
        }, "name already used by tag 'Run'");
        $this->assertInvalid(static function (array $p): array {
            $p['vars'][2]['device'] = 'Nope';
            return $p;
        }, 'unknown device');
        $this->assertInvalid(static function (array $p): array {
            $p['hardware'][0]['port'] = 0;
            return $p;
        }, 'port must be an integer between 1 and 65535');
        $this->assertInvalid(static function (array $p): array {
            $p['db'][] = ['name' => 'Button', 'val' => 'TRUE'];
            return $p;
        }, 'is an input');
        $this->assertInvalid(static function (array $p): array {
            $p['db'][1]['val'] = '40000';
            return $p;
        }, 'between -32768 and 32767');
        $this->assertInvalid(static function (array $p): array {
            $p['blocks'][] = ['name' => 'Wait', 'code' => ''];
            return $p;
        }, 'reserved for a built-in');
        $this->assertInvalid(static fn (array $p) => ['vars' => 'x'] + $p, "'vars' must be a list");
    }

    public function testCompileErrorsPointToTheUserBlock(): void
    {
        $this->assertInvalid(static function (array $p): array {
            $p['blocks'][0]['code'] = "Lamp := TRUE;\nLamp := Nope;";
            return $p;
        }, "Block 'Logic', line 2: Undeclared variable 'Nope'");
        $this->assertInvalid(static function (array $p): array {
            $p['fc'] = 'IF Run THEN';
            return $p;
        }, 'Main program (FC): unexpected end of code');
        $this->assertInvalid(static function (array $p): array {
            $p['fc'] = "Logic();\nButton := TRUE;";
            return $p;
        }, 'Main program (FC), line 2: Cannot assign to input');
    }
}
