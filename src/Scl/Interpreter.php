<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

use VirtualPLC\Scl\Ast\AddressRef;
use VirtualPLC\Scl\Ast\AssignStmt;
use VirtualPLC\Scl\Ast\BinaryOp;
use VirtualPLC\Scl\Ast\CallExpr;
use VirtualPLC\Scl\Ast\CallStmt;
use VirtualPLC\Scl\Ast\CaseStmt;
use VirtualPLC\Scl\Ast\ContinueStmt;
use VirtualPLC\Scl\Ast\ExitStmt;
use VirtualPLC\Scl\Ast\Expr;
use VirtualPLC\Scl\Ast\ForStmt;
use VirtualPLC\Scl\Ast\IfStmt;
use VirtualPLC\Scl\Ast\IndexAccess;
use VirtualPLC\Scl\Ast\IoBinding;
use VirtualPLC\Scl\Ast\Literal;
use VirtualPLC\Scl\Ast\MemberAccess;
use VirtualPLC\Scl\Ast\Pou;
use VirtualPLC\Scl\Ast\Program;
use VirtualPLC\Scl\Ast\RepeatStmt;
use VirtualPLC\Scl\Ast\ReturnStmt;
use VirtualPLC\Scl\Ast\Stmt;
use VirtualPLC\Scl\Ast\TypeRef;
use VirtualPLC\Scl\Ast\UnaryOp;
use VirtualPLC\Scl\Ast\VarDecl;
use VirtualPLC\Scl\Ast\VariableRef;
use VirtualPLC\Scl\Ast\WhileStmt;
use VirtualPLC\Scl\Control\ContinueSignal;
use VirtualPLC\Scl\Control\ExitSignal;
use VirtualPLC\Scl\Control\HostSignal;
use VirtualPLC\Scl\Control\ReturnSignal;
use VirtualPLC\Scl\Library\Library;
use VirtualPLC\Scl\Value\ArrayValue;
use VirtualPLC\Scl\Value\StructValue;

/**
 * Tree-walking interpreter for SCL programs.
 *
 * Lifecycle:
 *   load()  – static analysis, memory and instance initialisation
 *   start() – runs HARDWARE, start values (DB sections) and the Startup OB, once
 *   scan()  – runs the cyclic OB ("Main" / OB1) once
 *
 * Memory model:
 *   - global tags, optionally located in the process image (%I, %Q, %M)
 *   - data blocks (global DBs and instance DBs of function blocks)
 *   - FB instances keep their inputs, outputs and static variables between calls;
 *     temporary variables of FCs/OBs/FBs are re-initialised on every call.
 *
 * Integers wrap to the range of their declared type (INT 16-bit, DINT 32-bit...),
 * integer division truncates, REAL is a double-precision float.
 */
final class Interpreter implements TagStore
{
    public const MAX_CALL_DEPTH = 64;

    private StructValue $globals;

    /** @var array<string, VarDecl> canonical global tag name => declaration, in declaration order */
    private array $declarations = [];

    /** @var array<string, callable> upper-case name => implementation */
    private array $functions = [];

    /** @var array<string, list<string>> upper-case function name => upper-case parameter names */
    private array $parameterNames = [];

    /** @var list<array{temps: StructValue, instance: ?StructValue, pou: ?Pou}> call stack */
    private array $frames = [];

    private ?Program $program = null;
    private ProcessImage $image;
    private float $watchdogSeconds = 0.0;
    private int $watchdogStart = 0;
    /** @var \Closure(): int */
    private \Closure $clock;

    public function __construct(private ?IoHandler $io = null)
    {
        $this->globals = new StructValue();
        $this->image = new ProcessImage();
        $this->clock = static fn (): int => intdiv(hrtime(true), 1_000_000);
        StandardFunctions::register($this);
    }

    public function setIoHandler(?IoHandler $io): void
    {
        $this->io = $io;
    }

    /** Time source for timers, in milliseconds (monotonic). */
    public function setClock(callable $clock): void
    {
        $this->clock = \Closure::fromCallable($clock);
    }

