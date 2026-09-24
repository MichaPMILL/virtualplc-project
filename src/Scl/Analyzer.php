<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

use VirtualPLC\Scl\Ast\AddressRef;
use VirtualPLC\Scl\Ast\AssignStmt;
use VirtualPLC\Scl\Ast\BinaryOp;
use VirtualPLC\Scl\Ast\CallExpr;
use VirtualPLC\Scl\Ast\CallStmt;
use VirtualPLC\Scl\Ast\CaseStmt;
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
use VirtualPLC\Scl\Ast\Stmt;
use VirtualPLC\Scl\Ast\TypeRef;
use VirtualPLC\Scl\Ast\UnaryOp;
use VirtualPLC\Scl\Ast\VarDecl;
use VirtualPLC\Scl\Ast\VariableRef;
use VirtualPLC\Scl\Ast\WhileStmt;
use VirtualPLC\Scl\Library\Library;

/**
 * Static checks performed before a program is allowed to run, reported with
 * a line number: undeclared identifiers, unknown types/functions/parameters,
 * writes to inputs or constants, invalid addresses, duplicate names...
 *
 * Identifiers are case-insensitive, as in IEC 61131-3. "Quoted" names refer to
 * the global scope, #names to the local scope of the block.
 */
final class Analyzer
{
    /** Kinds of global symbols. */
    private const DEVICE = 'device';
    private const TAG = 'tag';
    private const INPUT = 'input';
    private const CONSTANT = 'constant';
    private const DB = 'db';

    /** @var array<string, array{kind: string, type: ?TypeRef}> upper-case name => symbol */
    private array $globals = [];

    /** @var array<string, array{kind: string, type: ?TypeRef}> symbols of the block being checked */
    private array $locals = [];

    /** @var array<string, true> */
    private array $functions = [];

    private ?Program $program = null;
    private ?Pou $pou = null;

    /** @param list<string> $functionNames names of the natively registered functions */
    public function __construct(array $functionNames)
    {
        foreach ($functionNames as $name) {
            $this->functions[strtoupper($name)] = true;
        }
    }

    /** @throws SemanticError */
    public function analyze(Program $program): void
    {
        $this->program = $program;
        $this->globals = [];

        foreach ($program->pous as $key => $pou) {
            if (isset($this->functions[$key]) || StandardFunctions::conversion($key) !== null || Library::functionBlock($key) !== null) {
                throw new SemanticError("Block '{$pou->name}' has the name of a built-in instruction", $pou->line);
            }
        }

        // Devices are the targets of assignments in the HARDWARE section.
        foreach ($program->hardware ?? [] as $stmt) {
            if ($stmt instanceof AssignStmt && $stmt->target instanceof VariableRef) {
                $this->declareGlobal($stmt->target->name, self::DEVICE, null, $stmt->line);
            }
        }

        foreach ($program->vars as $var) {
            $kind = match (true) {
                $var->section === VarDecl::CONSTANT => self::CONSTANT,
                $var->binding?->io === IoBinding::INPUT, $var->address?->area === 'I' => self::INPUT,
                default => self::TAG,
            };
            $this->declareGlobal($var->name, $kind, $var->type, $var->line);
            $this->checkDeclaration($var, true);
            if ($var->binding !== null && ($this->globals[strtoupper($var->binding->device)]['kind'] ?? null) !== self::DEVICE) {
                throw new SemanticError(
                    "Variable '{$var->name}' is bound to unknown device '{$var->binding->device}' (declare it in HARDWARE)",
                    $var->line,
                );
            }
        }

        foreach ($program->dataBlocks as $db) {
            if ($db->instanceOf !== null) {
                $type = TypeRef::of($db->instanceOf);
                if (!$this->isFunctionBlockType($type)) {
                    throw new SemanticError("Instance DB '{$db->name}': '{$db->instanceOf}' is not a function block", $db->line);
                }
            } else {
                $type = null;
                foreach ($db->fields as $field) {
                    $this->checkDeclaration($field, false);
                }
            }
            $this->declareGlobal($db->name, self::DB, $type, $db->line);
        }

        // Top-level sections run in the global scope.
        $this->enter(null);
        $this->checkStatements($program->hardware ?? []);
        $this->checkStatements($program->db ?? []);
        foreach ($program->dataBlocks as $db) {
            $this->locals = [];
            foreach ($db->fields as $field) {
                $this->locals[strtoupper($field->name)] = ['kind' => self::TAG, 'type' => $field->type];
            }
            $this->checkStatements($db->init);
        }

        foreach ($program->pous as $pou) {
            $this->enter($pou);
            $this->checkStatements($pou->body);
        }
    }

