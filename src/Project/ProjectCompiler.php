<?php

declare(strict_types=1);

namespace VirtualPLC\Project;

use VirtualPLC\Runtime\Runtime;
use VirtualPLC\Scl\Analyzer;
use VirtualPLC\Scl\Interpreter;
use VirtualPLC\Scl\Parser;
use VirtualPLC\Scl\SclException;
use VirtualPLC\Scl\TokenType;

/**
 * Validates a project edited in the web IDE (JSON) and compiles it to SCL.
 *
 * Every user-supplied value that ends up in generated code is validated
 * (identifiers, IP addresses, numbers) so the generator cannot be used to
 * inject arbitrary code, and compile errors are reported against the block
 * the user actually edited instead of the generated file.
 */
final class ProjectCompiler
{
    private const IDENTIFIER = '/^[A-Za-z_][A-Za-z0-9_]{0,63}$/';
    private const HOSTNAME = '/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/';

    /**
     * Normalises and validates a project.
     *
     * @return array{hardware: list<array{name: string, ip: string, port: int, slave: int}>, vars: list<array{name: string, mode: string, type: string, device: string, io: string, addr: int}>, db: list<array{name: string, val: string}>, blocks: list<array{name: string, code: string}>, fc: string}
     * @throws ProjectException
     */
    public function normalize(mixed $project): array
    {
        if (!is_array($project)) {
            throw new ProjectException(['Project must be a JSON object']);
        }

        $errors = [];
        $names = []; // upper-case identifier => what declared it

        $claim = static function (string $name, string $what) use (&$names, &$errors): void {
            $key = strtoupper($name);
            if (isset($names[$key])) {
                $errors[] = "{$what} '{$name}': name already used by {$names[$key]}";
                return;
            }
            $names[$key] = "{$what} '{$name}'";
        };
        $identifier = static function (mixed $value, string $what) use (&$errors): ?string {
            if (!is_string($value) || preg_match(self::IDENTIFIER, $value) !== 1) {
                $errors[] = sprintf('%s: invalid name %s (letters, digits and _, not starting with a digit, max 64)', $what, json_encode($value));
                return null;
            }
            if (TokenType::keyword(strtoupper($value)) !== null) {
                $errors[] = "{$what}: '{$value}' is a reserved keyword";
                return null;
            }

            return $value;
        };
        $integer = static function (mixed $value, int $min, int $max, string $what) use (&$errors): int {
            if (is_string($value) && preg_match('/^\s*-?\d+\s*$/', $value) === 1) {
                $value = (int) $value;
            }
            if (!is_int($value) || $value < $min || $value > $max) {
                $errors[] = sprintf('%s must be an integer between %d and %d, got %s', $what, $min, $max, json_encode($value));
                return $min;
            }

            return $value;
        };

        // --- Hardware
        $hardware = [];
        foreach ($this->listOf($project, 'hardware', $errors) as $i => $h) {
            $label = 'Hardware #' . ($i + 1);
            $name = $identifier($h['name'] ?? null, $label);
            $ip = is_string($h['ip'] ?? null) ? trim($h['ip']) : '';
            if (filter_var($ip, FILTER_VALIDATE_IP) === false && preg_match(self::HOSTNAME, $ip) !== 1) {
                $errors[] = "{$label}: invalid IP address or hostname " . json_encode($h['ip'] ?? null);
            }
            $port = $integer($h['port'] ?? 502, 1, 65535, "{$label} port");
            $slave = $integer($h['slave'] ?? 1, 0, 255, "{$label} slave id");
            if ($name !== null) {
                $claim($name, 'device');
                $hardware[] = ['name' => $name, 'ip' => $ip, 'port' => $port, 'slave' => $slave];
            }
        }
        $devices = array_map(static fn (array $h) => strtoupper($h['name']), $hardware);

        // --- Variables
        $vars = [];
        $types = [];
        foreach ($this->listOf($project, 'vars', $errors) as $i => $v) {
            $label = 'Tag #' . ($i + 1);
            $name = $identifier($v['name'] ?? null, $label);
            $label = $name === null ? $label : "Tag '{$name}'";
            $mode = ($v['mode'] ?? 'simple') === 'binding' ? 'binding' : 'simple';
            $type = strtoupper((string) ($v['type'] ?? 'BOOL'));
            $io = strtoupper((string) ($v['io'] ?? 'OUTPUT'));
            $device = is_string($v['device'] ?? null) ? $v['device'] : '';
            $addr = 0;

            if ($mode === 'binding') {
                $type = 'BOOL';
                if (!in_array(strtoupper($device), $devices, true)) {
                    $errors[] = "{$label}: unknown device " . json_encode($device);
                }
                if ($io !== 'INPUT' && $io !== 'OUTPUT') {
                    $errors[] = "{$label}: I/O must be INPUT or OUTPUT";
                }
                $addr = $integer($v['addr'] ?? 0, 0, 65535, "{$label} address");
            } elseif ($type !== 'BOOL' && $type !== 'INT') {
                $errors[] = "{$label}: type must be BOOL or INT";
            }

            if ($name !== null) {
                $claim($name, 'tag');
                $types[strtoupper($name)] = [$type, $mode === 'binding' ? $io : null];
                $vars[] = ['name' => $name, 'mode' => $mode, 'type' => $type, 'device' => $device, 'io' => $io, 'addr' => $addr];
            }
        }

        // --- Initial values
        $db = [];
        foreach ($this->listOf($project, 'db', $errors) as $i => $d) {
            $label = 'Data block entry #' . ($i + 1);
            $name = $identifier($d['name'] ?? null, $label);
            if ($name === null) {
                continue;
            }
            $raw = $d['val'] ?? '';
            $val = strtoupper(trim(is_bool($raw) ? ($raw ? 'TRUE' : 'FALSE') : (string) $raw));
            [$type, $io] = $types[strtoupper($name)] ?? [null, null];
            if ($type === null) {
                $errors[] = "Data block: '{$name}' is not a declared tag";
            } elseif ($io === 'INPUT') {
                $errors[] = "Data block: '{$name}' is an input and cannot be initialised";
            } elseif ($type === 'BOOL' && $val !== 'TRUE' && $val !== 'FALSE') {
                $errors[] = "Data block: '{$name}' is BOOL, value must be TRUE or FALSE";
            } elseif ($type === 'INT' && (preg_match('/^-?\d+$/', $val) !== 1 || (int) $val < -32768 || (int) $val > 32767)) {
                $errors[] = "Data block: '{$name}' is INT, value must be an integer between -32768 and 32767";
            }
            $db[] = ['name' => $name, 'val' => $val];
        }

        // --- Blocks
        $blocks = [];
        $builtins = array_map('strtoupper', [...Runtime::FUNCTIONS, ...(new Interpreter())->functionNames()]);
        foreach ($this->listOf($project, 'blocks', $errors) as $i => $b) {
            $name = $identifier($b['name'] ?? null, 'Block #' . ($i + 1));
            if ($name === null) {
                continue;
            }
            if (in_array(strtoupper($name), $builtins, true)) {
                $errors[] = "Block '{$name}': name is reserved for a built-in function";
            }
            $code = $b['code'] ?? '';
            if (!is_string($code)) {
                $errors[] = "Block '{$name}': code must be a string";
                $code = '';
            }
            $claim($name, 'block');
            $blocks[] = ['name' => $name, 'code' => $code];
        }

        $fc = $project['fc'] ?? '';
        if (!is_string($fc)) {
            $errors[] = 'Main program (FC) must be a string';
            $fc = '';
        }

        if ($errors !== []) {
            throw new ProjectException($errors);
        }

        return ['hardware' => $hardware, 'vars' => $vars, 'db' => $db, 'blocks' => $blocks, 'fc' => $fc];
    }