    /** Registers a native function callable from SCL (names are case-insensitive). */
    public function registerFunction(string $name, callable $implementation): void
    {
        $key = strtoupper($name);
        $this->functions[$key] = $implementation;
        $reflection = new \ReflectionFunction(\Closure::fromCallable($implementation));
        $this->parameterNames[$key] = array_map(
            static fn (\ReflectionParameter $p): string => strtoupper($p->getName()),
            $reflection->getParameters(),
        );
    }

    /** @return list<string> */
    public function functionNames(): array
    {
        return array_keys($this->functions);
    }

    /**
     * Maximum time the program may run without calling kickWatchdog()
     * (done by WAIT and at the end of each scan). 0 disables it.
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

    public function image(): ProcessImage
    {
        return $this->image;
    }

    /** @throws SemanticError */
    public function load(Program $program): void
    {
        (new Analyzer($this->functionNames()))->analyze($program);

        $this->program = $program;
        $this->globals = new StructValue();
        $this->declarations = [];
        $this->frames = [];
        $this->image = new ProcessImage();

        foreach ($program->hardware ?? [] as $stmt) {
            if ($stmt instanceof AssignStmt && $stmt->target instanceof VariableRef) {
                $this->globals->define($stmt->target->name, TypeRef::of('DINT'), null);
            }
        }
        foreach ($program->vars as $var) {
            $value = $var->initial !== null
                ? $this->coerce($var->type, $this->evaluate($var->initial), $var->line)
                : $this->defaultValue($var->type, $var->line);
            $this->globals->define($var->name, $var->type, $var->address === null ? $value : null);
            if ($var->address !== null) {
                $this->image->write($var->address, $value, $var->type->name);
            }
            $this->declarations[$var->name] = $var;
        }
        foreach ($program->dataBlocks as $db) {
            if ($db->instanceOf !== null) {
                $instance = $this->instantiate(TypeRef::of($db->instanceOf), $db->line);
            } else {
                $instance = new StructValue();
                $this->defineAll($instance, $db->fields);
            }
            $this->globals->define($db->name, TypeRef::of($db->instanceOf ?? 'STRUCT'), $instance);
        }
    }

    /** Runs HARDWARE, the start values and the Startup OB. */
    public function start(): void
    {
        $program = $this->requireProgram();
        $this->kickWatchdog();
        $this->executeTopLevel($program->hardware ?? []);
        $this->executeTopLevel($program->db ?? []);
        foreach ($program->dataBlocks as $db) {
            if ($db->init !== []) {
                $instance = $this->globals->get($db->name);
                $this->runInFrame($this->frame(null, $instance instanceof StructValue ? $instance : null), $db->init);
            }
        }
        if (($startup = $program->startupOb()) !== null) {
            $this->runPou($startup);
        }
    }

