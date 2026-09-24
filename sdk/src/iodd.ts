// IO-Link device descriptions (IODD, IO Device Description XML): process data layout of a
// sensor / actuator, used to size the ports of an IO-Link master and to create PLC tags.
import type { Tag } from './project.ts';

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]);

/** Small XML parser (elements and attributes; text content is not needed here). */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) {
      if (stack.length > 1 && stack[stack.length - 1].name === m[1]) stack.pop();
      continue;
    }
    if (!m[2]) continue;
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescape(a[2] ?? a[3] ?? '');
    const node: XmlNode = { name: m[2].replace(/^[\w.-]+:/, ''), attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

function* walk(n: XmlNode): Generator<XmlNode> {
  yield n;
  for (const c of n.children) yield* walk(c);
}
const find = (n: XmlNode, name: string) => { for (const x of walk(n)) if (x.name === name) return x; return undefined; };
const child = (n: XmlNode | undefined, name: string) => n?.children.find((c) => c.name === name);

export interface ProcessDataItem {
  name: string;
  bitOffset: number;
  bitLength: number;
  /** PLC data type, when the item maps to a whole tag */
  dataType?: string;
  /** IODD data type (BooleanT, UIntegerT, ...) */
  ioddType: string;
}

export interface IoddDescription {
  vendor: string;
  device: string;
  productId?: string;
  /** Process data lengths in bytes */
  inLength: number;
  outLength: number;
  inputs: ProcessDataItem[];
  outputs: ProcessDataItem[];
}

function plcType(iodd: string, bits: number): string | undefined {
  if (iodd === 'BooleanT') return 'Bool';
  if (iodd === 'Float32T') return 'Real';
  if (iodd === 'UIntegerT') return ({ 8: 'USInt', 16: 'UInt', 32: 'UDInt' } as Record<number, string>)[bits];
  if (iodd === 'IntegerT') return ({ 8: 'SInt', 16: 'Int', 32: 'DInt', 64: 'LInt' } as Record<number, string>)[bits];
  return undefined;
}

/** Reads an IODD file: device identity and process data layout. */
export function parseIodd(xml: string, language = 'fr'): IoddDescription {
  const doc = parseXml(xml);
  if (!find(doc, 'IODevice')) throw new Error('Not an IODD file (IODevice element expected)');
  // texts: requested language, then the primary language
  const texts = new Map<string, string>();
  const collection = find(doc, 'ExternalTextCollection');
  const primary = child(collection, 'PrimaryLanguage');
  for (const t of primary?.children ?? []) if (t.name === 'Text') texts.set(t.attrs.id, t.attrs.value);
  const lang = collection?.children.find((c) => c.name === 'Language' && (c.attrs['xml:lang'] ?? c.attrs.lang ?? '').startsWith(language));
  for (const t of lang?.children ?? []) if (t.name === 'Text') texts.set(t.attrs.id, t.attrs.value);
  const text = (n: XmlNode | undefined) => (n?.attrs.textId ? texts.get(n.attrs.textId) ?? n.attrs.textId : '');

  const identity = find(doc, 'DeviceIdentity');
  const variant = find(doc, 'DeviceVariant');
  const datatypes = new Map<string, XmlNode>();
  for (const n of walk(doc)) if (n.name === 'Datatype' && n.attrs.id) datatypes.set(n.attrs.id, n);
  const typeOf = (n: XmlNode | undefined): XmlNode | undefined => {
    if (!n) return undefined;
    const ref = n.children.find((c) => c.name === 'DatatypeRef' || c.name === 'SimpleDatatypeRef');
    if (ref) return datatypes.get(ref.attrs.datatypeId);
    return n.children.find((c) => c.name === 'Datatype' || c.name === 'SimpleDatatype');
  };
  const xsiType = (n: XmlNode | undefined) => n?.attrs['xsi:type'] ?? n?.attrs.type ?? '';
  const bitsOf = (t: XmlNode | undefined, fallback: number) => Number(t?.attrs.bitLength ?? (xsiType(t) === 'BooleanT' ? 1 : xsiType(t) === 'Float32T' ? 32 : fallback));

  const items = (pd: XmlNode | undefined): ProcessDataItem[] => {
    if (!pd) return [];
    const total = Number(pd.attrs.bitLength ?? 0);
    const dt = typeOf(pd);
    if (!dt) return [];
    if (xsiType(dt) !== 'RecordT') {
      const bits = bitsOf(dt, total);
      return [{ name: text(child(pd, 'Name')) || 'Value', bitOffset: 0, bitLength: bits, ioddType: xsiType(dt), dataType: plcType(xsiType(dt), bits) }];
    }
    return dt.children.filter((c) => c.name === 'RecordItem').map((ri) => {
      const t = typeOf(ri);
      const bits = bitsOf(t, 8);
      const type = xsiType(t);
      return { name: text(child(ri, 'Name')) || `Item_${ri.attrs.subindex}`, bitOffset: Number(ri.attrs.bitOffset ?? 0), bitLength: bits, ioddType: type, dataType: plcType(type, bits) };
    });
  };
  // the first ProcessData set (devices with conditional layouts: the default one)
  const pdSet = find(doc, 'ProcessData');
  const pdIn = child(pdSet, 'ProcessDataIn') ?? find(doc, 'ProcessDataIn');
  const pdOut = child(pdSet, 'ProcessDataOut') ?? find(doc, 'ProcessDataOut');
  return {
    vendor: identity?.attrs.vendorName ?? text(child(identity, 'VendorText')),
    device: text(child(variant, 'Name')) || text(child(identity, 'DeviceName')) || variant?.attrs.productId || 'IO-Link device',
    productId: variant?.attrs.productId,
    inLength: Math.ceil(Number(pdIn?.attrs.bitLength ?? 0) / 8),
    outLength: Math.ceil(Number(pdOut?.attrs.bitLength ?? 0) / 8),
    inputs: items(pdIn),
    outputs: items(pdOut),
  };
}

/**
 * PLC tags for the process data of a port. IO-Link process data are sent most significant
 * octet first and bit offsets count from the least significant bit of the whole data.
 */
export function ioLinkTags(d: IoddDescription, prefix: string, inByte: number, outByte: number): { tags: Tag[]; skipped: string[] } {
  const tags: Tag[] = [];
  const skipped: string[] = [];
  const safe = (s: string) => s.replace(/["\r\n]/g, '').trim();
  const map = (list: ProcessDataItem[], area: 'I' | 'Q', base: number, length: number) => {
    for (const it of list) {
      const name = `${prefix}_${safe(it.name).replace(/\s+/g, '_')}`;
      if (it.bitLength === 1) {
        tags.push({ name, dataType: 'Bool', address: `%${area}${base + length - 1 - Math.floor(it.bitOffset / 8)}.${it.bitOffset % 8}`, comment: `${d.device} — ${it.name}` });
      } else if (it.dataType && it.bitOffset % 8 === 0 && it.bitLength % 8 === 0) {
        const start = base + length - (it.bitOffset + it.bitLength) / 8;
        const size = { 1: 'B', 2: 'W', 4: 'D' }[it.bitLength / 8];
        if (size) tags.push({ name, dataType: it.dataType, address: `%${area}${size}${start}`, comment: `${d.device} — ${it.name}` });
        else skipped.push(it.name);
      } else {
        skipped.push(`${it.name} (${it.bitLength} bits à l'offset ${it.bitOffset})`);
      }
    }
  };
  map(d.inputs, 'I', inByte, d.inLength);
  map(d.outputs, 'Q', outByte, d.outLength);
  return { tags, skipped };
}
