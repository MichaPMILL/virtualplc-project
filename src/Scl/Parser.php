<?php

declare(strict_types=1);

namespace VirtualPLC\Scl;

use VirtualPLC\Scl\Ast\Address;
use VirtualPLC\Scl\Ast\AddressRef;
use VirtualPLC\Scl\Ast\AssignStmt;
use VirtualPLC\Scl\Ast\BinaryOp;
use VirtualPLC\Scl\Ast\CallArg;
use VirtualPLC\Scl\Ast\CallExpr;
use VirtualPLC\Scl\Ast\CallStmt;
use VirtualPLC\Scl\Ast\CaseBranch;
use VirtualPLC\Scl\Ast\CaseStmt;
use VirtualPLC\Scl\Ast\ContinueStmt;
use VirtualPLC\Scl\Ast\DataBlockDecl;
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

/**
 * Recursive-descent parser producing a {@see Program} AST.
 *
 * Accepts "external source" SCL (FUNCTION, FUNCTION_BLOCK,
 * ORGANIZATION_BLOCK, DATA_BLOCK, VAR_GLOBAL) as well as the historical
 * VirtualPLC sections (HARDWARE, VAR, DB, BLOCK, FC).
 *
 * Operator precedence, lowest to highest:
 *   OR  <  XOR  <  AND/&  <  comparison  <  + -  <  * / MOD  <  **  <  unary (NOT, -)
 */
final class Parser
{
    /** Header lines of blocks that carry no semantics here (skipped up to end of line). */
    private const HEADER_ITEMS = ['VERSION', 'TITLE', 'AUTHOR', 'FAMILY', 'NAME', 'KNOW_HOW_PROTECT'];

    private const PRECEDENCE = [
        [TokenType::Or],
        [TokenType::Xor],
        [TokenType::And],
        [TokenType::Eq, TokenType::Neq, TokenType::Lt, TokenType::Lte, TokenType::Gt, TokenType::Gte],
        [TokenType::Plus, TokenType::Minus],
        [TokenType::Star, TokenType::Slash, TokenType::Mod],
        [TokenType::Power],
    ];

    private const COMPOUND_ASSIGN = [
        'PlusAssign' => TokenType::Plus,
        'MinusAssign' => TokenType::Minus,
        'StarAssign' => TokenType::Star,
        'SlashAssign' => TokenType::Slash,
    ];

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
        $pous = [];
        $dataBlocks = [];
        $seen = [];

        $addPou = static function (Pou $pou) use (&$pous, &$dataBlocks): void {
            $key = strtoupper($pou->name);
            if (isset($pous[$key]) || isset($dataBlocks[$key])) {
                throw new SyntaxError("Duplicate block '{$pou->name}'", $pou->line);
            }
            $pous[$key] = $pou;
        };

        while (!$this->check(TokenType::Eof)) {
            $token = $this->current();
            $section = $token->type;

            if (in_array($section, [TokenType::Hardware, TokenType::Db, TokenType::Fc], true)) {
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
                case TokenType::VarGlobal:
                    $vars = [...$vars, ...$this->varSection(VarDecl::GLOBAL, allowBindings: true)];
                    break;
                case TokenType::Db:
                    $db = $this->section(TokenType::Db, TokenType::EndDb);
                    break;
                case TokenType::Fc:
                    // Historical main program -> cyclic OB "Main"
                    $body = $this->section(TokenType::Fc, TokenType::EndFc);
                    $addPou(new Pou(Pou::ORGANIZATION_BLOCK, 'Main', null, [], $body, $token->line));
                    break;
                case TokenType::Block:
                    // Historical parameterless block -> FUNCTION without interface
                    $this->advance();
                    $name = $this->blockName();
                    $body = $this->statements([TokenType::EndBlock]);
                    $this->closeWith(TokenType::EndBlock);
                    $addPou(new Pou(Pou::FUNCTION, $name, null, [], $body, $token->line));
                    break;
                case TokenType::Function:
                    $addPou($this->pou(Pou::FUNCTION, TokenType::EndFunction));
                    break;
                case TokenType::FunctionBlock:
                    $addPou($this->pou(Pou::FUNCTION_BLOCK, TokenType::EndFunctionBlock));
                    break;
                case TokenType::OrganizationBlock:
                    $addPou($this->pou(Pou::ORGANIZATION_BLOCK, TokenType::EndOrganizationBlock));
                    break;
                case TokenType::DataBlock:
                    $block = $this->dataBlock();
                    $key = strtoupper($block->name);
                    if (isset($pous[$key]) || isset($dataBlocks[$key])) {
                        throw new SyntaxError("Duplicate block '{$block->name}'", $block->line);
                    }
                    $dataBlocks[$key] = $block;
                    break;
                default:
                    throw $this->unexpected('a block (ORGANIZATION_BLOCK, FUNCTION_BLOCK, FUNCTION, DATA_BLOCK) or a section (HARDWARE, VAR, DB, BLOCK, FC)');
            }
        }

