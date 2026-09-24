<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

use VirtualPLC\Scl\Ast\AssignStmt;
use VirtualPLC\Scl\Ast\BinaryOp;
use VirtualPLC\Scl\Ast\CallExpr;
use VirtualPLC\Scl\Ast\CallStmt;
use VirtualPLC\Scl\Ast\CaseStmt;
use VirtualPLC\Scl\Ast\ExitStmt;
use VirtualPLC\Scl\Ast\Expr;
use VirtualPLC\Scl\Ast\ForStmt;
use VirtualPLC\Scl\Ast\IfStmt;
use VirtualPLC\Scl\Ast\IoBinding;
use VirtualPLC\Scl\Ast\Literal;
use VirtualPLC\Scl\Ast\Program;
use VirtualPLC\Scl\Ast\RepeatStmt;
use VirtualPLC\Scl\Ast\ReturnStmt;
use VirtualPLC\Scl\Ast\Stmt;
use VirtualPLC\Scl\Ast\UnaryOp;
use VirtualPLC\Scl\Ast\VarDecl;
use VirtualPLC\Scl\Ast\VariableRef;
use VirtualPLC\Scl\Ast\WhileStmt;
use VirtualPLC\Scl\Control\ExitSignal;
use VirtualPLC\Scl\Control\HostSignal;
use VirtualPLC\Scl\Control\ReturnSignal;

/**
 * Tree-walking interpreter for SCL programs.
 *
 * Lifecycle:
 *   load()  – static analysis + memory initialisation
 *   start() – runs HARDWARE then DB (once)
 *   scan()  – runs the FC once (call it cyclically, like OB1 on a real PLC)
 *
 * Typing: BOOL values are PHP bools, INT values are 16-bit signed integers
 * (wrap-around on overflow, like a real PLC). Integer division truncates.
 */
final class Interpreter implements TagStore
{
    public const MAX_CALL_DEPTH = 64;

    /** @var array<string, mixed> canonical name => value */
    private array $memory = [];

    /** @var array<string, string> upper-case name => canonical name */
    private array $names = [];

    /** @var array<string, VarDecl> canonical name => declaration */
    private array $declarations = [];

    /** @var array<string, callable> upper-case name => implementation */
    private array $functions = [];

    private ?Program $program = null;
    private int $callDepth = 0;
    private float $watchdogSeconds = 0.0;
    private int $watchdogStart = 0;

    public function __construct(private ?IoHandler $io = null)
    {
        $this->registerStandardFunctions();
    }

    public function setIoHandler(?IoHandler $io): void
    {
        $this->io = $io;
    }

    /** Registers a native function callable from SCL (names are case-insensitive). */
    public function registerFunction(string $name, callable $implementation): void
    {
        $this->functions[strtoupper($name)] = $implementation;
    }

    /** @return list<string> */
    public function functionNames(): array
    {
        return array_keys($this->functions);
    }

    /**
     * Maximum time the program may run without calling kickWatchdog()
     * (typically done by WAIT or at the end of each scan). 0 disables it.
     */
    public function setWatchdog(float $seconds): void
    {
        $this->watchdogSeconds = max(0.0, $seconds);
        $this->kickWatchdog();
    }

    public function kickWatchdog(): void
    {
        $this->watchdogStart = hrtime(true);
    }

    /** @throws SemanticError */
    public function load(Program $program): void
    {
        (new Analyzer($this->functionNames()))->analyze($program);

        $this->program = $program;
        $this->memory = [];
        $this->names = [];
        $this->declarations = [];

        foreach ($program->hardware ?? [] as $stmt) {
            if ($stmt instanceof AssignStmt) {
                $this->define($stmt->target, null);
            }
        }
        foreach ($program->vars as $var) {
            $this->define($var->name, $var->type === VarDecl::INT ? 0 : false);
            $this->declarations[$var->name] = $var;
            if ($var->initial instanceof Literal) {
                $this->memory[$var->name] = $this->coerce($var, $var->initial->value, $var->line);
            }
        }
    }

    /** Runs the HARDWARE and DB sections. */
    public function start(): void
    {
        $program = $this->requireProgram();
        $this->kickWatchdog();
        $this->executeTopLevel($program->hardware ?? []);
        $this->executeTopLevel($program->db ?? []);
    }

    /** Runs the FC once. */
    public function scan(): void
    {
        $program = $this->requireProgram();
        $this->kickWatchdog();
        $this->executeTopLevel($program->fc ?? []);
    }

    /** Convenience: load + start + one scan. */
    public function run(Program $program): void
    {
        $this->load($program);
        $this->start();
        $this->scan();
    }

