import { LIBRARY_BLOCKS, VmType } from './isa.ts';

export type Elementary =
  | 'BOOL' | 'BYTE' | 'WORD' | 'DWORD' | 'SINT' | 'USINT' | 'INT' | 'UINT' | 'DINT' | 'UDINT' | 'LINT'
  | 'REAL' | 'LREAL' | 'TIME';

export type DataType =
  | { k: 'elem'; name: Elementary }
  | { k: 'string'; length: number }
  | { k: 'array'; elem: DataType; low: number; high: number }
  | { k: 'fb'; name: string; library: boolean }
  | { k: 'db'; name: string }
  /** PLC data type (UDT) or anonymous STRUCT; `key` identifies the layout */
  | { k: 'struct'; name: string; key: string }
  | { k: 'anyint' }
  | { k: 'anyreal' }
  | { k: 'void' };

export const T = {
  BOOL: { k: 'elem', name: 'BOOL' } as DataType,
  INT: { k: 'elem', name: 'INT' } as DataType,
  DINT: { k: 'elem', name: 'DINT' } as DataType,
  LINT: { k: 'elem', name: 'LINT' } as DataType,
  REAL: { k: 'elem', name: 'REAL' } as DataType,
  LREAL: { k: 'elem', name: 'LREAL' } as DataType,
  TIME: { k: 'elem', name: 'TIME' } as DataType,
  ANYINT: { k: 'anyint' } as DataType,
  ANYREAL: { k: 'anyreal' } as DataType,
  VOID: { k: 'void' } as DataType,
  elem: (name: Elementary): DataType => ({ k: 'elem', name }),
};

interface ElementaryInfo {
  size: number;
  vm: number;
  cls: 'bool' | 'int' | 'float';
  signed: boolean;
}

export const ELEMENTARY: Record<Elementary, ElementaryInfo> = {
  BOOL: { size: 1, vm: VmType.BOOL, cls: 'bool', signed: false },
  BYTE: { size: 1, vm: VmType.U8, cls: 'int', signed: false },
  USINT: { size: 1, vm: VmType.U8, cls: 'int', signed: false },
  SINT: { size: 1, vm: VmType.I8, cls: 'int', signed: true },
  WORD: { size: 2, vm: VmType.U16, cls: 'int', signed: false },
  UINT: { size: 2, vm: VmType.U16, cls: 'int', signed: false },
  INT: { size: 2, vm: VmType.I16, cls: 'int', signed: true },
  DWORD: { size: 4, vm: VmType.U32, cls: 'int', signed: false },
  UDINT: { size: 4, vm: VmType.U32, cls: 'int', signed: false },
  DINT: { size: 4, vm: VmType.I32, cls: 'int', signed: true },
  TIME: { size: 4, vm: VmType.I32, cls: 'int', signed: true },
  LINT: { size: 8, vm: VmType.I64, cls: 'int', signed: true },
  REAL: { size: 4, vm: VmType.F32, cls: 'float', signed: true },
  LREAL: { size: 8, vm: VmType.F64, cls: 'float', signed: true },
};

export function isElementary(name: string): name is Elementary {
  return name in ELEMENTARY;
}

export const isBool = (t: DataType) => t.k === 'elem' && t.name === 'BOOL';
export const isInt = (t: DataType) => t.k === 'anyint' || (t.k === 'elem' && ELEMENTARY[t.name].cls === 'int');
export const isFloat = (t: DataType) => t.k === 'anyreal' || (t.k === 'elem' && ELEMENTARY[t.name].cls === 'float');
export const isNumeric = (t: DataType) => isInt(t) || isFloat(t);
export const isString = (t: DataType) => t.k === 'string';
export const isTime = (t: DataType) => t.k === 'elem' && t.name === 'TIME';

export function vmTypeOf(t: DataType): number {
  if (t.k === 'elem') return ELEMENTARY[t.name].vm;
  if (t.k === 'anyint') return VmType.I64;
  if (t.k === 'anyreal') return VmType.F64;
  return VmType.PTR;
}

export function typeName(t: DataType): string {
  switch (t.k) {
    case 'elem':
      return t.name[0] + t.name.slice(1).toLowerCase();
    case 'string':
      return `String[${t.length}]`;
    case 'array':
      return `Array[${t.low}..${t.high}] of ${typeName(t.elem)}`;
    case 'fb':
      return t.library ? t.name : `"${t.name}"`;
    case 'db':
      return `DB "${t.name}"`;
    case 'struct':
      return t.name ? `"${t.name}"` : 'Struct';
    case 'anyint':
      return 'integer constant';
    case 'anyreal':
      return 'real constant';
    default:
      return 'Void';
  }
}

export function sameType(a: DataType, b: DataType): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'elem':
      return a.name === (b as typeof a).name;
    case 'string':
      return true;
    case 'array': {
      const o = b as typeof a;
      return a.low === o.low && a.high === o.high && sameType(a.elem, o.elem);
    }
    case 'fb':
    case 'db':
      return a.name.toUpperCase() === (b as typeof a).name.toUpperCase();
    case 'struct':
      return a.key === (b as typeof a).key;
    default:
      return true;
  }
}

/** Common type of two numeric operands (implicit widening). */
export function unifyNumeric(a: DataType, b: DataType): DataType | null {
  if (!isNumeric(a) || !isNumeric(b)) return null;
  if (isFloat(a) || isFloat(b)) {
    const is = (t: DataType, n: string) => t.k === 'elem' && t.name === n;
    if (is(a, 'LREAL') || is(b, 'LREAL')) return T.LREAL;
    if (is(a, 'REAL') || is(b, 'REAL')) return T.REAL;
    return T.LREAL;
  }
  if (a.k === 'anyint' && b.k === 'anyint') return T.DINT;
  if (a.k === 'anyint') return b;
  if (b.k === 'anyint') return a;
  if (isTime(a) || isTime(b)) return T.TIME;
  const sa = ELEMENTARY[(a as { name: Elementary }).name].size;
  const sb = ELEMENTARY[(b as { name: Elementary }).name].size;
  if (sa !== sb) return sa > sb ? a : b;
  // same size: prefer the signed type
  return ELEMENTARY[(a as { name: Elementary }).name].signed ? a : b;
}

export function libraryBlock(name: string) {
  const key = name.toUpperCase();
  return key in LIBRARY_BLOCKS ? { key, ...LIBRARY_BLOCKS[key] } : null;
}

/** VM type name (as used in libraryBlocks) to a DataType. */
export function fromVmName(name: string): DataType {
  const map: Record<string, Elementary> = { BOOL: 'BOOL', U8: 'BYTE', I8: 'SINT', U16: 'WORD', I16: 'INT', U32: 'DWORD', I32: 'DINT', I64: 'LINT', F32: 'REAL', F64: 'LREAL' };
  return T.elem(map[name]);
}
