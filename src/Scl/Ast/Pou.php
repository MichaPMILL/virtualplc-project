<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

/** Program organisation unit: FUNCTION (FC), FUNCTION_BLOCK (FB) or ORGANIZATION_BLOCK (OB). */
final class Pou extends Node
{
    public const FUNCTION = 'FUNCTION';
    public const FUNCTION_BLOCK = 'FUNCTION_BLOCK';
    public const ORGANIZATION_BLOCK = 'ORGANIZATION_BLOCK';

    /**
     * @param list<VarDecl> $vars interface and local variables
     * @param list<Stmt>    $body
     */
    public function __construct(
        public readonly string $kind,
        public readonly string $name,
        public readonly ?TypeRef $returnType,
        public readonly array $vars,
        public readonly array $body,
        int $line,
    ) {
        parent::__construct($line);
    }

    /** @return list<VarDecl> */
    public function varsIn(string ...$sections): array
    {
        return array_values(array_filter($this->vars, static fn (VarDecl $v) => in_array($v->section, $sections, true)));
    }
}