        return new Program($hardware, $vars, $db, $pous, $dataBlocks);
    }

    // ------------------------------------------------------------------
    // Blocks and sections
    // ------------------------------------------------------------------

    /** @return list<Stmt> */
    private function section(TokenType $open, TokenType $close): array
    {
        $this->expect($open);
        $body = $this->statements([$close]);
        $this->closeWith($close);

        return $body;
    }

    private function blockName(): string
    {
        return (string) $this->expect(TokenType::Identifier)->value;
    }

    private function pou(string $kind, TokenType $end): Pou
    {
        $start = $this->advance();
        $name = $this->blockName();
        $returnType = null;
        if ($kind === Pou::FUNCTION && $this->optional(TokenType::Colon)) {
            $returnType = $this->type();
            if (strtoupper($returnType->name) === 'VOID') {
                $returnType = null;
            }
        }

        $this->skipHeader();
        $vars = [];
        while (true) {
            $section = match ($this->current()->type) {
                TokenType::VarInput => VarDecl::INPUT,
                TokenType::VarOutput => VarDecl::OUTPUT,
                TokenType::VarInOut => VarDecl::IN_OUT,
                TokenType::VarTemp => VarDecl::TEMP,
                TokenType::Var => VarDecl::STATIC,
                default => null,
            };
            if ($section === null) {
                break;
            }
            if ($section === VarDecl::STATIC && $kind !== Pou::FUNCTION_BLOCK && !$this->isConstantSection()) {
                // In FCs and OBs, a plain VAR section holds temporary variables.
                $section = VarDecl::TEMP;
            }
            $vars = [...$vars, ...$this->varSection($section)];
        }
        $this->optional(TokenType::Begin);
        $body = $this->statements([$end]);
        $this->closeWith($end);

        return new Pou($kind, $name, $returnType, $vars, $body, $start->line);
    }

    private function isConstantSection(): bool
    {
        return $this->peek(1)->type === TokenType::Constant;
    }

    private function dataBlock(): DataBlockDecl
    {
        $start = $this->expect(TokenType::DataBlock);
        $name = $this->blockName();
        $this->skipHeader();

        $instanceOf = null;
        $fields = [];
        if ($this->check(TokenType::Identifier)) {
            // Instance DB:  DATA_BLOCK "Motor_DB" "Motor"
            $instanceOf = (string) $this->advance()->value;
        } elseif ($this->check(TokenType::Struct)) {
            $this->advance();
            $fields = $this->declarations(VarDecl::STATIC, [TokenType::EndStruct]);
            $this->closeWith(TokenType::EndStruct);
        } else {
            while ($this->check(TokenType::Var)) {
                $fields = [...$fields, ...$this->varSection(VarDecl::STATIC)];
            }
        }

        $init = [];
        if ($this->optional(TokenType::Begin)) {
            $init = $this->statements([TokenType::EndDataBlock]);
        }
        $this->closeWith(TokenType::EndDataBlock);

        return new DataBlockDecl($name, $instanceOf, $fields, $init, $start->line);
    }

    /** Skips block header lines (VERSION : 0.1, TITLE = ..., NON_RETAIN, ...). */
    private function skipHeader(): void
    {
        while (true) {
            $token = $this->current();
            $isItem = $token->type === TokenType::Identifier && $token->scope === null
                && in_array(strtoupper((string) $token->value), self::HEADER_ITEMS, true)
                && in_array($this->peek(1)->type, [TokenType::Colon, TokenType::Eq], true);
            if ($isItem) {
                $this->skipLine($token->line);
            } elseif ($token->type === TokenType::NonRetain || $token->type === TokenType::Retain) {
                $this->advance();
            } else {
                return;
            }
        }
    }

    private function skipLine(int $line): void
    {
        while (!$this->check(TokenType::Eof) && $this->current()->line === $line) {
            $this->advance();
        }
    }

    /** @return list<VarDecl> */
    private function varSection(string $section, bool $allowBindings = false): array
    {
        $this->advance(); // VAR, VAR_GLOBAL, VAR_INPUT, ...
        while (in_array($this->current()->type, [TokenType::Constant, TokenType::Retain, TokenType::NonRetain], true)) {
            if ($this->advance()->type === TokenType::Constant) {
                $section = VarDecl::CONSTANT;
            }
        }
        $vars = $this->declarations($section, [TokenType::EndVar], $allowBindings);
        $this->closeWith(TokenType::EndVar);

        return $vars;
    }

    /**
     * @param list<TokenType> $terminators
     * @return list<VarDecl>
     */
    private function declarations(string $section, array $terminators, bool $allowBindings = false): array
    {
        $vars = [];
        while (!in_array($this->current()->type, $terminators, true)) {
            if ($this->check(TokenType::Eof)) {
                throw $this->unexpected($terminators[0]->describe());
            }
            $names = [$this->expect(TokenType::Identifier)];
            while ($this->optional(TokenType::Comma)) {
                $names[] = $this->expect(TokenType::Identifier);
            }

            $address = null;
            if ($this->optional(TokenType::At)) {
                $addressToken = $this->expect(TokenType::Address);
                $address = Address::parse((string) $addressToken->value);
                if (count($names) > 1) {
                    throw new SyntaxError('An address can only be given to a single variable', $addressToken->line);
                }
            }
            $this->expect(TokenType::Colon);

            $binding = null;
            if ($allowBindings && $this->check(TokenType::Identifier) && $this->peek(1)->type === TokenType::Dot) {
                // Historical syntax: Name : Device.INPUT.3;
                $binding = $this->ioBinding();
                $type = TypeRef::of('BOOL');
            } else {
                $type = $this->type();
            }

            $initial = $this->optional(TokenType::Assign) ? $this->expression() : null;
            $this->expect(TokenType::Semicolon);

            foreach ($names as $nameToken) {
                $vars[] = new VarDecl((string) $nameToken->value, $type, $binding, $initial, $nameToken->line, $section, $address);
            }
        }

        return $vars;
    }

    private function type(): TypeRef
    {
        if ($this->optional(TokenType::Array)) {
            $this->expect(TokenType::LBracket);
            $low = $this->signedInteger();
            $this->expect(TokenType::Range);
            $high = $this->signedInteger();
            $this->expect(TokenType::RBracket);
            $this->expect(TokenType::Of);
            if ($high < $low || $high - $low >= 65536) {
                throw new SyntaxError("Invalid array bounds [{$low}..{$high}]", $this->current()->line);
            }

            return TypeRef::array($this->type(), $low, $high);
        }

        $token = $this->expect(TokenType::Identifier);
        $type = TypeRef::of((string) $token->value);
        if ($type->name === 'STRING' && $this->optional(TokenType::LBracket)) {
            $this->expect(TokenType::Integer); // String[n]: length is not enforced
            $this->expect(TokenType::RBracket);
        }

        return $type;
    }

    private function signedInteger(): int
    {
        $negative = $this->optional(TokenType::Minus);
        $value = (int) $this->expect(TokenType::Integer)->value;

        return $negative ? -$value : $value;
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
            $token = $this->current();
            if ($token->type === TokenType::Eof) {
                $expected = implode(' or ', array_map(static fn (TokenType $t) => $t->describe(), $terminators));
                throw $this->unexpected($expected);
            }
            if ($this->optional(TokenType::Semicolon)) {
                continue; // empty statement
            }
            if ($token->type === TokenType::Region) {
                $this->skipLine($token->line); // REGION <free text>: pure structuring
                continue;
            }
            if ($token->type === TokenType::EndRegion) {
                $this->advance();
                $this->optional(TokenType::Semicolon);
                continue;
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
            case TokenType::Address:
                return $this->assignmentOrCall();

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

            case TokenType::Continue:
                $this->advance();
                $this->expect(TokenType::Semicolon);

                return new ContinueStmt($token->line);

            case TokenType::Return:
                $this->advance();
                $this->expect(TokenType::Semicolon);

                return new ReturnStmt($token->line);

            default:
                throw $this->unexpected('a statement');
        }
    }

    private function assignmentOrCall(): Stmt
    {
        $token = $this->current();
        $target = $this->postfix($this->atom());

        $assignType = $this->current()->type;
        if ($assignType === TokenType::Assign || isset(self::COMPOUND_ASSIGN[$assignType->name])) {
            if ($target instanceof CallExpr) {
                throw $this->unexpected("';'");
            }
            $this->advance();
            $value = $this->expression();
            $this->expect(TokenType::Semicolon);

            return new AssignStmt($target, $value, $token->line, self::COMPOUND_ASSIGN[$assignType->name] ?? null);
        }

        if ($target instanceof CallExpr) {
            $this->expect(TokenType::Semicolon);

            return new CallStmt($target);
        }

        $name = $token->type === TokenType::Identifier ? " after '{$token->value}'" : '';
        throw $this->unexpected("':=' or '('{$name}");
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
                $low = $this->signedInteger();
                $high = $this->optional(TokenType::Range) ? $this->signedInteger() : $low;
                if ($high < $low) {
                    throw new SyntaxError("Invalid CASE range {$low}..{$high}", $this->current()->line);
                }
                $ranges[] = [$low, $high];
            } while ($this->optional(TokenType::Comma));
            $this->expect(TokenType::Colon);
            $branches[] = new CaseBranch($ranges, $this->caseBody());
        }
        $this->closeWith(TokenType::EndCase);

        if ($branches === [] && $else === null) {
            throw new SyntaxError('CASE statement without any branch', $start->line);
        }

        return new CaseStmt($selector, $branches, $else, $start->line);
    }

    /** Statements of a CASE branch run until the next label, ELSE or END_CASE. @return list<Stmt> */
    private function caseBody(): array
    {
        $body = [];
        while (true) {
            $type = $this->current()->type;
            $isLabel = $type === TokenType::Integer
                || ($type === TokenType::Minus && $this->peek(1)->type === TokenType::Integer);
            if ($isLabel || $type === TokenType::Else || $type === TokenType::EndCase) {
                return $body;
            }
            if ($type === TokenType::Eof) {
                throw $this->unexpected("'END_CASE'");
            }
            if ($this->optional(TokenType::Semicolon)) {
                continue;
            }
            if ($type === TokenType::Region || $type === TokenType::EndRegion) {
                array_push($body, ...$this->statements([TokenType::Integer, TokenType::Minus, TokenType::Else, TokenType::EndCase]));
                continue;
            }
            $body[] = $this->statement();
        }
    }

    /** Consumes an END_xxx keyword and its (optional) trailing semicolon. */
    private function closeWith(TokenType $type): void
    {
        $this->expect($type);
        $this->optional(TokenType::Semicolon);
    }

    /** @return list<CallArg> */
    private function arguments(): array
    {
        $this->expect(TokenType::LParen);
        $args = [];
        if (!$this->check(TokenType::RParen)) {
            do {
                $next = $this->peek(1)->type;
                if ($this->check(TokenType::Identifier) && ($next === TokenType::Assign || $next === TokenType::OutputAssign)) {
                    $name = (string) $this->advance()->value;
                    $output = $this->advance()->type === TokenType::OutputAssign;
                    $value = $this->expression();
                    $args[] = new CallArg($name, $value, $output);
                } else {
                    $args[] = new CallArg(null, $this->expression());
                }
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
            if ($token->type === TokenType::Minus && $operand instanceof Literal
                && (is_int($operand->value) || is_float($operand->value))) {
                return new Literal(-$operand->value, $token->line, $operand->type);
            }

            return new UnaryOp($token->type, $operand, $token->line);
        }

        return $this->postfix($this->primary());
    }

    private function primary(): Expr
    {
        $token = $this->current();

        switch ($token->type) {
            case TokenType::Integer:
            case TokenType::Real:
            case TokenType::Boolean:
            case TokenType::String:
                $this->advance();

                return new Literal($token->value ?? 0, $token->line);

            case TokenType::Time:
                $this->advance();

                return new Literal((int) $token->value, $token->line, 'TIME');

            case TokenType::Identifier:
            case TokenType::Address:
                return $this->atom();

            case TokenType::LParen:
                $this->advance();
                $expr = $this->expression();
                $this->expect(TokenType::RParen);

                return $expr;

            default:
                throw $this->unexpected('an expression');
        }
    }

    /** Identifier or direct address. */
    private function atom(): Expr
    {
        $token = $this->advance();
        if ($token->type === TokenType::Address) {
            $address = Address::parse((string) $token->value)
                ?? throw new SyntaxError("Invalid address %{$token->value}", $token->line, $token->column);

            return new AddressRef($address, $token->line);
        }
        if ($token->type !== TokenType::Identifier) {
            $this->index--;
            throw $this->unexpected('an identifier');
        }

        return new VariableRef((string) $token->value, $token->line, $token->scope);
    }

    /** Member access, indexing and calls: a.b[3].c(x := 1) */
    private function postfix(Expr $expr): Expr
    {
        while (true) {
            $token = $this->current();
            if ($token->type === TokenType::Dot) {
                $this->advance();
                $member = $this->expect(TokenType::Identifier);
                $expr = new MemberAccess($expr, (string) $member->value, $member->line);
            } elseif ($token->type === TokenType::LBracket) {
                $this->advance();
                $index = $this->expression();
                $this->expect(TokenType::RBracket);
                $expr = new IndexAccess($expr, $index, $token->line);
            } elseif ($token->type === TokenType::LParen && !$expr instanceof CallExpr && !$expr instanceof AddressRef) {
                $expr = new CallExpr($expr, $this->arguments(), $expr->line);
            } else {
                return $expr;
            }
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
