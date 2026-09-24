// VirtualPLC Studio project model (.vplcproj) and its compilation.
import type { Diagnostic } from './diagnostics.ts';
import { compile, type CompileResult } from './compiler.ts';
import type { IoModuleConfig } from './image.ts';
import { parse, parseAddress } from './parser.ts';
import type { TypeRef, Expr } from './ast.ts';

export const PROJECT_FORMAT = 'virtualplc-project';
export const PROJECT_VERSION = 1;

export type DeviceType = 'linux' | 'esp32' | 'arduino';
export type BlockType = 'OB' | 'FC' | 'FB' | 'DB';

export interface Member {
  name: string;
  dataType: string;
  defaultValue?: string;
  comment?: string;
}

export interface BlockInterface {
  input: Member[];
  output: Member[];
  inout: Member[];
  static: Member[];
  temp: Member[];
  constant: Member[];
}

export interface Block {
  id: string;
  name: string;
  type: BlockType;
  number: number;
  comment?: string;
  /** OB event class */
  event?: 'ProgramCycle' | 'Startup';
  /** FC return type ('Void' = none) */
  returnType?: string;
  interface: BlockInterface;
  /** SCL statements (body between BEGIN and END_xxx) */
  code: string;
  /** DB: instance of this function block (instance DB) */
  instanceOf?: string;
  /** Global DB: variables */
  members?: Member[];
}

export interface Tag {
  name: string;
  dataType: string;
  /** %I0.0, %QW2, %MD10 … ; empty = optimized memory */
  address: string;
  comment?: string;
}

export interface UserConstant {
  name: string;
  dataType: string;
  value: string;
  comment?: string;
}

export interface TagTable {
  id: string;
  name: string;
  tags: Tag[];
  constants: UserConstant[];
}

export interface WatchRow {
  /** Tag path ("Motor_DB".Running) or address (%I0.0) */
  name: string;
  format?: 'auto' | 'bool' | 'dec' | 'hex' | 'bin' | 'float' | 'time' | 'string';
  modifyValue?: string;
  comment?: string;
}

export interface WatchTable {
  id: string;
  name: string;
  rows: WatchRow[];
}

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  comment?: string;
  cpu: { cycleMs: number };
  connection: { host: string; port: number };
  io: IoModuleConfig[];
  tagTables: TagTable[];
  blocks: Block[];
  watchTables: WatchTable[];
}

export interface Project {
  format: typeof PROJECT_FORMAT;
  version: number;
  name: string;
  author?: string;
  comment?: string;
  created: string;
  modified: string;
  devices: Device[];
}

export const DEVICE_TYPES: Record<DeviceType, { label: string; order: string; description: string; maxProgram: number; gpio: boolean }> = {
  linux: { label: 'CPU VirtualPLC Linux', order: '', description: 'Linux PC, Raspberry Pi, industrial PC — Modbus TCP remote I/O, GPIO', maxProgram: 1 << 20, gpio: true },
  esp32: { label: 'CPU VirtualPLC ESP32', order: '', description: 'ESP32 — Wi-Fi, GPIO, analog inputs', maxProgram: 64 << 10, gpio: true },
  arduino: { label: 'CPU VirtualPLC Arduino', order: '', description: 'Arduino Mega / Due / Opta / Portenta — USB serial, GPIO', maxProgram: 16 << 10, gpio: true },
};

