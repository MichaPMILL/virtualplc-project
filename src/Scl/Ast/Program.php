<?php

declare(strict_types=1);

namespace VirtualPLC\Scl\Ast;

final class Program
{
    /**
     * @param list<Stmt>|null              $hardware   HARDWARE section (device declarations)
     * @param list<VarDecl>                $vars       global tags (VAR / VAR_GLOBAL)
     * @param list<Stmt>|null              $db         historical DB section (start-up assignments)
     * @param array<string, Pou>           $pous       keyed by upper-case name
     * @param array<string, DataBlockDecl> $dataBlocks keyed by upper-case name
     */
    public function __construct(
        public readonly ?array $hardware,
        public readonly array $vars,
        public readonly ?array $db,
        public readonly array $pous,
        public readonly array $dataBlocks = [],
    ) {
    }

    /** Cyclic OB: "Main" / OB1 (the historical FC section is compiled to it). */
    public function mainOb(): ?Pou
    {
        return $this->findOb(['MAIN', 'OB1', 'OB_MAIN']);
    }

    /** Start-up OB: "Startup" / OB100. */
    public function startupOb(): ?Pou
    {
        return $this->findOb(['STARTUP', 'OB100', 'COMPLETE_RESTART']);
    }

    /** @param list<string> $names */
    private function findOb(array $names): ?Pou
    {
        foreach ($names as $name) {
            $pou = $this->pous[$name] ?? null;
            if ($pou !== null && $pou->kind === Pou::ORGANIZATION_BLOCK) {
                return $pou;
            }
        }

        return null;
    }
}