    /** Runs the cyclic OB once. */
    public function scan(): void
    {
        $program = $this->requireProgram();
        $this->kickWatchdog();
        if (($main = $program->mainOb()) !== null) {
            $this->runPou($main);
        }
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

    /** @return array<string, mixed> global tags and data blocks as plain PHP values */
    public function memory(): array
    {
        $memory = [];
        foreach ($this->globals->values as $name => $value) {
            $decl = $this->declarations[$name] ?? null;
            if ($decl?->address !== null) {
                $value = $this->image->read($decl->address, $decl->type->name);
            }
            $memory[$name] = StructValue::exportValue($value);
        }

        return $memory;
    }

    /** @return array<string, VarDecl> global tags, in declaration order */
    public function declarations(): array
    {
        return $this->declarations;
    }

    // ------------------------------------------------------------------
    // TagStore (external access: HMI, Modbus server, watch tables)
    // Paths: Tag, "Tag", DB.Member, Instance.Member[2], %M0.0
    // ------------------------------------------------------------------

    public function hasTag(string $name): bool
    {
        try {
            $this->readTag($name);

            return true;
        } catch (SclException) {
            return false;
        }
    }

    public function readTag(string $name): mixed
    {
        return StructValue::exportValue($this->evaluate($this->pathExpr($name)));
    }

    public function writeTag(string $name, mixed $value): void
    {
        $target = $this->pathExpr($name);
        $root = $target;
        while ($root instanceof MemberAccess || $root instanceof IndexAccess) {
            $root = $root->base;
        }
        if ($root instanceof AddressRef && $root->address->area === 'I') {
            throw new RuntimeError("Cannot write input {$root->address}");
        }
        if ($root instanceof VariableRef) {
            $decl = $this->declarations[$this->globals->canonical($root->name) ?? ''] ?? null;
            if ($decl?->binding?->io === IoBinding::INPUT || $decl?->address?->area === 'I') {
                throw new RuntimeError("Cannot write input '{$root->name}'");
            }
            if ($decl?->section === VarDecl::CONSTANT) {
                throw new RuntimeError("Cannot write constant '{$root->name}'");
            }
        }
        $this->assignTo($target, $value, 0);
    }

    /** Parses an external tag path into an expression, resolved in the global scope. */
    private function pathExpr(string $path): Expr
    {
        $path = trim($path);
        if ($path === '' || strlen($path) > 256 || strpbrk($path, ";\n") !== false) {
            throw new RuntimeError('Invalid tag path');
        }
        try {
            $stmt = (Parser::parseSource("FC\n__x := {$path};\nEND_FC")->mainOb()?->body ?? [])[0] ?? null;
        } catch (SyntaxError) {
            throw new RuntimeError("Invalid tag path '{$path}'");
        }
        if (!$stmt instanceof AssignStmt || !self::isPath($stmt->value)) {
            throw new RuntimeError("Invalid tag path '{$path}'");
        }

        return $stmt->value;
    }

    private static function isPath(Expr $expr): bool
    {
        return match (true) {
            $expr instanceof VariableRef => $expr->scope !== 'local',
            $expr instanceof AddressRef => true,
            $expr instanceof MemberAccess => self::isPath($expr->base),
            $expr instanceof IndexAccess => self::isPath($expr->base) && $expr->index instanceof Literal,
            default => false,
        };
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
        } catch (ExitSignal | ContinueSignal $e) {
            throw new RuntimeError('EXIT/CONTINUE used outside of a loop', $e->sourceLine);
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
                $value = $this->evaluate($stmt->value);
                if ($stmt->operator !== null) {
                    $value = $this->arithmetic($stmt->operator, $this->evaluate($stmt->target), $value, $stmt->line);
                }
                $this->assignTo($stmt->target, $value, $stmt->line);
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
                        $this->loopBody($stmt->body);
                    }
                } catch (ExitSignal) {
                }
                return;

            case $stmt instanceof RepeatStmt:
                try {
                    do {
                        $this->checkWatchdog($stmt->line);
                        $this->loopBody($stmt->body);
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

            case $stmt instanceof ContinueStmt:
                throw new ContinueSignal($stmt->line);

            case $stmt instanceof ReturnStmt:
                throw new ReturnSignal();
        }

        throw new RuntimeError('Unsupported statement ' . $stmt::class, $stmt->line);
    }

    /** @param list<Stmt> $body */
    private function loopBody(array $body): void
    {
        try {
            $this->execute($body);
        } catch (ContinueSignal) {
        }
    }

    private function executeFor(ForStmt $stmt): void
    {
        $counter = new VariableRef($stmt->variable, $stmt->line);
        if ($this->lookup($stmt->variable, null) === null) {
            // Historical programs use undeclared counters: declare them implicitly as DINT.
            $scope = $this->frames === [] ? $this->globals : $this->currentFrame()['temps'];
            $scope->define($stmt->variable, TypeRef::of('DINT'), 0);
        }

        $start = $this->toInt($this->evaluate($stmt->start), $stmt->line);
        $end = $this->toInt($this->evaluate($stmt->end), $stmt->line);
        $step = $stmt->step === null ? 1 : $this->toInt($this->evaluate($stmt->step), $stmt->line);
        if ($step === 0) {
            throw new RuntimeError('FOR loop step cannot be 0', $stmt->line);
        }

        try {
            for ($i = $start; $step > 0 ? $i <= $end : $i >= $end; $i += $step) {
                $this->checkWatchdog($stmt->line);
                $this->assignTo($counter, $i, $stmt->line);
                $this->loopBody($stmt->body);
                // The body may modify the counter, as allowed by IEC 61131-3.
                $i = $this->toInt($this->evaluate($counter), $stmt->line);
            }
        } catch (ExitSignal) {
        }
    }

