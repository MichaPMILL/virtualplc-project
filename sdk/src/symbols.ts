/** Memory map of the program, used by the Studio to monitor and modify variables. */
export interface SymbolNode {
  name: string;
  /** Display type, e.g. "Int", "Array[1..5] of Real", "TON", "\"Motor\"" */
  type: string;
  kind?: 'bool' | 'int' | 'float' | 'time' | 'string' | 'array' | 'struct';
  area: 'D' | 'I' | 'Q' | 'M';
  offset: number;
  bit?: number;
  size: number;
  /** VM type code of elementary values (see VmType) */
  vmType?: number;
  children?: SymbolNode[];
}

/** Finds a symbol by path: Tag, DB.Member, Array[3], DB.Inst.Q (case-insensitive). */
export function findSymbol(symbols: SymbolNode[], path: string): SymbolNode | null {
  const parts = path.replace(/"/g, '').replace(/\[/g, '.[').split('.').filter((p) => p !== '');
  let level: SymbolNode[] | undefined = symbols;
  let node: SymbolNode | null = null;
  for (const part of parts) {
    node = level?.find((s) => s.name.toUpperCase() === part.toUpperCase()) ?? null;
    if (!node) return null;
    level = node.children;
  }
  return node;
}
