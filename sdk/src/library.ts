// Libraries ("Bibliothèques"), as in the usual engineering tools:
//   - the project library, saved with the project (library/<Element>.json);
//   - global libraries, .vplclib files shared between projects and engineers;
//   - the VirtualPLC standard library (stdlib.ts), read only.
// An element is a block, a PLC data type or an interface, with a version. Inserting an
// element copies it into a CPU with the elements it depends on (data types, function blocks,
// interfaces); the copies remember where they come from, so that a newer version can be
// proposed later ("mise à jour").
import { importExternalSource, newId, normalizeBlock, type Block, type DataTypeDef, type Device, type InterfaceDef } from './project.ts';
import { STANDARD_LIBRARY, STANDARD_LIBRARY_NAME, STANDARD_LIBRARY_VERSION } from './stdlib.ts';

export const LIBRARY_FORMAT = 'virtualplc-library-1';
export const LIBRARY_EXT = '.vplclib';

export type LibraryElementKind = 'block' | 'type' | 'interface';

export interface LibraryElement {
  id: string;
  kind: LibraryElementKind;
  name: string;
  /** Semantic version: 1.0.0, then 1.0.1… at each release */
  version: string;
  category?: string;
  description?: string;
  author?: string;
  modified: string;
  /** Names of the other elements of the library it needs (inserted with it) */
  dependencies: string[];
  block?: Block;
  type?: DataTypeDef;
  iface?: InterfaceDef;
}

export interface Library {
  format: typeof LIBRARY_FORMAT;
  id: string;
  name: string;
  description?: string;
  author?: string;
  readOnly?: boolean;
  elements: LibraryElement[];
}

/** Origin of a copy in a project (kept on blocks, types and interfaces) */
export interface LibraryOrigin {
  library: string;
  element: string;
  version: string;
}

export function newLibrary(name: string, author?: string): Library {
  return { format: LIBRARY_FORMAT, id: newId('lib'), name, ...(author ? { author } : {}), elements: [] };
}

export function parseLibrary(text: string): Library {
  const lib = JSON.parse(text) as Library;
  if (lib.format !== LIBRARY_FORMAT || !Array.isArray(lib.elements)) throw new Error('Not a VirtualPLC library (.vplclib)');
  for (const e of lib.elements) {
    e.dependencies ??= [];
    if (e.block) e.block = normalizeBlock(e.block);
  }
  return lib;
}

export function serializeLibrary(lib: Library): string {
  const elements = [...lib.elements].sort((a, b) => a.name.localeCompare(b.name));
  return `${JSON.stringify({ ...lib, elements }, null, 2)}\n`;
}

/** 1.2.3 -> 1.2.4 (or the minor / major part) */
export function nextVersion(v: string, part: 'major' | 'minor' | 'patch' = 'patch'): string {
  const [a, b, c] = v.split('.').map((x) => Number(x) || 0);
  if (part === 'major') return `${a + 1}.0.0`;
  if (part === 'minor') return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

/** Compares two versions: < 0 when a is older than b */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map((n) => Number(n) || 0);
  const y = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

type DeviceElement = { kind: 'block'; value: Block } | { kind: 'type'; value: DataTypeDef } | { kind: 'interface'; value: InterfaceDef };

function deviceElements(device: Device): DeviceElement[] {
  return [
    ...device.blocks.map((value): DeviceElement => ({ kind: 'block', value })),
    ...device.types.map((value): DeviceElement => ({ kind: 'type', value })),
    ...(device.interfaces ?? []).map((value): DeviceElement => ({ kind: 'interface', value })),
  ];
}

/** Text in which the dependencies of an element are looked for */
function textOf(e: DeviceElement): string {
  return JSON.stringify(e.value);
}

function mentions(text: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])"?${n}"?([^A-Za-z0-9_]|$)`).test(text);
}

/** Direct dependencies of an element in its CPU: data types, blocks (instances, calls), interfaces */
export function elementDependencies(device: Device, kind: LibraryElementKind, name: string): string[] {
  const all = deviceElements(device);
  const self = all.find((e) => e.kind === kind && e.value.name === name);
  if (!self) return [];
  const text = textOf(self).replace(new RegExp(`"name":"${name.replace(/"/g, '')}"`, 'g'), '');
  const out: string[] = [];
  for (const e of all) {
    if (e === self || e.value.name === name) continue;
    // instance DBs and OBs are not library material
    if (e.kind === 'block' && (e.value.type === 'OB' || (e.value.type === 'DB' && e.value.instanceOf))) continue;
    if (mentions(text, e.value.name)) out.push(e.value.name);
  }
  return out;
}

