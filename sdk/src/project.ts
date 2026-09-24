// VirtualPLC Studio project model (.vplcproj) and its compilation.
import type { Diagnostic } from './diagnostics.ts';
import { compile, type CompileResult } from './compiler.ts';
import type { IoModuleConfig, ServicesConfig } from './image.ts';
import { parse, parseAddress } from './parser.ts';
import { TYPE_DISPLAY, type Elementary } from './types.ts';
import { formatTemporal, type TemporalType } from './literals.ts';
import type { TypeRef, Expr, Method, TextRange, VarDecl } from './ast.ts';
import { ladderToScl, LadderError, ladElementFor, type LadNetwork } from './ladder.ts';
import type { DataLog } from './datalog.ts';

export const PROJECT_FORMAT = 'virtualplc-project';
export const PROJECT_VERSION = 1;

export type DeviceType = 'linux' | 'esp32' | 'arduino';
export type BlockType = 'OB' | 'FC' | 'FB' | 'DB';

export interface Member {
  name: string;
  dataType: string;
  defaultValue?: string;
  comment?: string;
  /** Members of an anonymous structure (dataType 'Struct') */
  members?: Member[];
  /** Accessible from HMI / OPC UA (default true) */
  hmiVisible?: boolean;
  /** Writable from HMI / OPC UA (default true) */
  hmiWritable?: boolean;
}

/** PLC data type (UDT) */
export interface DataTypeDef {
  id: string;
  name: string;
  comment?: string;
  members: Member[];
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
  /** Programming language of the code (default SCL) */
  language?: 'SCL' | 'LAD';
  /** SCL statements (body between BEGIN and END_xxx) */
  code: string;
  /** LAD blocks: networks (the SCL code is generated from them) */
  networks?: LadNetwork[];
  /** DB: instance of this function block (instance DB) */
  instanceOf?: string;
  /** Global DB: variables */
  members?: Member[];
  /** FB: object orientation (IEC 61131-3 ed.3) */
  extends?: string;
  implements?: string[];
  abstract?: boolean;
  final?: boolean;
  methods?: BlockMethod[];
}

export type MethodAccess = 'PUBLIC' | 'PRIVATE' | 'PROTECTED' | 'INTERNAL';

/** Method of a function block, or method prototype of an interface */
export interface BlockMethod {
  id: string;
  name: string;
  /** 'Void' (or empty) = no return value */
  returnType?: string;
  access?: MethodAccess;
  abstract?: boolean;
  final?: boolean;
  override?: boolean;
  comment?: string;
  /** input / output / inout / temp / constant (static is not used) */
  interface: BlockInterface;
  /** SCL statements */
  code: string;
}

/** Interface (IEC 61131-3 ed.3): method prototypes implemented by function blocks */
export interface InterfaceDef {
  id: string;
  name: string;
  comment?: string;
  extends?: string[];
  methods: BlockMethod[];
}