    // ------------------------------------------------------------------
    // Variables
    // ------------------------------------------------------------------

    /**
     * Resolves a name: locals (temps, then instance) first, then globals.
     *
     * @return array{0: StructValue, 1: string, 2: bool}|null struct, canonical name, is global
     */
    private function lookup(string $name, ?string $scope): ?array
    {
        if ($scope !== 'global' && $this->frames !== []) {
            $frame = $this->currentFrame();
            foreach ([$frame['temps'], $frame['instance']] as $struct) {
                $canonical = $struct?->canonical($name);
                if ($canonical !== null) {
                    return [$struct, $canonical, false];
                }
            }
        }
        if ($scope !== 'local') {
            $canonical = $this->globals->canonical($name);
            if ($canonical !== null) {
                return [$this->globals, $canonical, true];
            }
        }

        return null;
    }

    private function readVariable(VariableRef $ref): mixed
    {
        $found = $this->lookup($ref->name, $ref->scope)
            ?? throw new RuntimeError("Unknown variable '{$ref->name}'", $ref->line);
        [$struct, $name, $isGlobal] = $found;

        if ($isGlobal && ($decl = $this->declarations[$name] ?? null) !== null) {
            if ($decl->address !== null) {
                return $this->image->read($decl->address, $decl->type->name);
            }
            if ($decl->binding?->io === IoBinding::INPUT && $this->io !== null) {
                $value = $this->io->readInput($this->deviceHandle($decl, $ref->line), $decl->binding->address);
                if ($value !== null) {
                    $struct->values[$name] = $value;
                }
            }
        }

        return $struct->values[$name];
    }

    private function assignTo(Expr $target, mixed $value, int $line): void
    {
        switch (true) {
            case $target instanceof VariableRef:
                $found = $this->lookup($target->name, $target->scope)
                    ?? throw new RuntimeError("Unknown variable '{$target->name}'", $line);
                [$struct, $name, $isGlobal] = $found;
                $value = $this->coerce($struct->types[$name], $value, $line);
                $decl = $isGlobal ? ($this->declarations[$name] ?? null) : null;
                if ($decl?->address !== null) {
                    $this->image->write($decl->address, $value, $decl->type->name);
                    return;
                }
                $struct->values[$name] = $value;
                if ($decl?->binding?->io === IoBinding::OUTPUT && $this->io !== null) {
                    $this->io->writeOutput($this->deviceHandle($decl, $line), $decl->binding->address, (bool) $value);
                }
                return;

            case $target instanceof AddressRef:
                $type = $target->address->defaultType();
                $this->image->write($target->address, $this->coerce(TypeRef::of($type), $value, $line), $type);
                return;

            case $target instanceof MemberAccess:
                $struct = $this->evaluate($target->base);
                if (!$struct instanceof StructValue || ($member = $struct->canonical($target->member)) === null) {
                    throw new RuntimeError("Unknown member '{$target->member}'", $line);
                }
                $struct->values[$member] = $this->coerce($struct->types[$member], $value, $line);
                return;

            case $target instanceof IndexAccess:
                $array = $this->evaluate($target->base);
                $index = $this->arrayIndex($array, $target, $line);
                $array->set($index, $this->coerce($array->type->element ?? TypeRef::of('INT'), $value, $line));
                return;
        }

        throw new RuntimeError('Invalid assignment target', $line);
    }

