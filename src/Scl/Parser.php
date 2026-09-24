<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

use VirtualPLC\Scl\Ast\AssignStmt;
use VirtualPLC\Scl\Ast\BinaryOp;
use VirtualPLC\Scl\Ast\BlockDecl;
use VirtualPLC\Scl\Ast\CallExpr;
use VirtualPLC\Scl\Ast\CallStmt;
use VirtualPLC\Scl\Ast\CaseBranch;
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

/**
 * Recursive-descent parser producing a {@see Program} AST.
 *
 * Operator precedence, lowest to highest:
 *   OR  <  XOR  <  AND  <  comparison (= <> < <= > >=)  <  + -  <  * / MOD  <  unary (NOT, -)
 */
final class Parser
{
    /** @var list<Token> */
    private array $tokens;
    private int $index = 0;

    public function __construct(string $source)
    {
        $this->tokens = (new Lexer($source))->tokenize();
    }

    public static function parseSource(string $source): Program
    {
        return (new self($source))->parse();
    }

    public function parse(): Program
    {
        $hardware = null;
        $vars = [];
        $db = null;
        $fc = null;
        $blocks = [];
        $seen = [];

        while (!$this->check(TokenType::Eof)) {
            $token = $this->current();
            $section = $token->type;

            if (in_array($section, [TokenType::Hardware, TokenType::Var, TokenType::Db, TokenType::Fc], true)) {
                if (isset($seen[$section->value])) {
                    throw new SyntaxError("Duplicate {$section->value} section", $token->line, $token->column);
                }
                $seen[$section->value] = true;
            }

            switch ($section) {
                case TokenType::Hardware:
                    $hardware = $this->section(TokenType::Hardware, TokenType::EndHardware);
                    break;
                case TokenType::Var:
                    $vars = $this->varSection();
                    break;
                case TokenType::Db:
                    $db = $this->section(TokenType::Db, TokenType::EndDb);
                    break;
                case TokenType::Fc:
                    $fc = $this->section(TokenType::Fc, TokenType::EndFc);
                    break;
                case TokenType::Block:
                    $block = $this->blockDecl();
                    $key = strtoupper($block->name);
                    if (isset($blocks[$key])) {
                        throw new SyntaxError("Duplicate block '{$block->name}'", $block->line);
                    }
                    $blocks[$key] = $block;
                    break;
                default:
                    throw $this->unexpected('a section (HARDWARE, VAR, DB, BLOCK or FC)');
            }
        }

        return new Program($hardware, $vars, $db, $fc, $blocks);
    }

    // ------------------------------------------------------------------
    // Sections
    // ------------------------------------------------------------------

    /** @return list<Stmt> */
    private function section(TokenType $open, TokenType $close): array
    {
        $this->expect($open);
        $body = $this->statements([$close]);
        $this->expect($close);
        $this->optional(TokenType::Semicolon);

        return $body;
    }

    private function blockDecl(): BlockDecl
    {
        $start = $this->expect(TokenType::Block);
        $name = (string) $this->expect(TokenType::Identifier)->value;
        $body = $this->statements([TokenType::EndBlock]);
        $this->expect(TokenType::EndBlock);
        $this->optional(TokenType::Semicolon);

        return new BlockDecl($name, $body, $start->line);
    }

    /** @return list<VarDecl> */
    private function varSection(): array
    {
        $this->expect(TokenType::Var);
        $vars = [];

        while (!$this->check(TokenType::EndVar)) {
            if ($this->check(TokenType::Eof)) {
                throw $this->unexpected("'END_VAR'");
            }
            $nameToken = $this->expect(TokenType::Identifier);
            $name = (string) $nameToken->value;
            $this->expect(TokenType::Colon);

            $binding = null;
            if ($this->check(TokenType::TypeBool) || $this->check(TokenType::TypeInt)) {
                $type = $this->advance()->type === TokenType::TypeInt ? VarDecl::INT : VarDecl::BOOL;
            } elseif ($this->check(TokenType::Identifier)) {
                $binding = $this->ioBinding();
                $type = VarDecl::BOOL;
            } else {
                throw $this->unexpected('a type (BOOL, INT) or an I/O binding (Device.INPUT.n)');
            }

            $initial = null;
            if ($this->optional(TokenType::Assign)) {
                $initial = $this->expression();
            }
            $this->expect(TokenType::Semicolon);
            $vars[] = new VarDecl($name, $type, $binding, $initial, $nameToken->line);
        }

        $this->expect(TokenType::EndVar);
        $this->optional(TokenType::Semicolon);

        return $vars;
    }

    private function ioBinding(): IoBinding
    {
        $device = (string) $this->expect(TokenType::Identifier)->value;
        $this->expect(TokenType::Dot);
        $ioToken = $this->expect(TokenType::Identifier);
        $io = strtoupper((string) $ioToken->value);
        if ($io !== IoBinding::INPUT && $io !== IoBinding::OUTPUT) {
            throw new SyntaxError("I/O type must be INPUT or OUTPUT, got '{$ioToken->value}'", $ioToken->line, $ioToken->column);
        }
        $this->expect(TokenType::Dot);
        $address = (int) $this->expect(TokenType::Integer)->value;
        if ($address > 65535) {
            throw new SyntaxError("I/O address {$address} out of range (0-65535)", $ioToken->line);
        }

        return new IoBinding($device, $io, $address);
    }