export interface Tag {
  name: string;
  dataType: string;
  /** %I0.0, %QW2, %MD10 … ; empty = optimized memory */
  address: string;
  comment?: string;
  /** Accessible from HMI / OPC UA (default true) */
  hmiVisible?: boolean;
  /** Writable from HMI / OPC UA (default true) */
  hmiWritable?: boolean;
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
  /** PLC data types (UDT) */
  types: DataTypeDef[];
  /** Interfaces (object-oriented programming) */
  interfaces?: InterfaceDef[];
  /** Traceability: data logs written by the CPU to its database */
  dataLogs?: DataLog[];
  /** OPC UA server and S7 communication (HMI / SCADA access) */
  services?: ServicesConfig;
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

export const DEVICE_TYPES: Record<DeviceType, { label: string; description: string; maxProgram: number; gpio: boolean }> = {
  linux: { label: 'CPU VirtualPLC Linux', description: 'Linux PC, Raspberry Pi, industrial PC — Modbus TCP remote I/O, GPIO', maxProgram: 1 << 20, gpio: true },
  esp32: { label: 'CPU VirtualPLC ESP32', description: 'ESP32 — Wi-Fi or USB, GPIO, analog inputs and outputs (firmware/VirtualPLC)', maxProgram: 64 << 10, gpio: true },
  arduino: { label: 'CPU VirtualPLC Arduino', description: 'Raspberry Pi Pico (W), Arduino Uno R4, Due, Portenta… — USB (or Wi-Fi), GPIO (firmware/VirtualPLC)', maxProgram: 7 << 10, gpio: true },
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
    connection: type === 'arduino' ? { host: 'COM3', port: 115200 } : { host: '192.168.0.10', port: 20105 },
    io: [],
    tagTables: [{ id: newId('tt'), name: 'Table de variables standard', tags: [], constants: [] }],
    blocks: [
      {
        id: newId('blk'), name: 'Main', type: 'OB', number: 1, event: 'ProgramCycle',
        comment: 'Main Program Sweep (Cycle)', interface: emptyInterface(), code: '',
      },
    ],
    watchTables: [{ id: newId('wt'), name: 'Table de visualisation_1', rows: [] }],
    types: [],
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
    d.types ??= [];
    d.cpu ??= { cycleMs: 10 };
    d.connection ??= { host: '192.168.0.10', port: 20105 };
    for (const b of d.blocks) normalizeBlock(b);
    for (const i of d.interfaces ?? []) {
      i.methods ??= [];
      for (const m of i.methods) normalizeMethod(m);
    }
  }
  return p as Project;
}

export function normalizeMethod(m: BlockMethod): BlockMethod {
  m.interface = { ...emptyInterface(), ...(m.interface ?? {}) };
  m.code ??= '';
  return m;
}

export function normalizeBlock(b: Block): Block {
  b.interface = { ...emptyInterface(), ...(b.interface ?? {}) };
  for (const m of b.methods ?? []) normalizeMethod(m);
  return b;
}

export function newMethod(name: string): BlockMethod {
  return { id: newId('mth'), name, returnType: 'Void', interface: emptyInterface(), code: '' };
}

export function saveProject(project: Project): string {
  project.modified = new Date().toISOString();
  return JSON.stringify(project, null, 2) + '\n';
}

/** One input or output provided by an I/O module of the device configuration */
export interface IoChannel {
  address: string;
  area: 'I' | 'Q';
  dataType: 'Bool' | 'Int' | 'Byte';
  /** Module name */
  module: string;
  /** What the channel is on the module (GPIO pin, register...) */
  detail: string;
  /** Tag name proposed when tags are created from the module */
  name: string;
}

const MAX_CHANNELS_PER_RANGE = 256;