/** Copies an element of a CPU (and, recursively, what it needs) into a library. */
export function addToLibrary(lib: Library, device: Device, kind: LibraryElementKind, name: string, opts: { category?: string; description?: string; author?: string } = {}): LibraryElement[] {
  const done = new Map<string, LibraryElement>();
  const all = deviceElements(device);
  const visit = (k: LibraryElementKind, n: string) => {
    if (done.has(n.toUpperCase())) return;
    const src = all.find((e) => e.kind === k && e.value.name === n);
    if (!src) return;
    const deps = elementDependencies(device, k, n);
    const existing = lib.elements.find((e) => e.name.toUpperCase() === n.toUpperCase());
    const copy = JSON.parse(JSON.stringify(src.value)) as Block & DataTypeDef & InterfaceDef;
    delete (copy as { library?: unknown }).library;
    const origin = src.value.library;
    const changed = !existing || JSON.stringify(existing[k === 'interface' ? 'iface' : k]) !== JSON.stringify(copy);
    const element: LibraryElement = {
      id: existing?.id ?? newId('le'),
      kind: k,
      name: src.value.name,
      version: existing ? (changed ? nextVersion(existing.version) : existing.version) : origin?.version ?? '1.0.0',
      category: n === name ? opts.category ?? existing?.category : existing?.category,
      description: n === name ? opts.description ?? existing?.description ?? src.value.comment : existing?.description ?? src.value.comment,
      author: opts.author ?? existing?.author,
      modified: changed || !existing ? new Date().toISOString() : existing.modified,
      dependencies: deps,
      ...(k === 'block' ? { block: copy as Block } : k === 'type' ? { type: copy as DataTypeDef } : { iface: copy as InterfaceDef }),
    };
    if (existing) lib.elements[lib.elements.indexOf(existing)] = element;
    else lib.elements.push(element);
    done.set(n.toUpperCase(), element);
    for (const d of deps) {
      const dep = all.find((e) => e.value.name === d);
      if (dep) visit(dep.kind, d);
    }
  };
  visit(kind, name);
  return [...done.values()];
}

export interface InsertResult {
  added: string[];
  updated: string[];
  unchanged: string[];
}

/**
 * Inserts an element and its dependencies into a CPU. An element of the same name is replaced
 * when `replace` is true (update to the library version), else kept (reported as unchanged).
 */