    public function program(): ?Program
    {
        return $this->program;
    }

    /** @return array<string, mixed> */
    public function memory(): array
    {
        return $this->memory;
    }

    /** @return array<string, VarDecl> declared variables, in declaration order */
    public function declarations(): array
    {
        return $this->declarations;
    }

    // ------------------------------------------------------------------
    // TagStore (external access: HMI, Modbus server, operator commands)
    // ------------------------------------------------------------------

    public function hasTag(string $name): bool
    {
        return isset($this->names[strtoupper($name)]);
    }

    public function readTag(string $name): mixed
    {
        $canonical = $this->names[strtoupper($name)] ?? throw new RuntimeError("Unknown variable '{$name}'");

        return $this->memory[$canonical];
    }

    public function writeTag(string $name, mixed $value): void
    {
        $canonical = $this->names[strtoupper($name)] ?? throw new RuntimeError("Unknown variable '{$name}'");
        $decl = $this->declarations[$canonical] ?? null;
        if ($decl?->binding?->io === IoBinding::INPUT) {
            throw new RuntimeError("Cannot write input '{$canonical}'");
        }
        $this->assign($canonical, $value, 0);
    }

    // ------------------------------------------------------------------
    // Statements
    // ------------------------------------------------------------------

    /** @param list<Stmt> $body */
    private function executeTopLevel(array $body): void
    {
        try {
            $this->execute($body);
        } catch (ReturnSignal) {
            // RETURN at top level ends the section.
        } catch (ExitSignal $e) {
            throw new RuntimeError('EXIT used outside of a loop', $e->sourceLine);
        }
    }

    /** @param list<Stmt> $body */
    private function execute(array $body): void
    {
        foreach ($body as $stmt) {
            $this->executeStatement($stmt);
        }
    }

    private function executeStatement(Stmt $stmt): void
    {
        switch (true) {
            case $stmt instanceof AssignStmt:
                $this->assign($this->resolve($stmt->target), $this->evaluate($stmt->value), $stmt->line);
                return;

            case $stmt instanceof CallStmt:
                $this->call($stmt->call);
                return;

            case $stmt instanceof IfStmt:
                foreach ($stmt->branches as [$condition, $body]) {
                    if ($this->truthy($this->evaluate($condition), $condition->line)) {
                        $this->execute($body);
                        return;
                    }
                }
                if ($stmt->else !== null) {
                    $this->execute($stmt->else);
                }
                return;

            case $stmt instanceof WhileStmt:
                try {
                    while ($this->truthy($this->evaluate($stmt->condition), $stmt->line)) {
                        $this->checkWatchdog($stmt->line);
                        $this->execute($stmt->body);
                    }
                } catch (ExitSignal) {
                }
                return;

            case $stmt instanceof RepeatStmt:
                try {
                    do {
                        $this->checkWatchdog($stmt->line);
                        $this->execute($stmt->body);
                    } while (!$this->truthy($this->evaluate($stmt->until), $stmt->line));
                } catch (ExitSignal) {
                }
                return;

            case $stmt instanceof ForStmt:
                $this->executeFor($stmt);
                return;

            case $stmt instanceof CaseStmt:
                $selector = $this->toInt($this->evaluate($stmt->selector), $stmt->line);
                foreach ($stmt->branches as $branch) {
                    if ($branch->matches($selector)) {
                        $this->execute($branch->body);
                        return;
                    }
                }
                if ($stmt->else !== null) {
                    $this->execute($stmt->else);
                }
                return;

            case $stmt instanceof ExitStmt:
                throw new ExitSignal($stmt->line);

            case $stmt instanceof ReturnStmt:
                throw new ReturnSignal();
        }

        throw new RuntimeError('Unsupported statement ' . $stmt::class, $stmt->line);
    }

    private function executeFor(ForStmt $stmt): void
    {
        $name = $this->resolve($stmt->variable);
        $start = $this->toInt($this->evaluate($stmt->start), $stmt->line);
        $end = $this->toInt($this->evaluate($stmt->end), $stmt->line);
        $step = $stmt->step === null ? 1 : $this->toInt($this->evaluate($stmt->step), $stmt->line);
        if ($step === 0) {
            throw new RuntimeError('FOR loop step cannot be 0', $stmt->line);
        }

        try {
            for ($i = $start; $step > 0 ? $i <= $end : $i >= $end; $i += $step) {
                $this->checkWatchdog($stmt->line);
                $this->memory[$name] = $i;
                $this->execute($stmt->body);
                // The body may modify the counter, as allowed by IEC 61131-3.
                $i = $this->toInt($this->memory[$name], $stmt->line);
            }
        } catch (ExitSignal) {
        }
    }