    // ------------------------------------------------------------------
    // Statements
    // ------------------------------------------------------------------

    /**
     * @param list<TokenType> $terminators
     * @return list<Stmt>
     */
    private function statements(array $terminators): array
    {
        $statements = [];
        while (!in_array($this->current()->type, $terminators, true)) {
            if ($this->check(TokenType::Eof)) {
                $expected = implode(' or ', array_map(static fn (TokenType $t) => $t->describe(), $terminators));
                throw $this->unexpected($expected);
            }
            if ($this->optional(TokenType::Semicolon)) {
                continue; // empty statement
            }
            $statements[] = $this->statement();
        }

        return $statements;
    }

    private function statement(): Stmt
    {
        $token = $this->current();

        switch ($token->type) {
            case TokenType::Identifier:
                $this->advance();
                if ($this->optional(TokenType::Assign)) {
                    $value = $this->expression();
                    $this->expect(TokenType::Semicolon);

                    return new AssignStmt((string) $token->value, $value, $token->line);
                }
                if ($this->check(TokenType::LParen)) {
                    $call = new CallExpr((string) $token->value, $this->arguments(), $token->line);
                    $this->expect(TokenType::Semicolon);

                    return new CallStmt($call);
                }
                throw $this->unexpected("':=' or '(' after '{$token->value}'");

            case TokenType::If:
                return $this->ifStatement();

            case TokenType::While:
                $this->advance();
                $condition = $this->expression();
                $this->expect(TokenType::Do);
                $body = $this->statements([TokenType::EndWhile]);
                $this->closeWith(TokenType::EndWhile);

                return new WhileStmt($condition, $body, $token->line);

            case TokenType::Repeat:
                $this->advance();
                $body = $this->statements([TokenType::Until]);
                $this->expect(TokenType::Until);
                $condition = $this->expression();
                $this->closeWith(TokenType::EndRepeat);

                return new RepeatStmt($body, $condition, $token->line);

            case TokenType::For:
                $this->advance();
                $variable = (string) $this->expect(TokenType::Identifier)->value;
                $this->expect(TokenType::Assign);
                $start = $this->expression();
                $this->expect(TokenType::To);
                $end = $this->expression();
                $step = $this->optional(TokenType::By) ? $this->expression() : null;
                $this->expect(TokenType::Do);
                $body = $this->statements([TokenType::EndFor]);
                $this->closeWith(TokenType::EndFor);

                return new ForStmt($variable, $start, $end, $step, $body, $token->line);

            case TokenType::Case:
                return $this->caseStatement();

            case TokenType::Exit:
                $this->advance();
                $this->expect(TokenType::Semicolon);

                return new ExitStmt($token->line);

            case TokenType::Return:
                $this->advance();
                $this->expect(TokenType::Semicolon);

                return new ReturnStmt($token->line);

            default:
                throw $this->unexpected('a statement');
        }
    }

    private function ifStatement(): IfStmt
    {
        $start = $this->expect(TokenType::If);
        $stops = [TokenType::Elsif, TokenType::Else, TokenType::EndIf];

        $condition = $this->expression();
        $this->expect(TokenType::Then);
        $branches = [[$condition, $this->statements($stops)]];
        $else = null;

        while (true) {
            if ($this->optional(TokenType::Elsif)) {
                // standard form
            } elseif ($this->check(TokenType::Else)
                && $this->peek(1)->type === TokenType::If
                && $this->peek(1)->line === $this->current()->line) {
                // "ELSE IF" on one line is accepted as an alias of ELSIF (single END_IF).
                // An IF on the line after ELSE is a regular nested IF with its own END_IF.
                $this->advance();
                $this->advance();
            } else {
                break;
            }
            $condition = $this->expression();
            $this->expect(TokenType::Then);
            $branches[] = [$condition, $this->statements($stops)];
        }

        if ($this->optional(TokenType::Else)) {
            $else = $this->statements([TokenType::EndIf]);
        }
        $this->closeWith(TokenType::EndIf);

        return new IfStmt($branches, $else, $start->line);
    }

    private function caseStatement(): CaseStmt
    {
        $start = $this->expect(TokenType::Case);
        $selector = $this->expression();
        $this->expect(TokenType::Of);

        $branches = [];
        $else = null;
        while (!$this->check(TokenType::EndCase)) {
            if ($this->optional(TokenType::Else)) {
                $else = $this->statements([TokenType::EndCase]);
                break;
            }
            $ranges = [];
            do {
                $low = $this->caseLabel();
                $high = $this->optional(TokenType::Range) ? $this->caseLabel() : $low;
                if ($high < $low) {
                    throw new SyntaxError("Invalid CASE range {$low}..{$high}", $this->current()->line);
                }
                $ranges[] = [$low, $high];
            } while ($this->optional(TokenType::Comma));
            $this->expect(TokenType::Colon);
            $body = $this->caseBody();
            $branches[] = new CaseBranch($ranges, $body);
        }
        $this->closeWith(TokenType::EndCase);

        if ($branches === [] && $else === null) {
            throw new SyntaxError('CASE statement without any branch', $start->line);
        }

        return new CaseStmt($selector, $branches, $else, $start->line);
    }