    private function declareGlobal(string $name, string $kind, ?TypeRef $type, int $line): void
    {
        $key = strtoupper($name);
        if (isset($this->globals[$key])) {
            throw new SemanticError("Duplicate declaration of '{$name}'", $line);
        }
        if (isset($this->program?->pous[$key])) {
            throw new SemanticError("'{$name}' is already used as a block name", $line);
        }
        $this->checkName($name, $line);
        $this->globals[$key] = ['kind' => $kind, 'type' => $type];
    }

    private function checkName(string $name, int $line): void
    {
        $key = strtoupper($name);
        if (TokenType::keyword($key) !== null || isset(TypeRef::ELEMENTARY[$key])) {
            throw new SemanticError("'{$name}' is a reserved keyword", $line);
        }
    }

    private function checkDeclaration(VarDecl $var, bool $global): void
    {
        $this->checkType($var->type, $var->line);
        if ($var->address !== null) {
            if (!$global) {
                throw new SemanticError("Only global tags can have an address ('{$var->name}')", $var->line);
            }
            if (!$var->type->isElementary() || !$var->address->accepts($var->type->name)) {
                throw new SemanticError("Type {$var->type} does not fit address {$var->address} of '{$var->name}'", $var->line);
            }
        }
        if ($var->initial !== null && !$this->isConstantExpr($var->initial)) {
            throw new SemanticError("Start value of '{$var->name}' must be a constant", $var->line);
        }
        if ($var->section === VarDecl::CONSTANT && $var->initial === null) {
            throw new SemanticError("Constant '{$var->name}' needs a value", $var->line);
        }
    }

    private function checkType(TypeRef $type, int $line): void
    {
        if ($type->isArray()) {
            $this->checkType($type->element ?? TypeRef::of('INT'), $line);
            return;
        }
        if (!$type->isElementary() && !$this->isFunctionBlockType($type)) {
            throw new SemanticError("Unknown data type '{$type->name}'", $line);
        }
    }

    private function isFunctionBlockType(TypeRef $type): bool
    {
        if (Library::functionBlock($type->name) !== null) {
            return true;
        }
        $pou = $this->program?->pous[$type->key()] ?? null;

        return $pou !== null && $pou->kind === Pou::FUNCTION_BLOCK;
    }

    private function isConstantExpr(Expr $expr): bool
    {
        return match (true) {
            $expr instanceof Literal => true,
            $expr instanceof UnaryOp => $this->isConstantExpr($expr->operand),
            $expr instanceof BinaryOp => $this->isConstantExpr($expr->left) && $this->isConstantExpr($expr->right),
            $expr instanceof VariableRef => ($this->locals[strtoupper($expr->name)]['kind'] ?? $this->globals[strtoupper($expr->name)]['kind'] ?? null) === self::CONSTANT,
            default => false,
        };
    }