    /**
     * Validates, generates and checks the SCL program (syntax + semantics).
     *
     * @throws ProjectException
     */
    public function compile(mixed $project): CompiledProject
    {
        $project = $this->normalize($project);
        $compiled = $this->generate($project);

        try {
            $program = Parser::parseSource($compiled->source);
            $functions = [...Runtime::FUNCTIONS, ...(new Interpreter())->functionNames()];
            (new Analyzer($functions))->analyze($program);
        } catch (SclException $e) {
            throw new ProjectException([$compiled->describeError($e)]);
        }

        return $compiled;
    }

    /**
     * @param array{hardware: list<array{name: string, ip: string, port: int, slave: int}>, vars: list<array{name: string, mode: string, type: string, device: string, io: string, addr: int}>, db: list<array{name: string, val: string}>, blocks: list<array{name: string, code: string}>, fc: string} $project
     */
    private function generate(array $project): CompiledProject
    {
        $lines = [];
        $segments = [];
        $emit = static function (string $text) use (&$lines): void {
            foreach (explode("\n", str_replace("\r\n", "\n", $text)) as $line) {
                $lines[] = $line;
            }
        };
        $userCode = static function (string $label, string $code) use (&$lines, &$segments, $emit): void {
            $start = count($lines) + 1;
            $emit(rtrim($code));
            $segments[] = ['label' => $label, 'start' => $start, 'end' => count($lines)];
        };

        $emit('// Generated by VirtualPLC on ' . gmdate('Y-m-d\TH:i:s\Z') . ' - do not edit, changes are overwritten on deploy.');
        $emit('');

        $emit('HARDWARE');
        foreach ($project['hardware'] as $h) {
            $emit(sprintf("    %s := CONNECT('%s', %d, %d);", $h['name'], $h['ip'], $h['port'], $h['slave']));
        }
        $emit('END_HARDWARE');
        $emit('');

        $emit('VAR');
        foreach ($project['vars'] as $v) {
            $emit($v['mode'] === 'binding'
                ? sprintf('    %s : %s.%s.%d;', $v['name'], $v['device'], $v['io'], $v['addr'])
                : sprintf('    %s : %s;', $v['name'], $v['type']));
        }
        $emit('END_VAR');
        $emit('');

        $emit('DB');
        foreach ($project['db'] as $d) {
            $emit(sprintf('    %s := %s;', $d['name'], $d['val']));
        }
        $emit('END_DB');
        $emit('');

        foreach ($project['blocks'] as $b) {
            $emit('BLOCK ' . $b['name']);
            $userCode("block '{$b['name']}'", $b['code']);
            $emit('END_BLOCK');
            $emit('');
        }

        $emit('FC');
        $userCode('main program (FC)', $project['fc']);
        $emit('END_FC');

        return new CompiledProject(implode("\n", $lines) . "\n", $segments);
    }

    /**
     * @param array<string, mixed> $project
     * @param list<string>         $errors
     * @return list<array<string, mixed>>
     */
    private function listOf(array $project, string $key, array &$errors): array
    {
        $value = $project[$key] ?? [];
        if (!is_array($value) || !array_is_list($value)) {
            $errors[] = "'{$key}' must be a list";
            return [];
        }
        $items = [];
        foreach ($value as $i => $item) {
            if (!is_array($item)) {
                $errors[] = "'{$key}' entry #" . ($i + 1) . ' must be an object';
                continue;
            }
            $items[] = $item;
        }

        return $items;
    }
}