/** The addresses %I / %Q that the configured I/O modules read or write, in module order. */
export function ioChannels(device: Device): IoChannel[] {
  const out: IoChannel[] = [];
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
  const bits = (m: IoModuleConfig, area: 'I' | 'Q', byte: number, count: number, what: string, prefix: string) => {
    for (let k = 0; k < Math.min(count, MAX_CHANNELS_PER_RANGE); k++) {
      out.push({ address: `%${area}${byte + (k >> 3)}.${k & 7}`, area, dataType: 'Bool', module: m.name, detail: `${what} ${k}`, name: `${clean(m.name)}_${prefix}${k}` });
    }
  };
  const words = (m: IoModuleConfig, area: 'I' | 'Q', byte: number, count: number, what: string, prefix: string) => {
    for (let k = 0; k < Math.min(count, MAX_CHANNELS_PER_RANGE); k++) {
      out.push({ address: `%${area}W${byte + 2 * k}`, area, dataType: 'Int', module: m.name, detail: `${what} ${k}`, name: `${clean(m.name)}_${prefix}${k}` });
    }
  };
  const bytes = (m: IoModuleConfig, area: 'I' | 'Q', byte: number, count: number, what: string, prefix: string) => {
    for (let k = 0; k < Math.min(count, MAX_CHANNELS_PER_RANGE); k++) {
      out.push({ address: `%${area}B${byte + k}`, area, dataType: 'Byte', module: m.name, detail: `${what} octet ${k}`, name: `${clean(m.name)}_${prefix}${k}` });
    }
  };
  for (const m of device.io) {
    switch (m.kind) {
      case 'gpio-di':
      case 'gpio-do': {
        const area = m.kind === 'gpio-di' ? 'I' : 'Q';
        out.push({ address: `%${area}${m.byte}.${m.bit}`, area, dataType: 'Bool', module: m.name, detail: `GPIO ${m.pin}`, name: clean(m.name) });
        break;
      }
      case 'gpio-ai':
      case 'gpio-ao': {
        const area = m.kind === 'gpio-ai' ? 'I' : 'Q';
        out.push({ address: `%${area}W${m.byte}`, area, dataType: 'Int', module: m.name, detail: `GPIO ${m.pin} (analogique)`, name: clean(m.name) });
        break;
      }
      case 'modbus-tcp':
        if (m.di) bits(m, 'I', m.di.byte, m.di.count, 'entrée TOR', 'DI');
        if (m.coils) bits(m, 'Q', m.coils.byte, m.coils.count, 'sortie TOR', 'DO');
        if (m.ir) words(m, 'I', m.ir.byte, m.ir.count, 'registre d’entrée', 'AI');
        if (m.hr) words(m, 'Q', m.hr.byte, m.hr.count, 'registre de maintien', 'AO');
        break;
      case 'iolink-master':
        for (const p of m.ports) {
          bytes(m, 'I', p.inByte, p.inLength, `port ${p.port}, entrée`, `P${p.port}_IN`);
          bytes(m, 'Q', p.outByte, p.outLength, `port ${p.port}, sortie`, `P${p.port}_OUT`);
        }
        break;
      case 'profinet-device':
        bytes(m, 'I', m.inByte, m.inLength, 'données du maître,', 'IN');
        bytes(m, 'Q', m.outByte, m.outLength, 'données vers le maître,', 'OUT');
        break;
      case 'profinet-remote':
        for (const x of m.submodules) {
          bytes(m, 'I', x.inByte, x.inLength, `emplacement ${x.slot}.${x.subslot}, entrée`, `S${x.slot}_IN`);
          bytes(m, 'Q', x.outByte, x.outLength, `emplacement ${x.slot}.${x.subslot}, sortie`, `S${x.slot}_OUT`);
        }
        break;
    }
  }
  return out;
}

