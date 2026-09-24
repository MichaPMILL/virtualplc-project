<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

use VirtualPLC\Scl\Ast\AssignStmt;
use VirtualPLC\Scl\Ast\BinaryOp;
use VirtualPLC\Scl\Ast\CallExpr;
use VirtualPLC\Scl\Ast\CallStmt;
use VirtualPLC\Scl\Ast\CaseStmt;
use VirtualPLC\Scl\Ast\Expr;
use VirtualPLC\Scl\Ast\ForStmt;
use VirtualPLC\Scl\Ast\IfStmt;
use VirtualPLC\Scl\Ast\IoBinding;
use VirtualPLC\Scl\Ast\Literal;
use VirtualPLC\Scl\Ast\Program;
use VirtualPLC\Scl\Ast\RepeatStmt;
use VirtualPLC\Scl\Ast\Stmt;
use VirtualPLC\Scl\Ast\UnaryOp;
use VirtualPLC\Scl\Ast\VariableRef;
use VirtualPLC\Scl\Ast\WhileStmt;

/**
 * Static checks performed before a program is allowed to run.
 *
 * Catches, with a line number, mistakes that would otherwise only surface
 * (or silently misbehave) at runtime: undeclared variables, unknown
 * functions, writes to inputs, bindings to undeclared devices, ...
 *
 * Identifiers are case-insensitive, as in IEC 61131-3.
 */
final class Analyzer
{
    /** @var array<string, string> upper-case name => kind */
    private array $symbols = [];

    /** @var array<string, true> */
    private array $functions = [];

    /** @var array<string, true> */
    private array $blocks = [];

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
        $this->symbols = [];
        $this->blocks = [];

        foreach ($program->blocks as $key => $block) {
            if (isset($this->functions[$key])) {
                throw new SemanticError("Block '{$block->name}' shadows the built-in function of the same name", $block->line);
            }
            $this->blocks[$key] = true;
        }

        // Devices are the targets of assignments in the HARDWARE section.
        foreach ($program->hardware ?? [] as $stmt) {
            if (!$stmt instanceof AssignStmt) {
                continue;
            }
            $this->declare($stmt->target, 'device', $stmt->line);
        }

        foreach ($program->vars as $var) {
            $this->declare($var->name, $var->binding?->io === IoBinding::INPUT ? 'input' : 'variable', $var->line);
            if ($var->binding !== null) {
                $device = strtoupper($var->binding->device);
                if (($this->symbols[$device] ?? null) !== 'device') {
                    throw new SemanticError(
                        "Variable '{$var->name}' is bound to unknown device '{$var->binding->device}' (declare it in HARDWARE)",
                        $var->line,
                    );
                }
            }
            if ($var->initial !== null && !$var->initial instanceof Literal) {
                throw new SemanticError("Initial value of '{$var->name}' must be a literal", $var->line);
            }
        }

        // FOR loop counters are implicitly declared as INT.
        foreach ($this->allBodies($program) as $body) {
            $this->collectLoopCounters($body);
        }

        foreach ($this->allBodies($program) as $body) {
            $this->checkStatements($body);
        }
    }

    /** @return list<list<Stmt>> */
    private function allBodies(Program $program): array
    {
        $bodies = [$program->hardware ?? [], $program->db ?? [], $program->fc ?? []];
        foreach ($program->blocks as $block) {
            $bodies[] = $block->body;
        }

        return $bodies;
    }

    private function declare(string $name, string $kind, int $line): void
    {
        $key = strtoupper($name);
        if (isset($this->symbols[$key])) {
            throw new SemanticError("Duplicate declaration of '{$name}'", $line);
        }
        if (TokenType::keyword($key) !== null) {
            throw new SemanticError("'{$name}' is a reserved keyword", $line);
        }
        $this->symbols[$key] = $kind;
    }

    /** @param list<Stmt> $body */
    private function collectLoopCounters(array $body): void
    {
        foreach ($body as $stmt) {
            if ($stmt instanceof ForStmt) {
                $key = strtoupper($stmt->variable);
                $this->symbols[$key] ??= 'variable';
            }
            foreach ($this->childBodies($stmt) as $child) {
                $this->collectLoopCounters($child);
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
                $stmt instanceof ForStmt => array_map($this->checkExpr(...), array_filter([$stmt->start, $stmt->end, $stmt->step])),
                $stmt instanceof CaseStmt => $this->checkExpr($stmt->selector),
                default => null,
            };
            foreach ($this->childBodies($stmt) as $child) {
                $this->checkStatements($child);
            }
        }
    }

    private function checkAssign(AssignStmt $stmt): void
    {
        $kind = $this->symbols[strtoupper($stmt->target)] ?? null;
        if ($kind === null) {
            throw new SemanticError("Assignment to undeclared variable '{$stmt->target}'", $stmt->line);
        }
        if ($kind === 'input') {
            throw new SemanticError("Cannot assign to input '{$stmt->target}' (inputs are read-only)", $stmt->line);
        }
        $this->checkExpr($stmt->value);
    }

    private function checkExpr(Expr $expr): void
    {
        if ($expr instanceof VariableRef) {
            if (!isset($this->symbols[strtoupper($expr->name)])) {
                throw new SemanticError("Undeclared variable '{$expr->name}'", $expr->line);
            }
        } elseif ($expr instanceof CallExpr) {
            $key = strtoupper($expr->name);
            if (!isset($this->functions[$key]) && !isset($this->blocks[$key])) {
                throw new SemanticError("Unknown function or block '{$expr->name}'", $expr->line);
            }
            if (isset($this->blocks[$key]) && $expr->args !== []) {
                throw new SemanticError("Block '{$expr->name}' does not take arguments", $expr->line);
            }
            foreach ($expr->args as $arg) {
                $this->checkExpr($arg);
            }
        } elseif ($expr instanceof BinaryOp) {
            $this->checkExpr($expr->left);
            $this->checkExpr($expr->right);
        } elseif ($expr instanceof UnaryOp) {
            $this->checkExpr($expr->operand);
        }
    }
}