let idCounter = 0;
export function newId(prefix = 'id'): string {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function emptyInterface(): BlockInterface {
  return { input: [], output: [], inout: [], static: [], temp: [], constant: [] };
}

export function newDevice(type: DeviceType, name = 'PLC_1'): Device {
  return {
    id: newId('dev'),
    name,
    type,
    cpu: { cycleMs: 10 },
    connection: { host: type === 'arduino' ? 'serial' : '192.168.0.10', port: 20105 },
    io: [],
    tagTables: [{ id: newId('tt'), name: 'Table de variables standard', tags: [], constants: [] }],
    blocks: [
      {
        id: newId('blk'), name: 'Main', type: 'OB', number: 1, event: 'ProgramCycle',
        comment: 'Main Program Sweep (Cycle)', interface: emptyInterface(), code: '',
      },
    ],
    watchTables: [{ id: newId('wt'), name: 'Table de visualisation_1', rows: [] }],
  };
}

export function newProject(name: string, deviceType: DeviceType = 'linux'): Project {
  const now = new Date().toISOString();
  return { format: PROJECT_FORMAT, version: PROJECT_VERSION, name, created: now, modified: now, devices: [newDevice(deviceType)] };
}

/** Validates the structure of a loaded project file (throws with a readable message). */
export function loadProject(json: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('The file is not a valid project (invalid JSON)');
  }
  const p = data as Partial<Project>;
  if (!p || p.format !== PROJECT_FORMAT) {
    // Historical PHP VirtualPLC project?
    if (p && typeof p === 'object' && 'vars' in p && 'blocks' in p) return importLegacyProject(p as unknown as LegacyProject);
    throw new Error('The file is not a VirtualPLC project');
  }
  if (typeof p.version !== 'number' || p.version > PROJECT_VERSION) throw new Error('This project was created by a newer version of VirtualPLC Studio');
  if (!Array.isArray(p.devices)) throw new Error('Invalid project: no devices');
  for (const d of p.devices) {
    d.io ??= [];
    d.tagTables ??= [];
    d.blocks ??= [];
    d.watchTables ??= [];
    d.cpu ??= { cycleMs: 10 };
    d.connection ??= { host: '192.168.0.10', port: 20105 };
    for (const b of d.blocks) b.interface = { ...emptyInterface(), ...(b.interface ?? {}) };
  }
  return p as Project;
}

export function saveProject(project: Project): string {
  project.modified = new Date().toISOString();
  return JSON.stringify(project, null, 2) + '\n';
}

export function blockLabel(b: Block): string {
  return `${b.name} [${b.type}${b.number}]`;
}