    private function assign(string $name, mixed $value, int $line): void
    {
        $decl = $this->declarations[$name] ?? null;
        if ($decl === null) {
            // Implicit variables: device handles and FOR counters.
            $this->memory[$name] = $value;
            return;
        }

        $value = $this->coerce($decl, $value, $line);
        $this->memory[$name] = $value;

        if ($decl->binding?->io === IoBinding::OUTPUT && $this->io !== null) {
            $this->io->writeOutput($this->deviceHandle($decl, $line), $decl->binding->address, (bool) $value);
        }
    }

    // ------------------------------------------------------------------
    // Expressions
    // ------------------------------------------------------------------

    private function evaluate(Expr $expr): mixed
    {
        switch (true) {
            case $expr instanceof Literal:
                return $expr->value;

            case $expr instanceof VariableRef:
                return $this->readVariable($this->resolve($expr->name), $expr->line);

            case $expr instanceof BinaryOp:
                return $this->binary($expr);

            case $expr instanceof UnaryOp:
                $value = $this->evaluate($expr->operand);
                if ($expr->op === TokenType::Not) {
                    return is_bool($value) ? !$value : $this->wrapInt(~$this->toInt($value, $expr->line));
                }

                return $this->wrapInt(-$this->toInt($value, $expr->line));

            case $expr instanceof CallExpr:
                return $this->call($expr);
        }

        throw new RuntimeError('Unsupported expression ' . $expr::class, $expr->line);
    }

    private function binary(BinaryOp $expr): mixed
    {
        $line = $expr->line;
        $left = $this->evaluate($expr->left);

        // Short-circuit boolean operators (avoids needless I/O reads).
        if ($expr->op === TokenType::And && is_bool($left) && !$left) {
            return false;
        }
        if ($expr->op === TokenType::Or && is_bool($left) && $left) {
            return true;
        }

        $right = $this->evaluate($expr->right);

        switch ($expr->op) {
            case TokenType::And:
            case TokenType::Or:
            case TokenType::Xor:
                if (is_int($left) && is_int($right)) {
                    // Bitwise on integers (word logic)
                    return match ($expr->op) {
                        TokenType::And => $left & $right,
                        TokenType::Or => $left | $right,
                        default => $left ^ $right,
                    };
                }
                $l = $this->truthy($left, $line);
                $r = $this->truthy($right, $line);

                return match ($expr->op) {
                    TokenType::And => $l && $r,
                    TokenType::Or => $l || $r,
                    default => $l xor $r,
                };

            case TokenType::Eq:
                return $this->equals($left, $right);
            case TokenType::Neq:
                return !$this->equals($left, $right);
            case TokenType::Lt:
                return $this->compare($left, $right, $line) < 0;
            case TokenType::Lte:
                return $this->compare($left, $right, $line) <= 0;
            case TokenType::Gt:
                return $this->compare($left, $right, $line) > 0;
            case TokenType::Gte:
                return $this->compare($left, $right, $line) >= 0;
        }

        $l = $this->toInt($left, $line);
        $r = $this->toInt($right, $line);

        return match ($expr->op) {
            TokenType::Plus => $this->wrapInt($l + $r),
            TokenType::Minus => $this->wrapInt($l - $r),
            TokenType::Star => $this->wrapInt($l * $r),
            TokenType::Slash => $r === 0
                ? throw new RuntimeError('Division by zero', $line)
                : $this->wrapInt(intdiv($l, $r)),
            TokenType::Mod => $r === 0
                ? throw new RuntimeError('Division by zero (MOD)', $line)
                : $l % $r,
            default => throw new RuntimeError("Unsupported operator {$expr->op->value}", $line),
        };
    }

    private function equals(mixed $left, mixed $right): bool
    {
        if (is_bool($left) || is_bool($right)) {
            return (bool) $left === (bool) $right;
        }
        if (is_string($left) || is_string($right)) {
            return (string) $left === (string) $right;
        }

        return $left === $right;
    }

    private function compare(mixed $left, mixed $right, int $line): int
    {
        if (is_string($left) && is_string($right)) {
            return strcmp($left, $right);
        }

        return $this->toInt($left, $line) <=> $this->toInt($right, $line);
    }

