// Minimal reader for .xlsx workbooks (Office Open XML spreadsheets), used to import PLC tag
// tables exported by engineering tools. No dependency: ZIP directory parsing, "deflate-raw"
// decompression with the standard DecompressionStream (browsers and Node.js) and a small
// XML scanner for the cells.
import type { Tag, UserConstant } from './project.ts';

export interface Sheet {
  name: string;
  rows: string[][];
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Files of a ZIP archive (stored or deflated entries). */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory record (at most 64 KiB of comment after it)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP / XLSX file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupted ZIP directory');
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compressed);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, await inflateRaw(raw));
    else throw new Error(`Unsupported ZIP compression (${method}) for ${name}`);
  }
  return files;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()]);
}

/** Text of <t> elements (shared strings may be split in formatted runs). */
function textOf(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) out += m[1];
  return unescapeXml(out);
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const files = await unzip(bytes);
  const text = (path: string) => {
    const f = files.get(path);
    return f ? new TextDecoder().decode(f) : '';
  };
  const shared = [...text('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]));
  const rels = new Map([...text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const sheets: Sheet[] = [];
  for (const m of text('xl/workbook.xml').matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const name = unescapeXml(attr(m[0], 'name') ?? '');
    const target = rels.get(attr(m[0], 'r:id'));
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const rows: string[][] = [];
    for (const row of text(path).matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const cells: string[] = [];
      let next = 0;
      for (const c of row[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ref = attr(c[0], 'r');
        const col = ref ? columnIndex(ref) : next;
        next = col + 1;
        const type = attr(c[0], 't');
        const body = c[2] ?? '';
        const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
        let value = '';
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else value = v !== undefined ? unescapeXml(v) : '';
        cells[col] = value;
      }
      rows.push(Array.from(cells, (x) => x ?? ''));
    }
    sheets.push({ name, rows });
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// PLC tag tables
// ---------------------------------------------------------------------------

const HEADERS = {
  name: ['name', 'nom', 'tag name', 'nom de la variable'],
  path: ['path', 'chemin', 'tag table', 'table de variables'],
  dataType: ['data type', 'datatype', 'type de données', 'type de donnees', 'type'],
  address: ['logical address', 'adresse logique', 'address', 'adresse', 'logische adresse'],
  value: ['value', 'valeur', 'wert', 'constant value'],
  comment: ['comment', 'commentaire', 'kommentar'],
} as const;

type Field = keyof typeof HEADERS;

function headerMap(row: string[]): Partial<Record<Field, number>> | null {
  const map: Partial<Record<Field, number>> = {};
  row.forEach((cell, i) => {
    const h = cell.trim().toLowerCase();
    for (const [field, names] of Object.entries(HEADERS) as Array<[Field, readonly string[]]>) {
      if (map[field] === undefined && names.includes(h)) map[field] = i;
    }
  });
  return map.name !== undefined && map.dataType !== undefined ? map : null;
}

export interface ImportedTagTable {
  name: string;
  tags: Tag[];
  constants: UserConstant[];
}

/**
 * PLC tags and user constants from an .xlsx tag table export (columns Name, Path, Data Type,
 * Logical Address, Comment — or their French names). One table per "Path" value.
 */
export async function importTagTableXlsx(bytes: Uint8Array, fallbackName = 'Table importée'): Promise<ImportedTagTable[]> {
  const tables = new Map<string, ImportedTagTable>();
  const tableFor = (name: string) => {
    const key = name.trim() || fallbackName;
    let t = tables.get(key);
    if (!t) {
      t = { name: key, tags: [], constants: [] };
      tables.set(key, t);
    }
    return t;
  };
  let found = false;
  for (const sheet of await readXlsx(bytes)) {
    const headerRow = sheet.rows.findIndex((r) => headerMap(r) !== null);
    if (headerRow < 0) continue;
    found = true;
    const map = headerMap(sheet.rows[headerRow])!;
    const isConstants = map.address === undefined && map.value !== undefined;
    for (const row of sheet.rows.slice(headerRow + 1)) {
      const get = (f: Field) => (map[f] !== undefined ? (row[map[f]!] ?? '').trim() : '');
      const name = get('name');
      if (!name) continue;
      const table = tableFor(get('path'));
      const comment = get('comment') || undefined;
      if (isConstants) {
        table.constants.push({ name, dataType: get('dataType'), value: get('value'), ...(comment ? { comment } : {}) });
      } else {
        let address = get('address').replace(/\s+/g, '');
        if (address && !address.startsWith('%')) address = `%${address}`;
        table.tags.push({ name, dataType: get('dataType'), address, ...(comment ? { comment } : {}) });
      }
    }
  }
  if (!found) throw new Error('No tag table found in the workbook (expected columns "Name" and "Data Type")');
  return [...tables.values()];
}
