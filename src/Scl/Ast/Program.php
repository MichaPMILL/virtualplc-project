<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class Program
{
    /**
     * @param list<Stmt>|null        $hardware
     * @param list<VarDecl>          $vars
     * @param list<Stmt>|null        $db
     * @param list<Stmt>|null        $fc
     * @param array<string, BlockDecl> $blocks keyed by upper-case block name
     */
    public function __construct(
        public readonly ?array $hardware,
        public readonly array $vars,
        public readonly ?array $db,
        public readonly ?array $fc,
        public readonly array $blocks,
    ) {
    }
}