/** The module channel that covers an address (a bit of a byte / word channel counts), or null */
export function ioChannelFor(channels: IoChannel[], address: string): IoChannel | null {
  const a = parseAddress(address);
  if (!a || a.area === 'M') return null;
  const size = { X: 1, B: 8, W: 16, D: 32 }[a.size];
  const start = a.byte * 8 + (a.size === 'X' ? a.bit : 0);
  for (const c of channels) {
    const ca = parseAddress(c.address)!;
    if (ca.area !== a.area) continue;
    const cs = { X: 1, B: 8, W: 16, D: 32 }[ca.size];
    const cstart = ca.byte * 8 + (ca.size === 'X' ? ca.bit : 0);
    if (start >= cstart && start + size <= cstart + cs) return c;
  }
  return null;
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

function memberLines(m: Member, indent = '      '): string[] {
  const comment = m.comment ? `   // ${m.comment.replace(/[\r\n]+/g, ' ')}` : '';
  if (/^struct$/i.test(m.dataType.trim())) {
    return [`${indent}${m.name} : Struct${comment}`, ...(m.members ?? []).flatMap((c) => memberLines(c, `${indent}   `)), `${indent}END_STRUCT;`];
  }
  const init = m.defaultValue !== undefined && m.defaultValue.trim() !== '' ? ` := ${m.defaultValue.trim()}` : '';
  return [`${indent}${m.name} : ${m.dataType}${init};${comment}`];
}

function section(keyword: string, members: Member[]): string[] {
  if (members.length === 0) return [];
  return [`   ${keyword}`, ...members.flatMap((m) => memberLines(m)), '   END_VAR'];
}

export interface GeneratedSource {
  file: string;
  text: string;
  /** Block the source belongs to (null for tag tables) */
  blockId: string | null;
  tagTableId: string | null;
  typeId?: string;
  /** Line of the source where the user code starts (1-based) */
  codeLine: number;
  /** LAD blocks: network / element of each generated code line, translation error */
  ladder?: { lines: Array<{ network: number; element?: string }>; error?: LadderError };
  /** Interface object the source belongs to */
  interfaceId?: string;
  /** Methods: first line of the declaration, of the code, and line after the code */
  methods?: Array<{ id: string; line: number; codeLine: number; endLine: number }>;
}

function methodHeader(m: BlockMethod, prototype: boolean): string {
  const mods = [
    !prototype && m.access && m.access !== 'PUBLIC' ? m.access : '',
    !prototype && m.abstract ? 'ABSTRACT' : '', !prototype && m.final ? 'FINAL' : '', !prototype && m.override ? 'OVERRIDE' : '',
  ].filter(Boolean);
  const ret = m.returnType && m.returnType.trim() !== '' && m.returnType.trim().toUpperCase() !== 'VOID' ? ` : ${m.returnType.trim()}` : '';
  return `METHOD ${[...mods, q(m.name)].join(' ')}${ret}`;
}

/** Declarations and code of methods (appended to `lines`) */
function methodLines(lines: string[], methods: BlockMethod[], prototype: boolean): NonNullable<GeneratedSource['methods']> {
  const out: NonNullable<GeneratedSource['methods']> = [];
  for (const m of methods) {
    const i = m.interface;
    const line = lines.length + 1;
    lines.push(methodHeader(m, prototype));
    lines.push(...section('VAR_INPUT', i.input), ...section('VAR_OUTPUT', i.output), ...section('VAR_IN_OUT', i.inout));
    if (!prototype) lines.push(...section('VAR_TEMP', i.temp), ...section('VAR CONSTANT', i.constant));
    let codeLine = lines.length + 1;
    if (!prototype && !m.abstract) {
      lines.push('BEGIN');
      codeLine = lines.length + 1;
      lines.push(...m.code.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n'));
    }
    const endLine = lines.length + 1;
    lines.push('END_METHOD');
    lines.push('');
    out.push({ id: m.id, line, codeLine, endLine });
  }
  return out;
}

/** Generates the SCL source of an interface. */
export function interfaceSource(d: InterfaceDef): GeneratedSource {
  const lines = [`INTERFACE ${q(d.name)}${d.extends?.length ? ` EXTENDS ${d.extends.map(q).join(', ')}` : ''}`];
  const methods = methodLines(lines, d.methods, true);
  lines.push('END_INTERFACE');
  return { file: d.name, text: lines.join('\n') + '\n', blockId: null, tagTableId: null, interfaceId: d.id, codeLine: 0, methods };
}

/** Generates the SCL external source of a block. */
export function blockSource(b: Block): GeneratedSource {
  const lines: string[] = [];
  let i = b.interface;
  let code = b.code;
  let ladder: GeneratedSource['ladder'];
  if (b.language === 'LAD' && b.type !== 'DB') {
    try {
      const l = ladderToScl(b.networks ?? []);
      code = l.code;
      ladder = { lines: l.lines };
      // power flow temporaries of the networks
      i = { ...i, temp: [...i.temp, ...l.temps.map((name) => ({ name, dataType: 'Bool' }))] };
    } catch (e) {
      code = '';
      ladder = { lines: [], error: e instanceof LadderError ? e : new LadderError((e as Error).message, 0) };
    }
  }
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
    case 'FB': {
      const mods = [b.abstract ? 'ABSTRACT ' : '', b.final ? 'FINAL ' : ''].join('');
      lines.push(`FUNCTION_BLOCK ${mods}${q(b.name)}${b.extends?.trim() ? ` EXTENDS ${q(b.extends.trim())}` : ''}${b.implements?.length ? ` IMPLEMENTS ${b.implements.map(q).join(', ')}` : ''}`);
      lines.push('VERSION : 0.1');
      lines.push(...section('VAR_INPUT', i.input), ...section('VAR_OUTPUT', i.output), ...section('VAR_IN_OUT', i.inout),
        ...section('VAR', i.static), ...section('VAR_TEMP', i.temp), ...section('VAR CONSTANT', i.constant));
      break;
    }
  }
  const methods = b.type === 'FB' && b.methods?.length ? methodLines(lines, b.methods, false) : undefined;
  lines.push('BEGIN');
  const codeLine = lines.length + 1;
  lines.push(code.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
  lines.push(b.type === 'OB' ? 'END_ORGANIZATION_BLOCK' : b.type === 'FC' ? 'END_FUNCTION' : 'END_FUNCTION_BLOCK');
  return { file: b.name, text: lines.join('\n') + '\n', blockId: b.id, tagTableId: null, codeLine, ladder, methods };
}

/** Generates the SCL external source of a PLC data type (.udt). */
export function dataTypeSource(t: DataTypeDef): GeneratedSource {
  const lines = [`TYPE ${q(t.name)}`, 'VERSION : 0.1', '   STRUCT', ...t.members.flatMap((m) => memberLines(m)), '   END_STRUCT;', '', 'END_TYPE'];
  return { file: t.name, text: lines.join('\n') + '\n', blockId: null, tagTableId: null, typeId: t.id, codeLine: 0 };
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
  typeId?: string;
  /** Line in the block's code editor (1-based), when the error is in the code */
  codeLine?: number;
  /** "Interface" when the error is in the block interface / declarations */
  location?: 'code' | 'interface' | 'tags' | 'type' | 'datalog';
  /** LAD blocks: network (0-based) and element of the error */
  network?: number;
  element?: string;
  /** Error in a method (codeLine / location relative to the method) */
  methodId?: string;
  interfaceId?: string;
  dataLogId?: string;
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
  const checkMembers = (members: Member[], where: string, extra: Partial<ProjectDiagnostic>) => {
    for (const m of members) {
      if (!nameRe.test(m.name)) out.push({ severity: 'error', message: `Invalid name '${m.name}' in ${where} (letters, digits and _)`, ...extra });
      if (m.members) checkMembers(m.members, where, extra);
    }
  };
  for (const t of device.types ?? []) {
    if (!quotedRe.test(t.name)) out.push({ severity: 'error', message: `Invalid data type name "${t.name}"`, typeId: t.id, location: 'type', file: t.name });
    checkMembers(t.members, `"${t.name}"`, { typeId: t.id, location: 'type', file: t.name });
  }
  for (const b of device.blocks) {
    if (!quotedRe.test(b.name)) out.push({ severity: 'error', message: `Invalid block name "${b.name}"`, blockId: b.id, file: b.name });
    for (const [kind, members] of Object.entries(b.interface)) {
      for (const m of members as Member[]) {
        if (!nameRe.test(m.name)) out.push({ severity: 'error', message: `Invalid name '${m.name}' in ${kind} of "${b.name}" (letters, digits and _)`, blockId: b.id, location: 'interface', file: b.name });
      }
    }
    for (const m of b.methods ?? []) {
      if (!quotedRe.test(m.name)) out.push({ severity: 'error', message: `Invalid method name "${m.name}"`, blockId: b.id, methodId: m.id, location: 'interface', file: b.name });
      for (const [kind, members] of Object.entries(m.interface)) {
        checkMembers(members as Member[], `${kind} of "${b.name}.${m.name}"`, { blockId: b.id, methodId: m.id, location: 'interface', file: b.name });
      }
    }
  }
  for (const d of device.interfaces ?? []) {
    if (!quotedRe.test(d.name)) out.push({ severity: 'error', message: `Invalid interface name "${d.name}"`, interfaceId: d.id, location: 'interface', file: d.name });
  }
  return out;
}

/** HMI access flags of tags, DB members and FB interfaces, as paths for the compiler. */
export function hmiAccess(device: Device): { hidden: string[]; readOnly: string[] } {
  const hidden: string[] = [];
  const readOnly: string[] = [];
  const add = (path: string, x: { hmiVisible?: boolean; hmiWritable?: boolean }) => {
    if (x.hmiVisible === false) hidden.push(path);
    else if (x.hmiWritable === false) readOnly.push(path);
  };
  const members = (prefix: string, list: Member[]) => {
    for (const m of list) {
      add(`${prefix}.${m.name}`, m);
      if (m.members) members(`${prefix}.${m.name}`, m.members);
    }
  };
  for (const t of device.tagTables) for (const tag of t.tags) add(tag.name, tag);
  for (const b of device.blocks) {
    if (b.type !== 'DB') continue;
    if (b.members) members(b.name, b.members);
    const fb = b.instanceOf ? device.blocks.find((x) => x.type === 'FB' && x.name === b.instanceOf) : undefined;
    if (fb) members(b.name, [...fb.interface.input, ...fb.interface.output, ...fb.interface.inout, ...fb.interface.static]);
  }
  return { hidden, readOnly };
}

export function compileDevice(project: Project, device: Device): ProjectCompileResult {
  const sources = [
    ...(device.types ?? []).map(dataTypeSource), ...(device.interfaces ?? []).map(interfaceSource),
    ...device.tagTables.map(tagTableSource), ...device.blocks.map(blockSource),
  ];
  const pre = checkDevice(device);
  for (const src of sources) {
    const err = src.ladder?.error;
    if (err) pre.push({ severity: 'error', message: `Network ${err.network + 1}: ${err.message}`, blockId: src.blockId!, location: 'code', file: src.file, network: err.network, element: err.element });
  }
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
      hmi: hmiAccess(device),
      dbNumbers: Object.fromEntries(device.blocks.filter((b) => b.type === 'DB').map((b) => [b.name, b.number])),
      services: device.services,
      dataLogs: device.dataLogs,
    });
  const byFile = new Map(sources.map((s) => [s.file.toUpperCase(), s]));
  const diagnostics: ProjectDiagnostic[] = [...pre, ...result.diagnostics.map((d) => {
    const src = d.file ? byFile.get(d.file.toUpperCase()) : undefined;
    const pd: ProjectDiagnostic = { ...d };
    if (d.file === '#datalogs') {
      const name = /^Data log '([^']*)'/.exec(d.message)?.[1];
      pd.dataLogId = device.dataLogs?.find((l) => l.name === name)?.id;
      pd.location = 'datalog';
      pd.file = 'Traçabilité';
      return pd;
    }
    const method = d.line ? src?.methods?.find((m) => d.line! >= m.line && d.line! <= m.endLine) : undefined;
    if (src?.interfaceId) {
      pd.interfaceId = src.interfaceId;
      pd.location = 'interface';
      if (method) pd.methodId = method.id;
    } else if (src?.blockId && method) {
      pd.blockId = src.blockId;
      pd.methodId = method.id;
      if (d.line! >= method.codeLine && d.line! < method.endLine) {
        pd.location = 'code';
        pd.codeLine = d.line! - method.codeLine + 1;
      } else {
        pd.location = 'interface';
      }
    } else if (src?.blockId) {
      pd.blockId = src.blockId;
      if (d.line && src.codeLine && d.line >= src.codeLine) {
        pd.location = 'code';
        pd.codeLine = d.line - src.codeLine + 1;
        const origin = src.ladder?.lines[pd.codeLine - 1];
        if (origin) {
          pd.network = origin.network;
          const block = device.blocks.find((b) => b.id === src.blockId);
          const network = block?.networks?.[origin.network];
          pd.element = network ? ladElementFor(network, d.message, origin.element) : origin.element;
          pd.message = `Network ${origin.network + 1}: ${d.message}`;
        }
      } else {
        pd.location = 'interface';
      }
    } else if (src?.tagTableId) {
      pd.tagTableId = src.tagTableId;
      pd.location = 'tags';
    } else if (src?.typeId) {
      pd.typeId = src.typeId;
      pd.location = 'type';
    }
    return pd;
  })];
  return { ...result, ok: result.ok && !diagnostics.some((d) => d.severity === 'error'), diagnostics, sources };
}