    /** Sets up the local scope of a block (null = global scope). */
    private function enter(?Pou $pou): void
    {
        $this->pou = $pou;
        $this->locals = [];
        if ($pou === null) {
            return;
        }

        foreach ($pou->vars as $var) {
            $key = strtoupper($var->name);
            if (isset($this->locals[$key])) {
                throw new SemanticError("Duplicate declaration of '{$var->name}' in '{$pou->name}'", $var->line);
            }
            $this->checkName($var->name, $var->line);
            $this->locals[$key] = [
                'kind' => $var->section === VarDecl::CONSTANT ? self::CONSTANT : self::TAG,
                'type' => $var->type,
            ];
            $this->checkDeclaration($var, false);
            if ($pou->kind !== Pou::FUNCTION_BLOCK && !$var->type->isElementary() && !$var->type->isArray()
                && $var->section !== VarDecl::IN_OUT) {
                throw new SemanticError(
                    "'{$var->name}': function block instances must be declared in a FUNCTION_BLOCK (static) or as a global DB/tag",
                    $var->line,
                );
            }
        }
        if ($pou->kind === Pou::FUNCTION && $pou->returnType !== null) {
            $this->checkType($pou->returnType, $pou->line);
            $this->locals[strtoupper($pou->name)] = ['kind' => self::TAG, 'type' => $pou->returnType];
        }
    }

    /** @param list<Stmt> $body */
    private function checkStatements(array $body): void
    {
        foreach ($body as $stmt) {
            match (true) {
                $stmt instanceof AssignStmt => $this->checkAssign($stmt),
                $stmt instanceof CallStmt => $this->checkExpr($stmt->call),
                $stmt instanceof IfStmt => array_map(fn (array $b) => $this->checkExpr($b[0]), $stmt->branches),
                $stmt instanceof WhileStmt => $this->checkExpr($stmt->condition),
                $stmt instanceof RepeatStmt => $this->checkExpr($stmt->until),
                $stmt instanceof ForStmt => $this->checkFor($stmt),
                $stmt instanceof CaseStmt => $this->checkExpr($stmt->selector),
                default => null,
            };
            foreach ($this->childBodies($stmt) as $child) {
                $this->checkStatements($child);
            }
        }
    }

    /** @return list<list<Stmt>> */
    private function childBodies(Stmt $stmt): array
    {
        return match (true) {
            $stmt instanceof IfStmt => [...array_map(static fn (array $b) => $b[1], $stmt->branches), $stmt->else ?? []],
            $stmt instanceof WhileStmt, $stmt instanceof RepeatStmt, $stmt instanceof ForStmt => [$stmt->body],
            $stmt instanceof CaseStmt => [...array_map(static fn ($b) => $b->body, $stmt->branches), $stmt->else ?? []],
            default => [],
        };
    }

    private function checkFor(ForStmt $stmt): void
    {
        $key = strtoupper($stmt->variable);
        if (!isset($this->locals[$key]) && !isset($this->globals[$key])) {
            // Historical programs use undeclared counters: they are implicitly DINT.
            $this->locals[$key] = ['kind' => self::TAG, 'type' => TypeRef::of('DINT')];
        }
        $this->checkExpr($stmt->start);
        $this->checkExpr($stmt->end);
        if ($stmt->step !== null) {
            $this->checkExpr($stmt->step);
        }
    }

    private function checkAssign(AssignStmt $stmt): void
    {
        $target = $stmt->target;
        $root = $target;
        while ($root instanceof MemberAccess || $root instanceof IndexAccess) {
            $root = $root->base;
        }

        if ($root instanceof AddressRef) {
            if ($root->address->area === 'I') {
                throw new SemanticError("Cannot assign to input {$root->address} (inputs are read-only)", $stmt->line);
            }
        } elseif ($root instanceof VariableRef) {
            $symbol = $this->resolve($root, $stmt->line, "Assignment to undeclared variable '{$root->name}'");
            match ($symbol['kind']) {
                self::INPUT => throw new SemanticError("Cannot assign to input '{$root->name}' (inputs are read-only)", $stmt->line),
                self::CONSTANT => throw new SemanticError("Cannot assign to constant '{$root->name}'", $stmt->line),
                self::DB => $target === $root
                    ? throw new SemanticError("Cannot assign to data block '{$root->name}' as a whole", $stmt->line)
                    : null,
                default => null,
            };
        } else {
            throw new SemanticError('Invalid assignment target', $stmt->line);
        }

        $this->checkExpr($target, true);
        $this->checkExpr($stmt->value);
    }