    /** @phpstan-assert ArrayValue $array */
    private function arrayIndex(mixed $array, IndexAccess $access, int $line): int
    {
        if (!$array instanceof ArrayValue) {
            throw new RuntimeError('Indexing a value that is not an array', $line);
        }
        $index = $this->toInt($this->evaluate($access->index), $line);
        if (!$array->inBounds($index)) {
            throw new RuntimeError("Array index {$index} out of bounds [{$array->type->low}..{$array->type->high}]", $line);
        }

        return $index;
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
                return $this->readVariable($expr);

            case $expr instanceof AddressRef:
                return $this->image->read($expr->address);

            case $expr instanceof MemberAccess:
                $struct = $this->evaluate($expr->base);
                if (!$struct instanceof StructValue || !$struct->has($expr->member)) {
                    throw new RuntimeError("Unknown member '{$expr->member}'", $expr->line);
                }

                return $struct->get($expr->member);

            case $expr instanceof IndexAccess:
                $array = $this->evaluate($expr->base);

                return $array->get($this->arrayIndex($array, $expr, $expr->line));

            case $expr instanceof BinaryOp:
                return $this->binary($expr);

            case $expr instanceof UnaryOp:
                $value = $this->evaluate($expr->operand);
                if ($expr->op === TokenType::Not) {
                    return is_bool($value) ? !$value : ~$this->toInt($value, $expr->line);
                }
                if (is_float($value)) {
                    return -$value;
                }

                return -$this->toInt($value, $expr->line);

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
        if ($expr->op === TokenType::And && $left === false) {
            return false;
        }
        if ($expr->op === TokenType::Or && $left === true) {
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

        return $this->arithmetic($expr->op, $left, $right, $line);
    }

    private function arithmetic(TokenType $op, mixed $left, mixed $right, int $line): int|float
    {
        $l = $this->toNumber($left, $line);
        $r = $this->toNumber($right, $line);
        $real = is_float($l) || is_float($r);

        return match ($op) {
            TokenType::Plus => $l + $r,
            TokenType::Minus => $l - $r,
            TokenType::Star => $l * $r,
            TokenType::Power => (float) ($l ** $r),
            TokenType::Slash => match (true) {
                $r == 0 => throw new RuntimeError('Division by zero', $line),
                $real => $l / $r,
                default => intdiv((int) $l, (int) $r),
            },
            TokenType::Mod => match (true) {
                $real => throw new RuntimeError('MOD requires integer operands', $line),
                $r === 0 => throw new RuntimeError('Division by zero (MOD)', $line),
                default => $l % $r,
            },
            default => throw new RuntimeError("Unsupported operator {$op->value}", $line),
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
        if (is_float($left) || is_float($right)) {
            return (float) $left === (float) $right;
        }

        return $left === $right;
    }

    private function compare(mixed $left, mixed $right, int $line): int
    {
        if (is_string($left) && is_string($right)) {
            return strcmp($left, $right);
        }

        return $this->toNumber($left, $line) <=> $this->toNumber($right, $line);
    }

    // ------------------------------------------------------------------
    // Calls
    // ------------------------------------------------------------------

    private function call(CallExpr $call): mixed
    {
        $callee = $call->callee;

        if ($callee instanceof VariableRef && $callee->scope !== 'local') {
            $key = strtoupper($callee->name);
            if ($callee->scope === null && isset($this->functions[$key])) {
                return $this->callNative($key, $call);
            }
            if ($callee->scope === null && ($conversion = StandardFunctions::conversion($key)) !== null) {
                if (count($call->args) !== 1) {
                    throw new RuntimeError("{$callee->name}() takes exactly one argument", $call->line);
                }

                return StandardFunctions::convert($this->evaluate($call->args[0]->value), $conversion[0], $conversion[1], $call->line);
            }
            $pou = $this->program?->pous[$key] ?? null;
            if ($pou !== null && $pou->kind === Pou::FUNCTION) {
                return $this->callFunction($pou, $call);
            }
        }

        // Function block call through an instance: "Motor_DB"(...), #Timer(...), "IEC_Timer_DB".TON(...)
        if ($callee instanceof MemberAccess) {
            $base = $this->evaluate($callee->base);
            if ($base instanceof StructValue && $base->typeName !== null
                && strcasecmp($base->typeName, $callee->member) === 0) {
                return $this->callBlock($base, $call);
            }
        }
        $instance = $this->evaluate($callee);
        if (!$instance instanceof StructValue || $instance->typeName === null) {
            throw new RuntimeError('Called value is not a function block instance', $call->line);
        }

        return $this->callBlock($instance, $call);
    }

    private function callNative(string $key, CallExpr $call): mixed
    {
        $positional = [];
        $named = [];
        foreach ($call->args as $arg) {
            if ($arg->output) {
                throw new RuntimeError("Output parameter '{$arg->name}' is not supported by {$call->name()}()", $call->line);
            }
            $value = $this->evaluate($arg->value);
            if ($arg->name === null) {
                $positional[] = $value;
                continue;
            }
            $index = array_search(strtoupper($arg->name), $this->parameterNames[$key], true);
            if ($index === false) {
                throw new RuntimeError("{$call->name()}() has no parameter '{$arg->name}'", $call->line);
            }
            $named[$index] = $value;
        }
        if ($named !== []) {
            ksort($named);
            if (array_keys($named) !== range(count($positional), count($positional) + count($named) - 1)) {
                throw new RuntimeError("Missing parameters in call to {$call->name()}()", $call->line);
            }
            $positional = [...$positional, ...array_values($named)];
        }

        try {
            return ($this->functions[$key])(...$positional);
        } catch (SclException | HostSignal $e) {
            throw $e;
        } catch (\ArgumentCountError) {
            throw new RuntimeError("Wrong number of arguments for {$call->name()}()", $call->line);
        } catch (\Throwable $e) {
            throw new RuntimeError("{$call->name()}(): {$e->getMessage()}", $call->line, previous: $e);
        }
    }

    /** Calls a FUNCTION (FC): fresh locals every call, optional return value. */
    private function callFunction(Pou $pou, CallExpr $call): mixed
    {
        $frame = $this->frame($pou, null);
        $temps = $frame['temps'];
        $params = $pou->varsIn(VarDecl::INPUT, VarDecl::IN_OUT, VarDecl::OUTPUT);
        if ($pou->returnType !== null) {
            $temps->define($pou->name, $pou->returnType, $this->defaultValue($pou->returnType, $pou->line));
        }

        $outputs = [];
        foreach ($call->args as $position => $arg) {
            $name = $arg->name ?? ($params[$position]->name ?? null)
                ?? throw new RuntimeError("Too many arguments for {$pou->name}()", $call->line);
            $decl = $this->findVar($pou, $name);
            if ($decl === null || !in_array($decl->section, [VarDecl::INPUT, VarDecl::IN_OUT, VarDecl::OUTPUT], true)) {
                throw new RuntimeError("{$pou->name}() has no parameter '{$name}'", $call->line);
            }
            if ($decl->section === VarDecl::OUTPUT) {
                $outputs[$decl->name] = $arg->value;
                continue;
            }
            $temps->values[$decl->name] = $this->coerce($decl->type, $this->evaluate($arg->value), $call->line);
            if ($decl->section === VarDecl::IN_OUT) {
                $outputs[$decl->name] = $arg->value;
            }
        }

        $this->runInFrame($frame, $pou->body);

        foreach ($outputs as $name => $target) {
            $this->assignTo($target, $temps->values[$name], $call->line);
        }

        return $pou->returnType !== null ? $temps->values[$pou->name] : null;
    }

    /** Calls a function block instance (native or user-defined). */
    private function callBlock(StructValue $instance, CallExpr $call): mixed
    {
        $typeName = (string) $instance->typeName;
        $native = Library::functionBlock($typeName);
        $pou = $native === null ? ($this->program?->pous[strtoupper($typeName)] ?? null) : null;

        $outputs = [];
        foreach ($call->args as $arg) {
            if ($arg->name === null) {
                throw new RuntimeError("Function block {$typeName} must be called with named parameters (IN := ...)", $call->line);
            }
            $canonical = $instance->canonical($arg->name);
            if ($canonical === null || str_starts_with($canonical, '_')) {
                throw new RuntimeError("{$typeName} has no parameter '{$arg->name}'", $call->line);
            }
            if ($arg->output) {
                $outputs[$canonical] = $arg->value;
                continue;
            }
            $instance->values[$canonical] = $this->coerce($instance->types[$canonical], $this->evaluate($arg->value), $call->line);
            if ($pou !== null && $this->findVar($pou, $canonical)?->section === VarDecl::IN_OUT) {
                $outputs[$canonical] = $arg->value;
            }
        }

        if ($native !== null) {
            $native->execute($instance, ($this->clock)());
        } elseif ($pou !== null) {
            $this->runInFrame($this->frame($pou, $instance), $pou->body);
        } else {
            throw new RuntimeError("Unknown function block type '{$typeName}'", $call->line);
        }

        foreach ($outputs as $canonical => $target) {
            $this->assignTo($target, $instance->values[$canonical], $call->line);
        }

        return null;
    }

    private function runPou(Pou $pou): void
    {
        $this->runInFrame($this->frame($pou, null), $pou->body);
    }

    /**
     * @param array{temps: StructValue, instance: ?StructValue, pou: ?Pou} $frame
     * @param list<Stmt> $body
     */
    private function runInFrame(array $frame, array $body): void
    {
        $line = $frame['pou']?->line;
        if (count($this->frames) >= self::MAX_CALL_DEPTH) {
            throw new RuntimeError("Maximum call depth exceeded while calling '{$frame['pou']?->name}' (recursion?)", $line);
        }
        $this->checkWatchdog($line ?? 0);
        $this->frames[] = $frame;
        try {
            $this->execute($body);
        } catch (ReturnSignal) {
        } catch (ExitSignal | ContinueSignal $e) {
            throw new RuntimeError('EXIT/CONTINUE used outside of a loop', $e->sourceLine);
        } finally {
            array_pop($this->frames);
        }
    }

    /** @return array{temps: StructValue, instance: ?StructValue, pou: ?Pou} */
    private function frame(?Pou $pou, ?StructValue $instance): array
    {
        $temps = new StructValue();
        if ($pou !== null) {
            $sections = $pou->kind === Pou::FUNCTION_BLOCK
                ? [VarDecl::TEMP, VarDecl::CONSTANT]
                : [VarDecl::INPUT, VarDecl::OUTPUT, VarDecl::IN_OUT, VarDecl::TEMP, VarDecl::CONSTANT, VarDecl::STATIC];
            $this->frames[] = ['temps' => $temps, 'instance' => $instance, 'pou' => $pou];
            try {
                $this->defineAll($temps, $pou->varsIn(...$sections));
            } finally {
                array_pop($this->frames);
            }
        }

        return ['temps' => $temps, 'instance' => $instance, 'pou' => $pou];
    }

    /** @return array{temps: StructValue, instance: ?StructValue, pou: ?Pou} */
    private function currentFrame(): array
    {
        return $this->frames[count($this->frames) - 1];
    }

    private function findVar(Pou $pou, string $name): ?VarDecl
    {
        foreach ($pou->vars as $var) {
            if (strcasecmp($var->name, $name) === 0) {
                return $var;
            }
        }

        return null;
    }

    // ------------------------------------------------------------------
    // Types and values
    // ------------------------------------------------------------------

    /** @param list<VarDecl> $vars */
    private function defineAll(StructValue $struct, array $vars): void
    {
        foreach ($vars as $var) {
            $value = $var->initial !== null
                ? $this->coerce($var->type, $this->evaluate($var->initial), $var->line)
                : $this->defaultValue($var->type, $var->line);
            $struct->define($var->name, $var->type, $value);
        }
    }

    private function defaultValue(TypeRef $type, int $line): mixed
    {
        if ($type->isArray()) {
            $element = $type->element ?? TypeRef::of('INT');
            $items = [];
            for ($i = $type->low; $i <= $type->high; $i++) {
                $items[] = $this->defaultValue($element, $line);
            }

            return new ArrayValue($type, $items);
        }

        return match (TypeRef::ELEMENTARY[$type->name] ?? null) {
            'bool' => false,
            'int' => 0,
            'float' => 0.0,
            'string' => '',
            default => $this->instantiate($type, $line),
        };
    }

    /** Creates a function block instance (native or user FB). */
    private function instantiate(TypeRef $type, int $line): StructValue
    {
        $native = Library::functionBlock($type->name);
        if ($native !== null) {
            $instance = new StructValue($native->name());
            foreach ([...$native->inputs(), ...$native->outputs()] as $name => $elementary) {
                $instance->define($name, TypeRef::of($elementary), $this->defaultValue(TypeRef::of($elementary), $line));
            }
            foreach ($native->state() as $name => $value) {
                $instance->define($name, TypeRef::of(is_bool($value) ? 'BOOL' : 'LINT'), $value);
            }

            return $instance;
        }

        $pou = $this->program?->pous[$type->key()] ?? null;
        if ($pou === null || $pou->kind !== Pou::FUNCTION_BLOCK) {
            throw new RuntimeError("Unknown type '{$type->name}'", $line);
        }
        $instance = new StructValue($pou->name);
        $this->defineAll($instance, $pou->varsIn(VarDecl::INPUT, VarDecl::OUTPUT, VarDecl::IN_OUT, VarDecl::STATIC));

        return $instance;
    }

    private function coerce(TypeRef $type, mixed $value, int $line): mixed
    {
        if ($type->isArray() || !$type->isElementary()) {
            $matches = $type->isArray()
                ? $value instanceof ArrayValue && (string) $value->type === (string) $type
                : $value instanceof StructValue && strcasecmp((string) $value->typeName, $type->name) === 0;
            if (!$matches) {
                throw new RuntimeError("Cannot assign a value of another type to {$type}", $line);
            }

            return clone $value;
        }

        $name = $type->name;
        switch (TypeRef::ELEMENTARY[$name]) {
            case 'bool':
                if (is_bool($value) || is_int($value)) {
                    return (bool) $value;
                }
                break;

            case 'int':
                if (is_bool($value)) {
                    $value = (int) $value;
                }
                if (is_float($value)) {
                    throw new RuntimeError("Implicit conversion from REAL to {$name} is not allowed, use REAL_TO_{$name}() or TRUNC()", $line);
                }
                if (is_int($value)) {
                    [$bits, $signed] = TypeRef::INTEGER_RANGES[$name];

                    return StandardFunctions::wrap($value, $bits, $signed);
                }
                break;

            case 'float':
                if (is_int($value) || is_float($value)) {
                    // REAL is single precision on a PLC
                    return $name === 'REAL' ? (float) unpack('G', pack('G', (float) $value))[1] : (float) $value;
                }
                break;

            case 'string':
                if (is_scalar($value)) {
                    return is_bool($value) ? ($value ? 'TRUE' : 'FALSE') : (string) $value;
                }
                break;
        }

        throw new RuntimeError('Cannot assign ' . self::describe($value) . " to {$name}", $line);
    }

    private static function describe(mixed $value): string
    {
        return match (true) {
            is_bool($value) => 'a BOOL',
            is_int($value) => 'an integer',
            is_float($value) => 'a REAL',
            is_string($value) => 'a string',
            $value instanceof StructValue => 'an instance of ' . ($value->typeName ?? 'a structure'),
            $value instanceof ArrayValue => 'an array',
            default => get_debug_type($value),
        };
    }

    private function toInt(mixed $value, int $line): int
    {
        return match (true) {
            is_int($value) => $value,
            is_bool($value) => (int) $value,
            default => throw new RuntimeError('Expected an integer, got ' . self::describe($value), $line),
        };
    }

    private function toNumber(mixed $value, int $line): int|float
    {
        return match (true) {
            is_int($value), is_float($value) => $value,
            is_bool($value) => (int) $value,
            default => throw new RuntimeError('Expected a number, got ' . self::describe($value), $line),
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

        throw new RuntimeError('Expected a boolean condition, got ' . self::describe($value), $line);
    }

    private function deviceHandle(VarDecl $decl, int $line): mixed
    {
        $handle = $this->globals->get((string) $decl->binding?->device);
        if ($handle === null) {
            throw new RuntimeError("Device '{$decl->binding?->device}' used by '{$decl->name}' is not connected", $line);
        }

        return $handle;
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
}
