// Project folder layout: one file per object, so that projects can be versioned with
// Git, compared line by line and merged when several engineers work on them.
//
//   <Project>.vplcproj                    manifest (name, author, comment, creation date)
//   devices/<Device>/device.json          CPU settings, connection, I/O modules
//   devices/<Device>/blocks/<Block>.json  block properties and interface
//   devices/<Device>/blocks/<Block>.scl   block code (SCL statements)
//   devices/<Device>/tags/<Table>.json    PLC tag table
//   devices/<Device>/watch/<Table>.json   watch table
//   .gitattributes, .gitignore
//
// The manifest carries no modification date: Git keeps the history, and a date that
// changes on every save would make every merge conflict.
import {
  emptyInterface, PROJECT_FORMAT, PROJECT_VERSION,
  type Block, type Device, type Project, type TagTable, type WatchTable,
} from './project.ts';

export const MANIFEST_EXT = '.vplcproj';

/** Path (with '/' separators, relative to the project folder) → file content. */
export type ProjectFiles = Record<string, string>;

export interface FolderManifest {
  format: typeof PROJECT_FORMAT;
  version: number;
  layout: 'folder';
  name: string;
  author?: string;
  comment?: string;
  created: string;
}

export const GITATTRIBUTES = '# Project files are text with LF line endings on every platform\n* text=auto eol=lf\n';
export const GITIGNORE = '# VirtualPLC Studio\n*.bak\n*.tmp\n.DS_Store\nThumbs.db\n';

/** Is this manifest text a folder project (as opposed to a single-file project)? */
export function isFolderManifest(text: string): boolean {
  try {
    const m = JSON.parse(text) as Partial<FolderManifest>;
    return m?.format === PROJECT_FORMAT && m.layout === 'folder';
  } catch {
    return false;
  }
}

/** File-system safe name (also safe on Windows), without changing readable names. */
export function safeFileName(name: string): string {
  let s = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s || /^\.+/.test(s)) s = `_${s}`;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = `_${s}`;
  return s.slice(0, 100);
}