    /** @return array{kind: string, type: ?TypeRef} */
    private function resolve(VariableRef $ref, int $line, ?string $message = null): array
    {
        $key = strtoupper($ref->name);
        $symbol = match ($ref->scope) {
            'local' => $this->locals[$key] ?? null,
            'global' => $this->globals[$key] ?? null,
            default => $this->locals[$key] ?? $this->globals[$key] ?? null,
        };
        if ($symbol === null) {
            $where = match ($ref->scope) {
                'local' => " in the interface of '{$this->pou?->name}'",
                'global' => ' in the tag table or data blocks',
                default => '',
            };
            throw new SemanticError(($message ?? "Undeclared variable '{$ref->name}'") . $where, $line);
        }

        return $symbol;
    }

    private function checkExpr(Expr $expr, bool $isTarget = false): void
    {
        switch (true) {
            case $expr instanceof VariableRef:
                $this->resolve($expr, $expr->line);
                return;

            case $expr instanceof MemberAccess:
                $this->checkExpr($expr->base, $isTarget);
                $type = $this->typeOf($expr->base);
                if ($type !== null && !$this->hasMember($type, $expr->member)) {
                    throw new SemanticError("'{$type->name}' has no member '{$expr->member}'", $expr->line);
                }
                return;

            case $expr instanceof IndexAccess:
                $this->checkExpr($expr->base, $isTarget);
                $this->checkExpr($expr->index);
                return;

            case $expr instanceof CallExpr:
                $this->checkCall($expr);
                return;

            case $expr instanceof BinaryOp:
                $this->checkExpr($expr->left);
                $this->checkExpr($expr->right);
                return;

            case $expr instanceof UnaryOp:
                $this->checkExpr($expr->operand);
                return;
        }
    }

    private function checkCall(CallExpr $call): void
    {
        foreach ($call->args as $arg) {
            $this->checkExpr($arg->value, $arg->output);
        }
        $callee = $call->callee;

        if ($callee instanceof VariableRef && $callee->scope !== 'local') {
            $key = strtoupper($callee->name);
            if ($callee->scope === null && (isset($this->functions[$key]) || StandardFunctions::conversion($key) !== null)) {
                return;
            }
            $pou = $this->program?->pous[$key] ?? null;
            if ($pou !== null) {
                if ($pou->kind === Pou::FUNCTION) {
                    $this->checkParameters($call, $pou->varsIn(VarDecl::INPUT, VarDecl::OUTPUT, VarDecl::IN_OUT), $pou->name, true);
                    return;
                }
                throw new SemanticError(
                    $pou->kind === Pou::FUNCTION_BLOCK
                        ? "Function block '{$pou->name}' must be called through an instance (instance DB or static variable)"
                        : "Organization block '{$pou->name}' cannot be called",
                    $call->line,
                );
            }
            if (Library::functionBlock($key) !== null) {
                throw new SemanticError("'{$callee->name}' must be called through an instance (e.g. #MyTimer : {$callee->name}; #MyTimer(...))", $call->line);
            }
            $isVariable = $callee->scope === 'global'
                ? isset($this->globals[$key])
                : isset($this->locals[$key]) || isset($this->globals[$key]);
            if (!$isVariable) {
                throw new SemanticError("Unknown function or block '{$callee->name}'", $call->line);
            }
        }

        $target = $callee;
        if ($callee instanceof MemberAccess) {
            $baseType = $this->typeOf($callee->base);
            if ($baseType !== null && strcasecmp($baseType->name, $callee->member) === 0) {
                $target = $callee->base; // "IEC_Timer_DB".TON(...)
            }
        }
        $this->checkExpr($target);
        $type = $this->typeOf($target);
        if ($type === null) {
            return; // not statically known (array element...)
        }
        if (!$this->isFunctionBlockType($type)) {
            throw new SemanticError("'" . ($call->name() ?? 'value') . "' is not a function block instance", $call->line);
        }
        foreach ($call->args as $arg) {
            if ($arg->name === null) {
                throw new SemanticError("Function block {$type->name} must be called with named parameters (IN := ...)", $call->line);
            }
        }
        $this->checkParameters($call, $this->interfaceOf($type), $type->name, false);
    }