    private function call(CallExpr $call): mixed
    {
        $key = strtoupper($call->name);

        if (isset($this->functions[$key])) {
            $args = array_map($this->evaluate(...), $call->args);
            try {
                return ($this->functions[$key])(...$args);
            } catch (SclException | HostSignal $e) {
                throw $e;
            } catch (\ArgumentCountError) {
                throw new RuntimeError("Wrong number of arguments for {$call->name}()", $call->line);
            } catch (\Throwable $e) {
                throw new RuntimeError("{$call->name}(): {$e->getMessage()}", $call->line, previous: $e);
            }
        }

        $block = $this->requireProgram()->blocks[$key] ?? null;
        if ($block === null) {
            throw new RuntimeError("Unknown function or block '{$call->name}'", $call->line);
        }
        if ($this->callDepth >= self::MAX_CALL_DEPTH) {
            throw new RuntimeError("Maximum call depth exceeded while calling '{$block->name}' (recursion?)", $call->line);
        }

        $this->checkWatchdog($call->line);
        $this->callDepth++;
        try {
            $this->execute($block->body);
        } catch (ReturnSignal) {
        } catch (ExitSignal $e) {
            throw new RuntimeError('EXIT used outside of a loop', $e->sourceLine);
        } finally {
            $this->callDepth--;
        }

        return null;
    }

    private function readVariable(string $name, int $line): mixed
    {
        $decl = $this->declarations[$name] ?? null;
        if ($decl?->binding?->io === IoBinding::INPUT && $this->io !== null) {
            $value = $this->io->readInput($this->deviceHandle($decl, $line), $decl->binding->address);
            if ($value !== null) {
                $this->memory[$name] = $value;
            }
        }

        return $this->memory[$name];
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private function define(string $name, mixed $initial): void
    {
        $this->names[strtoupper($name)] = $name;
        $this->memory[$name] = $initial;
    }

    private function resolve(string $name): string
    {
        $key = strtoupper($name);
        if (!isset($this->names[$key])) {
            // The analyzer guarantees every identifier is declared; only FOR
            // counters are implicit and get defined on first use.
            $this->define($name, 0);
        }

        return $this->names[$key];
    }

    private function deviceHandle(VarDecl $decl, int $line): mixed
    {
        $device = $this->names[strtoupper((string) $decl->binding?->device)] ?? null;
        $handle = $device === null ? null : $this->memory[$device];
        if ($handle === null) {
            throw new RuntimeError("Device '{$decl->binding?->device}' used by '{$decl->name}' is not connected", $line);
        }

        return $handle;
    }

    private function coerce(VarDecl $decl, mixed $value, int $line): bool|int
    {
        if ($decl->type === VarDecl::BOOL) {
            if (is_string($value)) {
                throw new RuntimeError("Cannot assign a string to BOOL '{$decl->name}'", $line);
            }

            return (bool) $value;
        }

        return $this->wrapInt($this->toInt($value, $line));
    }

    private function toInt(mixed $value, int $line): int
    {
        return match (true) {
            is_int($value) => $value,
            is_bool($value) => (int) $value,
            is_float($value) => (int) $value,
            is_string($value) && preg_match('/^-?\d+$/', $value) === 1 => (int) $value,
            default => throw new RuntimeError('Expected a numeric value, got ' . get_debug_type($value), $line),
        };
    }

    private function truthy(mixed $value, int $line): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value !== 0;
        }

        throw new RuntimeError('Expected a boolean condition, got ' . get_debug_type($value), $line);
    }

    /** Wraps to the INT (16-bit signed) range. */
    private function wrapInt(int $value): int
    {
        $value &= 0xFFFF;

        return $value >= 0x8000 ? $value - 0x10000 : $value;
    }

    private function checkWatchdog(int $line): void
    {
        if ($this->watchdogSeconds <= 0.0) {
            return;
        }
        if ((hrtime(true) - $this->watchdogStart) / 1e9 > $this->watchdogSeconds) {
            throw new RuntimeError(sprintf(
                'Watchdog: program ran %.1fs without yielding (missing WAIT in a loop?)',
                $this->watchdogSeconds,
            ), $line);
        }
    }

    private function requireProgram(): Program
    {
        return $this->program ?? throw new RuntimeError('No program loaded');
    }

    private function registerStandardFunctions(): void
    {
        $this->registerFunction('ABS', fn (int|bool $v): int => $this->wrapInt(abs((int) $v)));
        $this->registerFunction('MIN', static fn (int|bool ...$v): int => (int) min(array_map('intval', $v)));
        $this->registerFunction('MAX', static fn (int|bool ...$v): int => (int) max(array_map('intval', $v)));
        $this->registerFunction('LIMIT', static fn (int $min, int $in, int $max): int => max($min, min($in, $max)));
    }
}