/** First free number for a block type (user OBs start at 123). */
export function nextBlockNumber(device: Device, type: BlockType): number {
  const used = new Set(device.blocks.filter((b) => b.type === type).map((b) => b.number));
  let n = type === 'OB' ? 123 : 1;
  while (used.has(n)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Source generation
// ---------------------------------------------------------------------------

const q = (name: string) => `"${name}"`;

function memberLine(m: Member): string {
  const init = m.defaultValue !== undefined && m.defaultValue.trim() !== '' ? ` := ${m.defaultValue.trim()}` : '';
  const comment = m.comment ? `   // ${m.comment.replace(/[\r\n]+/g, ' ')}` : '';
  return `      ${m.name} : ${m.dataType}${init};${comment}`;
}

function section(keyword: string, members: Member[]): string[] {
  if (members.length === 0) return [];
  return [`   ${keyword}`, ...members.map(memberLine), '   END_VAR'];
}

export interface GeneratedSource {
  file: string;
  text: string;
  /** Block the source belongs to (null for tag tables) */
  blockId: string | null;
  tagTableId: string | null;
  /** Line of the source where the user code starts (1-based) */
  codeLine: number;
}

/** Generates the SCL external source of a block. */
export function blockSource(b: Block): GeneratedSource {
  const lines: string[] = [];
  const i = b.interface;
  const header = (kw: string, extra = '') => {
    lines.push(`${kw} ${q(b.name)}${extra}`);
    lines.push('VERSION : 0.1');
  };
  switch (b.type) {
    case 'DB':
      header('DATA_BLOCK');
      if (b.instanceOf) {
        lines.push(q(b.instanceOf));
      } else {
        lines.push(...section('VAR', b.members ?? []));
      }
      lines.push('BEGIN', 'END_DATA_BLOCK');
      return { file: b.name, text: lines.join('\n') + '\n', blockId: b.id, tagTableId: null, codeLine: 0 };
    case 'OB':
      header('ORGANIZATION_BLOCK');
      lines.push(...section('VAR_TEMP', i.temp), ...section('VAR CONSTANT', i.constant));
      break;
    case 'FC':
      header('FUNCTION', ` : ${b.returnType && b.returnType.trim() !== '' ? b.returnType : 'Void'}`);
      lines.push(...section('VAR_INPUT', i.input), ...section('VAR_OUTPUT', i.output), ...section('VAR_IN_OUT', i.inout),
        ...section('VAR_TEMP', i.temp), ...section('VAR CONSTANT', i.constant));
      break;
    case 'FB':
      header('FUNCTION_BLOCK');
      lines.push(...section('VAR_INPUT', i.input), ...section('VAR_OUTPUT', i.output), ...section('VAR_IN_OUT', i.inout),
        ...section('VAR', i.static), ...section('VAR_TEMP', i.temp), ...section('VAR CONSTANT', i.constant));
      break;
  }
  lines.push('BEGIN');
  const codeLine = lines.length + 1;
  lines.push(b.code.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
  lines.push(b.type === 'OB' ? 'END_ORGANIZATION_BLOCK' : b.type === 'FC' ? 'END_FUNCTION' : 'END_FUNCTION_BLOCK');
  return { file: b.name, text: lines.join('\n') + '\n', blockId: b.id, tagTableId: null, codeLine };
}

export function tagTableSource(t: TagTable): GeneratedSource {
  const lines: string[] = [];
  if (t.tags.length) {
    lines.push('VAR_GLOBAL');
    for (const tag of t.tags) {
      const at = tag.address.trim() ? ` AT ${tag.address.trim()}` : '';
      lines.push(`   ${q(tag.name)}${at} : ${tag.dataType};${tag.comment ? `   // ${tag.comment.replace(/[\r\n]+/g, ' ')}` : ''}`);
    }
    lines.push('END_VAR');
  }
  if (t.constants.length) {
    lines.push('VAR_GLOBAL CONSTANT');
    for (const c of t.constants) lines.push(`   ${q(c.name)} : ${c.dataType} := ${c.value};`);
    lines.push('END_VAR');
  }
  return { file: t.name, text: lines.join('\n') + '\n', blockId: null, tagTableId: t.id, codeLine: 0 };
}

export interface ProjectDiagnostic extends Diagnostic {
  blockId?: string;
  tagTableId?: string;
  /** Line in the block's code editor (1-based), when the error is in the code */
  codeLine?: number;
  /** "Interface" when the error is in the block interface / declarations */
  location?: 'code' | 'interface' | 'tags';
}

export interface ProjectCompileResult extends Omit<CompileResult, 'diagnostics'> {
  diagnostics: ProjectDiagnostic[];
  sources: GeneratedSource[];
}

/** Validates names and addresses that the generated sources rely on. */
function checkDevice(device: Device): ProjectDiagnostic[] {
  const out: ProjectDiagnostic[] = [];
  const nameRe = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const quotedRe = /^[^"\r\n]+$/;
  for (const t of device.tagTables) {
    for (const tag of t.tags) {
      if (!quotedRe.test(tag.name)) out.push({ severity: 'error', message: `Invalid tag name "${tag.name}"`, tagTableId: t.id, location: 'tags', file: t.name });
      if (tag.address.trim() && !parseAddress(tag.address)) out.push({ severity: 'error', message: `Invalid address '${tag.address}' of tag "${tag.name}" (e.g. %I0.0, %QW2, %MD10)`, tagTableId: t.id, location: 'tags', file: t.name });
    }
  }
  for (const b of device.blocks) {
    if (!quotedRe.test(b.name)) out.push({ severity: 'error', message: `Invalid block name "${b.name}"`, blockId: b.id, file: b.name });
    for (const [kind, members] of Object.entries(b.interface)) {
      for (const m of members as Member[]) {
        if (!nameRe.test(m.name)) out.push({ severity: 'error', message: `Invalid name '${m.name}' in ${kind} of "${b.name}" (letters, digits and _)`, blockId: b.id, location: 'interface', file: b.name });
      }
    }
  }
  return out;
}

export function compileDevice(project: Project, device: Device): ProjectCompileResult {
  const sources = [...device.tagTables.map(tagTableSource), ...device.blocks.map(blockSource)];
  const pre = checkDevice(device);
  const main = device.blocks.find((b) => b.type === 'OB' && (b.event ?? 'ProgramCycle') === 'ProgramCycle');
  const startup = device.blocks.find((b) => b.type === 'OB' && b.event === 'Startup');
  const result = pre.some((d) => d.severity === 'error')
    ? { ok: false, diagnostics: [], symbols: [], functions: [], stats: { code: 0, data: 0, constants: 0, inputs: 0, outputs: 0, memory: 0 } } as CompileResult
    : compile({
      sources: sources.map((s) => ({ file: s.file, text: s.text })),
      name: `${project.name}/${device.name}`.slice(0, 32),
      hardware: device.io,
      cycleMs: device.cpu.cycleMs,
      mainOb: main?.name,
      startupOb: startup?.name,
    });
  const byFile = new Map(sources.map((s) => [s.file.toUpperCase(), s]));
  const diagnostics: ProjectDiagnostic[] = [...pre, ...result.diagnostics.map((d) => {
    const src = d.file ? byFile.get(d.file.toUpperCase()) : undefined;
    const pd: ProjectDiagnostic = { ...d };
    if (src?.blockId) {
      pd.blockId = src.blockId;
      if (d.line && src.codeLine && d.line >= src.codeLine) {
        pd.location = 'code';
        pd.codeLine = d.line - src.codeLine + 1;
      } else {
        pd.location = 'interface';
      }
    } else if (src?.tagTableId) {
      pd.tagTableId = src.tagTableId;
      pd.location = 'tags';
    }
    return pd;
  })];
  return { ...result, ok: result.ok && !diagnostics.some((d) => d.severity === 'error'), diagnostics, sources };
}

// ---------------------------------------------------------------------------
// Import of SCL external sources
// ---------------------------------------------------------------------------

function typeText(t: TypeRef): string {
  if (t.name === 'ARRAY') return `Array[${t.low}..${t.high}] of ${typeText(t.element!)}`;
  if (t.name === 'STRING') return t.length && t.length !== 32 ? `String[${t.length}]` : 'String';
  return /^[A-Z_]+$/.test(t.name) && ['BOOL', 'BYTE', 'WORD', 'DWORD', 'SINT', 'USINT', 'INT', 'UINT', 'DINT', 'UDINT', 'LINT', 'REAL', 'LREAL', 'TIME'].includes(t.name)
    ? t.name[0] + t.name.slice(1).toLowerCase()
    : /^[A-Za-z_]\w*$/.test(t.name) && ['TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG'].includes(t.name.toUpperCase()) ? t.name.toUpperCase() : `"${t.name}"`;
}

function exprText(e: Expr | null): string | undefined {
  if (!e) return undefined;
  switch (e.kind) {
    case 'int': return String(e.value);
    case 'real': return Number.isInteger(e.value) ? e.value.toFixed(1) : String(e.value);
    case 'bool': return e.value ? 'TRUE' : 'FALSE';
    case 'string': return `'${e.value.replace(/\$/g, '$$').replace(/'/g, "$'")}'`;
    case 'time': return `T#${e.value}MS`;
    case 'var': return e.scope === 'global' ? `"${e.name}"` : e.name;
    case 'unary': return `${e.op === 'NOT' ? 'NOT ' : '-'}${exprText(e.operand)}`;
    default: return undefined;
  }
}

/** Creates blocks and tags from an SCL external source (.scl). */
export function importExternalSource(device: Device, text: string, file = 'source.scl'): { blocks: Block[]; tags: Tag[] } {
  const program = parse(text, file);
  const blocks: Block[] = [];
  const bodyOf = (kind: string, name: string): string => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${kind}\\s+"?${esc}"?[\\s\\S]*?\\n\\s*BEGIN[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?\\s*END_${kind}`, 'i');
    const m = re.exec(text);
    if (!m) return '';
    const lines = m[1].replace(/\s+$/, '').split(/\r?\n/);
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
    return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
  };
  const members = (vars: Array<{ name: string; type: TypeRef; initial: Expr | null; section: string }>, section: string): Member[] =>
    vars.filter((v) => v.section === section).map((v) => ({ name: v.name, dataType: typeText(v.type), defaultValue: exprText(v.initial) }));

  for (const pou of program.pous) {
    const type: BlockType = pou.kind === 'ORGANIZATION_BLOCK' ? 'OB' : pou.kind === 'FUNCTION' ? 'FC' : 'FB';
    const kind = pou.kind;
    const isStartup = type === 'OB' && ['STARTUP', 'OB100'].includes(pou.name.toUpperCase());
    blocks.push({
      id: newId('blk'),
      name: pou.name,
      type,
      number: 0,
      event: type === 'OB' ? (isStartup ? 'Startup' : 'ProgramCycle') : undefined,
      returnType: type === 'FC' ? (pou.returnType ? typeText(pou.returnType) : 'Void') : undefined,
      interface: {
        input: members(pou.vars, 'input'),
        output: members(pou.vars, 'output'),
        inout: members(pou.vars, 'inout'),
        static: members(pou.vars, 'static'),
        temp: members(pou.vars, 'temp'),
        constant: members(pou.vars, 'constant'),
      },
      code: bodyOf(kind, pou.name),
    });
  }
  for (const db of program.dataBlocks) {
    blocks.push({
      id: newId('blk'), name: db.name, type: 'DB', number: 0, interface: emptyInterface(), code: '',
      instanceOf: db.instanceOf ?? undefined,
      members: db.instanceOf ? undefined : db.fields.map((f) => ({ name: f.name, dataType: typeText(f.type), defaultValue: exprText(f.initial) })),
    });
  }
  const tags: Tag[] = program.vars.filter((v) => v.section === 'global').map((v) => ({
    name: v.name,
    dataType: typeText(v.type).replace(/^"|"$/g, ''),
    address: v.address ? `%${v.address.area}${v.address.size === 'X' ? `${v.address.byte}.${v.address.bit}` : `${v.address.size}${v.address.byte}`}` : '',
  }));
  const numbered: Block[] = [...device.blocks];
  const free = (type: BlockType, wanted: number) => !numbered.some((x) => x.type === type && x.number === wanted);
  for (const b of blocks) {
    const preferred = b.type === 'OB' ? (b.event === 'Startup' ? 100 : 1) : 0;
    b.number = preferred && free(b.type, preferred) ? preferred : nextBlockNumber({ ...device, blocks: numbered }, b.type);
    numbered.push(b);
  }
  return { blocks, tags };
}

// ---------------------------------------------------------------------------
// Import of historical (PHP) VirtualPLC projects
// ---------------------------------------------------------------------------

export interface LegacyProject {
  hardware?: Array<{ name: string; ip: string; port: number | string; slave: number | string }>;
  vars?: Array<{ name: string; mode: string; type: string; device?: string; io?: string; addr?: number | string }>;
  db?: Array<{ name: string; val: string }>;
  blocks?: Array<{ name: string; code: string }>;
  fc?: string;
}

export function importLegacyProject(legacy: LegacyProject, name = 'Imported project'): Project {
  const project = newProject(name, 'linux');
  const device = project.devices[0];
  const table = device.tagTables[0];
  // One Modbus TCP module per device, with its own %I / %Q bytes
  let nextIn = 0;
  let nextOut = 0;
  const moduleBytes = new Map<string, { i: number; q: number }>();
  for (const h of legacy.hardware ?? []) {
    const bindings = (legacy.vars ?? []).filter((v) => v.mode === 'binding' && v.device === h.name);
    const maxIn = Math.max(-1, ...bindings.filter((v) => v.io === 'INPUT').map((v) => Number(v.addr ?? 0)));
    const maxOut = Math.max(-1, ...bindings.filter((v) => v.io !== 'INPUT').map((v) => Number(v.addr ?? 0)));
    const inBytes = Math.max(1, Math.ceil((maxIn + 1) / 8));
    const outBytes = Math.max(1, Math.ceil((maxOut + 1) / 8));
    moduleBytes.set(h.name.toUpperCase(), { i: nextIn, q: nextOut });
    device.io.push({
      kind: 'modbus-tcp', name: h.name, host: String(h.ip), port: Number(h.port) || 502, unit: Number(h.slave) || 1,
      di: { byte: nextIn, count: inBytes * 8 }, coils: { byte: nextOut, count: outBytes * 8 },
    });
    nextIn += inBytes;
    nextOut += outBytes;
  }
  for (const v of legacy.vars ?? []) {
    if (v.mode === 'binding' && v.device) {
      const base = moduleBytes.get(v.device.toUpperCase()) ?? { i: 0, q: 0 };
      const n = Number(v.addr ?? 0);
      const byte = (v.io === 'INPUT' ? base.i : base.q) + Math.floor(n / 8);
      table.tags.push({ name: v.name, dataType: 'Bool', address: `%${v.io === 'INPUT' ? 'I' : 'Q'}${byte}.${n % 8}`, comment: `${v.device}.${v.io}.${n}` });
    } else {
      table.tags.push({ name: v.name, dataType: v.type === 'INT' ? 'Int' : 'Bool', address: '' });
    }
  }
  const clean = (code: string) => code.replace(/^\s*DISCONNECT_ALL\s*\(\s*\)\s*;\s*$/gim, '// DISCONNECT_ALL(); (outputs are switched off automatically in STOP)');
  let number = 1;
  for (const b of legacy.blocks ?? []) {
    device.blocks.push({ id: newId('blk'), name: b.name, type: 'FC', number: number++, returnType: 'Void', interface: emptyInterface(), code: clean(b.code ?? '') });
  }
  device.blocks[0].code = clean(legacy.fc ?? '');
  if ((legacy.db ?? []).length) {
    device.blocks.push({
      id: newId('blk'), name: 'Startup', type: 'OB', number: 100, event: 'Startup', comment: 'Start values (imported)',
      interface: emptyInterface(), code: (legacy.db ?? []).map((d) => `"${d.name}" := ${d.val};`).join('\n'),
    });
  }
  return project;
}