    /** @param list<VarDecl> $params */
    private function checkParameters(CallExpr $call, array $params, string $name, bool $positionalAllowed): void
    {
        $byName = [];
        foreach ($params as $param) {
            $byName[strtoupper($param->name)] = $param;
        }
        foreach ($call->args as $position => $arg) {
            if ($arg->name === null) {
                if (!$positionalAllowed || !isset($params[$position])) {
                    throw new SemanticError("Too many arguments for '{$name}'", $call->line);
                }
                continue;
            }
            $param = $byName[strtoupper($arg->name)] ?? null;
            if ($param === null) {
                throw new SemanticError("'{$name}' has no parameter '{$arg->name}'", $call->line);
            }
            if ($arg->output && $param->section === VarDecl::INPUT) {
                throw new SemanticError("'{$arg->name}' is an input of '{$name}': use ':=' instead of '=>'", $call->line);
            }
            if (!$arg->output && $param->section === VarDecl::OUTPUT && $positionalAllowed === false) {
                throw new SemanticError("'{$arg->name}' is an output of '{$name}': use '=>' instead of ':='", $call->line);
            }
        }
    }

    /** Interface (inputs/outputs/in-outs) of a function block type. @return list<VarDecl> */
    private function interfaceOf(TypeRef $type): array
    {
        $native = Library::functionBlock($type->name);
        if ($native !== null) {
            $params = [];
            foreach ($native->inputs() as $n => $t) {
                $params[] = new VarDecl($n, TypeRef::of($t), null, null, 0, VarDecl::INPUT);
            }
            foreach ($native->outputs() as $n => $t) {
                $params[] = new VarDecl($n, TypeRef::of($t), null, null, 0, VarDecl::OUTPUT);
            }

            return $params;
        }

        return $this->program?->pous[$type->key()]?->varsIn(VarDecl::INPUT, VarDecl::OUTPUT, VarDecl::IN_OUT) ?? [];
    }

    private function hasMember(TypeRef $type, string $member): bool
    {
        if ($type->isArray()) {
            return false;
        }
        $native = Library::functionBlock($type->name);
        if ($native !== null) {
            return isset(array_change_key_case([...$native->inputs(), ...$native->outputs()], CASE_UPPER)[strtoupper($member)]);
        }
        $pou = $this->program?->pous[$type->key()] ?? null;
        if ($pou === null) {
            return true; // unknown: checked at runtime
        }
        foreach ($pou->varsIn(VarDecl::INPUT, VarDecl::OUTPUT, VarDecl::IN_OUT, VarDecl::STATIC) as $var) {
            if (strcasecmp($var->name, $member) === 0) {
                return true;
            }
        }

        return false;
    }

    /** Statically known type of an expression, when it matters (instances); null otherwise. */
    private function typeOf(Expr $expr): ?TypeRef
    {
        if ($expr instanceof VariableRef) {
            $key = strtoupper($expr->name);
            $symbol = match ($expr->scope) {
                'local' => $this->locals[$key] ?? null,
                'global' => $this->globals[$key] ?? null,
                default => $this->locals[$key] ?? $this->globals[$key] ?? null,
            };
            if ($symbol !== null && $symbol['kind'] === self::DB && $symbol['type'] === null) {
                return null; // global DB: members checked at runtime
            }

            return $symbol['type'] ?? null;
        }
        if ($expr instanceof MemberAccess) {
            $base = $this->typeOf($expr->base);
            if ($base === null || $base->isArray()) {
                return null;
            }
            foreach ($this->program?->pous[$base->key()]?->vars ?? [] as $var) {
                if (strcasecmp($var->name, $expr->member) === 0) {
                    return $var->type;
                }
            }
            $native = Library::functionBlock($base->name);
            $members = $native === null ? [] : array_change_key_case([...$native->inputs(), ...$native->outputs()], CASE_UPPER);

            return isset($members[strtoupper($expr->member)]) ? TypeRef::of($members[strtoupper($expr->member)]) : null;
        }
        if ($expr instanceof IndexAccess) {
            return $this->typeOf($expr->base)?->element;
        }

        return null;
    }
}