// ---------------------------------------------------------------------------
// Import of SCL external sources
// ---------------------------------------------------------------------------

function typeText(t: TypeRef): string {
  if (t.name === 'STRUCT') return 'Struct';
  if (t.name === 'ARRAY') return `Array[${t.low}..${t.high}] of ${typeText(t.element!)}`;
  if (t.name === 'STRING') return t.length && t.length !== 32 ? `String[${t.length}]` : 'String';
  if (t.name in TYPE_DISPLAY) return TYPE_DISPLAY[t.name as Elementary];
  return /^[A-Za-z_]\w*$/.test(t.name) && ['TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG'].includes(t.name.toUpperCase()) ? t.name.toUpperCase() : t.name.toUpperCase() === 'DTL' ? 'DTL' : `"${t.name}"`;
}

function exprText(e: Expr | null): string | undefined {
  if (!e) return undefined;
  switch (e.kind) {
    case 'int': return String(e.value);
    case 'real': return Number.isInteger(e.value) ? e.value.toFixed(1) : String(e.value);
    case 'bool': return e.value ? 'TRUE' : 'FALSE';
    case 'string': return `'${e.value.replace(/\$/g, '$$').replace(/'/g, "$'")}'`;
    case 'time': return `T#${e.value}MS`;
    case 'typed':
      if (e.type === 'CHAR' || e.type === 'WCHAR') return `${e.type}#${e.value}`;
      return formatTemporal(e.type as TemporalType, e.value);
    case 'var': return e.scope === 'global' ? `"${e.name}"` : e.name;
    case 'unary': return `${e.op === 'NOT' ? 'NOT ' : '-'}${exprText(e.operand)}`;
    default: return undefined;
  }
}