export function insertFromLibrary(device: Device, lib: Library, elementName: string, opts: { replace?: boolean } = {}): InsertResult {
  const result: InsertResult = { added: [], updated: [], unchanged: [] };
  const seen = new Set<string>();
  const visit = (n: string, top: boolean) => {
    const key = n.toUpperCase();
    if (seen.has(key)) return;
    seen.add(key);
    const e = lib.elements.find((x) => x.name.toUpperCase() === key);
    if (!e) return;
    for (const d of e.dependencies) visit(d, false);
    const origin: LibraryOrigin = { library: lib.name, element: e.id, version: e.version };
    const copy = JSON.parse(JSON.stringify(e.block ?? e.type ?? e.iface)) as Block & DataTypeDef & InterfaceDef;
    const replaceIt = opts.replace || top;
    if (e.kind === 'block') {
      const b = normalizeBlock(copy as Block);
      const existing = device.blocks.find((x) => x.name.toUpperCase() === key);
      if (existing && !replaceIt) { result.unchanged.push(e.name); return; }
      b.id = existing?.id ?? newId('blk');
      if (existing) b.number = existing.number;
      else if (device.blocks.some((x) => x.type === b.type && x.number === b.number)) b.number = Math.max(0, ...device.blocks.filter((x) => x.type === b.type).map((x) => x.number)) + 1;
      b.library = origin;
      if (existing) device.blocks[device.blocks.indexOf(existing)] = b;
      else device.blocks.push(b);
      (existing ? result.updated : result.added).push(e.name);
    } else if (e.kind === 'type') {
      const t = copy as DataTypeDef;
      const existing = device.types.find((x) => x.name.toUpperCase() === key);
      if (existing && !replaceIt) { result.unchanged.push(e.name); return; }
      t.id = existing?.id ?? newId('udt');
      t.library = origin;
      if (existing) device.types[device.types.indexOf(existing)] = t;
      else device.types.push(t);
      (existing ? result.updated : result.added).push(e.name);
    } else {
      const i = copy as InterfaceDef;
      const list = (device.interfaces ??= []);
      const existing = list.find((x) => x.name.toUpperCase() === key);
      if (existing && !replaceIt) { result.unchanged.push(e.name); return; }
      i.id = existing?.id ?? newId('ifc');
      i.library = origin;
      if (existing) list[list.indexOf(existing)] = i;
      else list.push(i);
      (existing ? result.updated : result.added).push(e.name);
    }
  };
  visit(elementName, true);
  return result;
}

/** Copies of the CPU made from an older version of an element of this library */
export function outdatedCopies(device: Device, lib: Library): Array<{ name: string; have: string; latest: string }> {
  const out: Array<{ name: string; have: string; latest: string }> = [];
  for (const x of [...device.blocks, ...device.types, ...(device.interfaces ?? [])]) {
    if (!x.library || x.library.library !== lib.name) continue;
    const e = lib.elements.find((el) => el.id === x.library!.element || el.name === x.name);
    if (e && compareVersions(x.library.version, e.version) < 0) out.push({ name: x.name, have: x.library.version, latest: e.version });
  }
  return out;
}

let standard: Library | null = null;

/** The VirtualPLC standard library as a (read-only) library */
export function standardLibrary(): Library {
  if (standard) return standard;
  const lib: Library = { format: LIBRARY_FORMAT, id: 'lib-virtualplc-standard', name: STANDARD_LIBRARY_NAME, readOnly: true, elements: [] };
  for (const s of STANDARD_LIBRARY) {
    const scratch = { blocks: [], types: [], interfaces: [], tagTables: [] } as unknown as Device;
    const r = importExternalSource(scratch, s.source, `${s.name}.scl`);
    for (const b of r.blocks) {
      lib.elements.push({
        id: `std-${b.name}`, kind: 'block', name: b.name, version: STANDARD_LIBRARY_VERSION, category: s.category,
        description: s.description, author: 'VirtualPLC', modified: '2026-01-01T00:00:00.000Z', dependencies: [], block: b,
      });
    }
    for (const t of r.types) {
      lib.elements.push({
        id: `std-${t.name}`, kind: 'type', name: t.name, version: STANDARD_LIBRARY_VERSION, category: s.category,
        description: s.description, author: 'VirtualPLC', modified: '2026-01-01T00:00:00.000Z', dependencies: [], type: t,
      });
    }
  }
  // dependencies between standard elements (e.g. a sequencer using a type)
  const scratch = { blocks: lib.elements.flatMap((e) => (e.block ? [e.block] : [])), types: lib.elements.flatMap((e) => (e.type ? [e.type] : [])), interfaces: [] } as unknown as Device;
  for (const e of lib.elements) e.dependencies = elementDependencies(scratch, e.kind, e.name);
  standard = lib;
  return lib;
}
