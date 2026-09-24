import { VmType } from './isa.ts';
import { formatTemporal, type TemporalType } from './literals.ts';
import type { SymbolNode } from './symbols.ts';

/** 64-bit integers beyond ±2^53 are bigint. */
export type PlcValue = boolean | number | bigint | string | PlcValue[] | { [member: string]: PlcValue };

const big = (v: bigint): number | bigint => (v >= -(2n ** 53n) && v <= 2n ** 53n ? Number(v) : v);

/** Decodes the bytes of a symbol read from the PLC (big-endian, as in PLC memory). */
export function decodeValue(symbol: SymbolNode, bytes: Uint8Array, offset = 0): PlcValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, symbol.size);
  if (symbol.children) {
    if (symbol.kind === 'array') return symbol.children.map((c) => decodeValue(c, bytes, offset + c.offset - symbol.offset));
    const out: Record<string, PlcValue> = {};
    for (const c of symbol.children) out[c.name] = decodeValue(c, bytes, offset + c.offset - symbol.offset);
    return out;
  }
  if (symbol.kind === 'string') {
    const len = Math.min(view.getUint8(1), symbol.size - 2);
    return new TextDecoder().decode(bytes.subarray(offset + 2, offset + 2 + len));
  }
  if (symbol.bit !== undefined) return ((view.getUint8(0) >> symbol.bit) & 1) === 1;
  switch (symbol.vmType) {
    case VmType.BOOL: return view.getUint8(0) !== 0;
    case VmType.U8: return view.getUint8(0);
    case VmType.I8: return view.getInt8(0);
    case VmType.U16: return view.getUint16(0);
    case VmType.I16: return view.getInt16(0);
    case VmType.U32: return view.getUint32(0);
    case VmType.I32: return view.getInt32(0);
    case VmType.I64: return big(view.getBigInt64(0));
    case VmType.U64: return big(view.getBigUint64(0));
    case VmType.F32: return view.getFloat32(0);
    case VmType.F64: return view.getFloat64(0);
    default: return Array.from(bytes.subarray(offset, offset + symbol.size)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

/** Encodes a value for an elementary or STRING symbol (for WRITE). */
export function encodeValue(symbol: SymbolNode, value: PlcValue): Uint8Array {
  if (symbol.kind === 'string') {
    const text = new TextEncoder().encode(String(value)).subarray(0, symbol.size - 2);
    const out = new Uint8Array(symbol.size);
    out[0] = symbol.size - 2;
    out[1] = text.length;
    out.set(text, 2);
    return out;
  }
  const out = new Uint8Array(symbol.size);
  const view = new DataView(out.buffer);
  if (typeof value === 'bigint' || symbol.vmType === VmType.I64 || symbol.vmType === VmType.U64) {
    const b = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
    if (symbol.vmType === VmType.I64 || symbol.vmType === VmType.U64) {
      view.setBigUint64(0, BigInt.asUintN(64, b));
      return out;
    }
    value = Number(b);
  }
  const n = typeof value === 'boolean' ? Number(value) : Number(value);
  if (Number.isNaN(n) && symbol.vmType !== VmType.F32 && symbol.vmType !== VmType.F64) throw new Error(`Invalid value for ${symbol.name}`);
  switch (symbol.vmType) {
    case VmType.BOOL: view.setUint8(0, n ? 1 : 0); break;
    case VmType.U8: case VmType.I8: view.setUint8(0, n & 0xff); break;
    case VmType.U16: case VmType.I16: view.setUint16(0, n & 0xffff); break;
    case VmType.U32: case VmType.I32: view.setUint32(0, n >>> 0); break;
    case VmType.I64: view.setBigInt64(0, BigInt(Math.trunc(n))); break;
    case VmType.F32: view.setFloat32(0, n); break;
    case VmType.F64: view.setFloat64(0, n); break;
    default: throw new Error(`Cannot write ${symbol.type}`);
  }
  return out;
}

/** Formats a value for the monitor column. */
export function formatValue(symbol: SymbolNode, value: PlcValue): string {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (symbol.kind === 'time' && typeof value === 'number') return formatTime(value);
  const temporal: Partial<Record<NonNullable<SymbolNode['kind']>, TemporalType>> = { ltime: 'LTIME', date: 'DATE', tod: 'TOD', ltod: 'LTOD', dt: 'DT', ldt: 'LDT' };
  const tt = symbol.kind ? temporal[symbol.kind] : undefined;
  if (tt && (typeof value === 'number' || typeof value === 'bigint')) return formatTemporal(tt, BigInt(value));
  if (symbol.kind === 'char' && typeof value === 'number') {
    return value >= 32 && value < 127 && value !== 39 ? `'${String.fromCodePoint(value)}'` : `${symbol.size === 1 ? 'CHAR' : 'WCHAR'}#${value}`;
  }
  if (symbol.kind === 'string') return `'${value}'`;
  if (typeof value === 'number' && symbol.kind === 'float') return Number.isInteger(value) ? value.toFixed(1) : String(Number(value.toPrecision(7)));
  return String(value);
}

export function formatTime(ms: number): string {
  if (ms === 0) return 'T#0MS';
  const neg = ms < 0;
  let rest = Math.abs(ms);
  const parts: string[] = [];
  for (const [unit, size] of [['D', 86_400_000], ['H', 3_600_000], ['M', 60_000], ['S', 1000], ['MS', 1]] as const) {
    const q = Math.floor(rest / size);
    if (q) parts.push(`${q}${unit}`);
    rest -= q * size;
  }
  return `T#${neg ? '-' : ''}${parts.join('_')}`;
}