/** Gives each object a unique file name (case-insensitive, as on Windows and macOS). */
function uniqueNames<T>(items: T[], nameOf: (x: T) => string): Map<T, string> {
  const used = new Set<string>();
  const out = new Map<T, string>();
  for (const item of items) {
    const base = safeFileName(nameOf(item));
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}_${i}`;
    used.add(name.toLowerCase());
    out.set(item, name);
  }
  return out;
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/** Copies the listed keys in a fixed order, leaving out undefined values (stable files). */
function pick<T extends object>(obj: T, keys: Array<keyof T>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const BLOCK_ORDER = { OB: 0, FB: 1, FC: 2, DB: 3 } as const;

export function projectToFiles(project: Project): ProjectFiles {
  const files: ProjectFiles = {};
  const manifest: FolderManifest = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION, layout: 'folder', name: project.name,
    ...(project.author ? { author: project.author } : {}),
    ...(project.comment ? { comment: project.comment } : {}),
    created: project.created,
  };
  files[`${safeFileName(project.name)}${MANIFEST_EXT}`] = json(manifest);
  files['.gitattributes'] = GITATTRIBUTES;
  files['.gitignore'] = GITIGNORE;

  const deviceNames = uniqueNames(project.devices, (d) => d.name);
  for (const d of project.devices) {
    const dir = `devices/${deviceNames.get(d)}`;
    files[`${dir}/device.json`] = json(pick(d, ['id', 'name', 'type', 'comment', 'cpu', 'connection', 'io']));
    const blocks = [...d.blocks].sort((a, b) => BLOCK_ORDER[a.type] - BLOCK_ORDER[b.type] || a.number - b.number);
    const blockNames = uniqueNames(blocks, (b) => b.name);
    for (const b of blocks) {
      const base = `${dir}/blocks/${blockNames.get(b)}`;
      files[`${base}.json`] = json(pick(b, ['id', 'name', 'type', 'number', 'comment', 'event', 'returnType', 'instanceOf', 'interface', 'members']));
      if (b.type !== 'DB') files[`${base}.scl`] = b.code.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
    }
    const tagNames = uniqueNames(d.tagTables, (t) => t.name);
    for (const t of d.tagTables) files[`${dir}/tags/${tagNames.get(t)}.json`] = json(pick(t, ['id', 'name', 'tags', 'constants']));
    const watchNames = uniqueNames(d.watchTables, (t) => t.name);
    for (const t of d.watchTables) files[`${dir}/watch/${watchNames.get(t)}.json`] = json(pick(t, ['id', 'name', 'rows']));
  }
  return files;
}

/** Folders written by projectToFiles (files below them that are not in the project any more are stale). */
export function isManagedPath(path: string): boolean {
  return /^devices\/[^/]+\/(device\.json|(blocks|tags|watch)\/[^/]+\.(json|scl))$/.test(path) || /^[^/]+\.vplcproj$/.test(path);
}

function parseJson<T>(files: ProjectFiles, path: string): T {
  try {
    return JSON.parse(files[path]) as T;
  } catch (e) {
    const conflict = /^(<<<<<<<|=======|>>>>>>>)/m.test(files[path] ?? '');
    throw new Error(conflict
      ? `${path}: unresolved merge conflict`
      : `${path}: invalid file (${(e as Error).message})`);
  }
}

export function projectFromFiles(files: ProjectFiles): Project {
  const manifests = Object.keys(files).filter((p) => /^[^/]+\.vplcproj$/.test(p));
  if (manifests.length !== 1) throw new Error(manifests.length ? 'Several project files (.vplcproj) in the folder' : 'No project file (.vplcproj) in the folder');
  const m = parseJson<Partial<FolderManifest>>(files, manifests[0]);
  if (m.format !== PROJECT_FORMAT || m.layout !== 'folder') throw new Error('The file is not a VirtualPLC project folder');
  if (typeof m.version !== 'number' || m.version > PROJECT_VERSION) throw new Error('This project was created by a newer version of VirtualPLC Studio');

  const byDevice = new Map<string, string[]>();
  for (const path of Object.keys(files)) {
    const dm = /^devices\/([^/]+)\//.exec(path);
    if (!dm) continue;
    if (!byDevice.has(dm[1])) byDevice.set(dm[1], []);
    byDevice.get(dm[1])!.push(path);
  }
  const devices: Device[] = [];
  for (const [dirName, paths] of [...byDevice].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dir = `devices/${dirName}`;
    if (!files[`${dir}/device.json`]) continue;
    const d = parseJson<Device>(files, `${dir}/device.json`);
    d.io ??= [];
    d.cpu ??= { cycleMs: 10 };
    d.connection ??= { host: '192.168.0.10', port: 20105 };
    const inDir = (sub: string, ext: string) => paths.filter((p) => p.startsWith(`${dir}/${sub}/`) && p.endsWith(ext) && !p.slice(dir.length + sub.length + 2).includes('/'));

    d.blocks = inDir('blocks', '.json').map((p) => {
      const b = parseJson<Block>(files, p);
      b.interface = { ...emptyInterface(), ...(b.interface ?? {}) };
      const code = files[p.replace(/\.json$/, '.scl')];
      if (code !== undefined && /^(<<<<<<<|>>>>>>>) /m.test(code)) throw new Error(`${p.replace(/\.json$/, '.scl')}: unresolved merge conflict`);
      b.code = b.type === 'DB' ? '' : (code ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
      return b;
    }).sort((a, b) => BLOCK_ORDER[a.type] - BLOCK_ORDER[b.type] || a.number - b.number || a.name.localeCompare(b.name));

    d.tagTables = inDir('tags', '.json').map((p) => {
      const t = parseJson<TagTable>(files, p);
      t.tags ??= [];
      t.constants ??= [];
      return t;
    }).sort((a, b) => Number(isStandardTable(b)) - Number(isStandardTable(a)) || a.name.localeCompare(b.name));

    d.watchTables = inDir('watch', '.json').map((p) => {
      const t = parseJson<WatchTable>(files, p);
      t.rows ??= [];
      return t;
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    devices.push(d);
  }
  if (!devices.length) throw new Error('Invalid project: no devices');
  return {
    format: PROJECT_FORMAT, version: PROJECT_VERSION, name: m.name ?? manifests[0].replace(/\.vplcproj$/, ''),
    ...(m.author ? { author: m.author } : {}), ...(m.comment ? { comment: m.comment } : {}),
    created: m.created ?? new Date().toISOString(), modified: new Date().toISOString(), devices,
  };
}

function isStandardTable(t: TagTable): boolean {
  return /^(table de variables standard|default tag table)$/i.test(t.name);
}