type CommentOf = (line: number) => string | undefined;

function toMember(v: VarDecl, commentOf?: CommentOf): Member {
  const m: Member = { name: v.name, dataType: typeText(v.type), defaultValue: exprText(v.initial) };
  const comment = commentOf?.(v.line);
  if (comment) m.comment = comment;
  if (v.type.name === 'STRUCT') m.members = (v.type.fields ?? []).map((f) => toMember(f, commentOf));
  return m;
}

/** Creates blocks, PLC data types and tags from an SCL external source (.scl, .db, .udt). */
export function importExternalSource(device: Device, text: string, file = 'source.scl'): { blocks: Block[]; tags: Tag[]; types: DataTypeDef[]; interfaces: InterfaceDef[] } {
  const program = parse(text, file);
  const blocks: Block[] = [];
  const srcLines = text.split(/\r?\n/);
  // end-of-line comment of a declaration ("Speed : Int;   // tr/min")
  const commentOf: CommentOf = (line) => /;\s*\/\/\s*(.*?)\s*$/.exec(srcLines[line - 1] ?? '')?.[1] || undefined;
  const bodyOf = (r: TextRange | undefined): string => {
    if (!r) return '';
    const out: string[] = [];
    for (let l = r.fromLine; l <= r.toLine && l <= srcLines.length; l++) {
      let s = srcLines[l - 1];
      if (l === r.toLine) s = s.slice(0, r.toCol - 1);
      if (l === r.fromLine) s = ' '.repeat(r.fromCol - 1) + s.slice(r.fromCol - 1);
      out.push(s);
    }
    const lines = out.join('\n').replace(/\s+$/, '').replace(/^(\s*\n)+/, '').split('\n');
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
    return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
  };
  const members = (vars: VarDecl[], section: string): Member[] =>
    vars.filter((v) => v.section === section).map((v) => toMember(v, commentOf));
  const methodOf = (m: Method, prototype: boolean): BlockMethod => ({
    id: newId('mth'), name: m.name, returnType: m.returnType ? typeText(m.returnType) : 'Void',
    ...(!prototype && m.accessGiven && m.access !== 'PUBLIC' ? { access: m.access } : {}),
    ...(!prototype && m.abstract ? { abstract: true } : {}), ...(m.final ? { final: true } : {}), ...(m.override ? { override: true } : {}),
    interface: {
      ...emptyInterface(), input: members(m.vars, 'input'), output: members(m.vars, 'output'), inout: members(m.vars, 'inout'),
      temp: members(m.vars, 'temp'), constant: members(m.vars, 'constant'),
    },
    code: prototype ? '' : bodyOf(m.bodyRange),
  });

  for (const pou of program.pous) {
    const type: BlockType = pou.kind === 'ORGANIZATION_BLOCK' ? 'OB' : pou.kind === 'FUNCTION' ? 'FC' : 'FB';
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
      code: bodyOf(pou.bodyRange),
      ...(pou.extends ? { extends: pou.extends } : {}),
      ...(pou.implements?.length ? { implements: pou.implements } : {}),
      ...(pou.abstract ? { abstract: true } : {}),
      ...(pou.final ? { final: true } : {}),
      ...(pou.methods?.length ? { methods: pou.methods.map((m) => methodOf(m, false)) } : {}),
    });
  }
  for (const db of program.dataBlocks) {
    blocks.push({
      id: newId('blk'), name: db.name, type: 'DB', number: 0, interface: emptyInterface(), code: '',
      instanceOf: db.instanceOf ?? undefined,
      members: db.instanceOf ? undefined : db.fields.map((f) => toMember(f, commentOf)),
    });
  }
  const tags: Tag[] = program.vars.filter((v) => v.section === 'global').map((v) => ({
    name: v.name,
    dataType: typeText(v.type).replace(/^"([^"]*)"$/, '$1'),
    address: v.address ? `%${v.address.area}${v.address.size === 'X' ? `${v.address.byte}.${v.address.bit}` : `${v.address.size}${v.address.byte}`}` : '',
    ...(commentOf(v.line) ? { comment: commentOf(v.line) } : {}),
  }));
  const numbered: Block[] = [...device.blocks];
  const free = (type: BlockType, wanted: number) => !numbered.some((x) => x.type === type && x.number === wanted);
  for (const b of blocks) {
    const preferred = b.type === 'OB' ? (b.event === 'Startup' ? 100 : 1) : 0;
    b.number = preferred && free(b.type, preferred) ? preferred : nextBlockNumber({ ...device, blocks: numbered }, b.type);
    numbered.push(b);
  }
  const types: DataTypeDef[] = program.types.map((ut) => ({ id: newId('udt'), name: ut.name, members: ut.fields.map((f) => toMember(f, commentOf)) }));
  const interfaces: InterfaceDef[] = program.interfaces.map((d) => ({
    id: newId('ifc'), name: d.name, ...(d.extends.length ? { extends: d.extends } : {}), methods: d.methods.map((m) => methodOf(m, true)),
  }));
  return { blocks, tags, types, interfaces };
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