    private function caseLabel(): int
    {
        $negative = $this->optional(TokenType::Minus);
        $value = (int) $this->expect(TokenType::Integer)->value;

        return $negative ? -$value : $value;
    }

    /** Statements of a CASE branch run until the next label, ELSE or END_CASE. @return list<Stmt> */
    private function caseBody(): array
    {
        $body = [];
        while (!in_array($this->current()->type, [TokenType::Integer, TokenType::Minus, TokenType::Else, TokenType::EndCase], true)) {
            if ($this->check(TokenType::Eof)) {
                throw $this->unexpected("'END_CASE'");
            }
            if ($this->optional(TokenType::Semicolon)) {
                continue;
            }
            $body[] = $this->statement();
        }

        return $body;
    }

    /** Consumes an END_xxx keyword and its (optional) trailing semicolon. */
    private function closeWith(TokenType $type): void
    {
        $this->expect($type);
        $this->optional(TokenType::Semicolon);
    }

    /** @return list<Expr> */
    private function arguments(): array
    {
        $this->expect(TokenType::LParen);
        $args = [];
        if (!$this->check(TokenType::RParen)) {
            do {
                $args[] = $this->expression();
            } while ($this->optional(TokenType::Comma));
        }
        $this->expect(TokenType::RParen);

        return $args;
    }

    // ------------------------------------------------------------------
    // Expressions
    // ------------------------------------------------------------------

    private function expression(): Expr
    {
        return $this->binary(0);
    }

    private const PRECEDENCE = [
        [TokenType::Or],
        [TokenType::Xor],
        [TokenType::And],
        [TokenType::Eq, TokenType::Neq, TokenType::Lt, TokenType::Lte, TokenType::Gt, TokenType::Gte],
        [TokenType::Plus, TokenType::Minus],
        [TokenType::Star, TokenType::Slash, TokenType::Mod],
    ];

    private function binary(int $level): Expr
    {
        if ($level >= count(self::PRECEDENCE)) {
            return $this->unary();
        }

        $left = $this->binary($level + 1);
        while (in_array($this->current()->type, self::PRECEDENCE[$level], true)) {
            $op = $this->advance();
            $right = $this->binary($level + 1);
            $left = new BinaryOp($op->type, $left, $right, $op->line);
        }

        return $left;
    }

    private function unary(): Expr
    {
        $token = $this->current();
        if ($token->type === TokenType::Not || $token->type === TokenType::Minus || $token->type === TokenType::Plus) {
            $this->advance();
            $operand = $this->unary();
            if ($token->type === TokenType::Plus) {
                return $operand;
            }
            if ($token->type === TokenType::Minus && $operand instanceof Literal && is_int($operand->value)) {
                return new Literal(-$operand->value, $token->line);
            }

            return new UnaryOp($token->type, $operand, $token->line);
        }

        return $this->primary();
    }

    private function primary(): Expr
    {
        $token = $this->current();

        switch ($token->type) {
            case TokenType::Integer:
            case TokenType::Boolean:
            case TokenType::String:
                $this->advance();

                return new Literal($token->value ?? 0, $token->line);

            case TokenType::Identifier:
                $this->advance();
                if ($this->check(TokenType::LParen)) {
                    return new CallExpr((string) $token->value, $this->arguments(), $token->line);
                }

                return new VariableRef((string) $token->value, $token->line);

            case TokenType::LParen:
                $this->advance();
                $expr = $this->expression();
                $this->expect(TokenType::RParen);

                return $expr;

            default:
                throw $this->unexpected('an expression');
        }
    }

    // ------------------------------------------------------------------
    // Token helpers
    // ------------------------------------------------------------------

    private function current(): Token
    {
        return $this->tokens[$this->index];
    }

    private function peek(int $offset): Token
    {
        return $this->tokens[min($this->index + $offset, count($this->tokens) - 1)];
    }

    private function check(TokenType $type): bool
    {
        return $this->current()->type === $type;
    }

    private function advance(): Token
    {
        $token = $this->current();
        if ($token->type !== TokenType::Eof) {
            $this->index++;
        }

        return $token;
    }

    private function optional(TokenType $type): bool
    {
        if ($this->check($type)) {
            $this->advance();

            return true;
        }

        return false;
    }

    private function expect(TokenType $type): Token
    {
        if (!$this->check($type)) {
            throw $this->unexpected($type->describe());
        }

        return $this->advance();
    }

    private function unexpected(string $expected): SyntaxError
    {
        $token = $this->current();

        return new SyntaxError("Expected {$expected}, found {$token->describe()}", $token->line, $token->column);
    }
}
