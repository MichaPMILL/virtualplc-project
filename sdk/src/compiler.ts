import type { Address, CallArg, DataBlock, Expr, Pou, Program, Stmt, TypeRef, UserType, VarDecl } from './ast.ts';
import { ByteWriter, MemoryImage } from './bytes.ts';
import { CompileError, toDiagnostic, type Diagnostic } from './diagnostics.ts';
import { Area, LIBRARY_BLOCKS, MathFn, Op, OPERANDS, StdFn, SysFn, Trap, VmType } from './isa.ts';
import { formatAddress, parse } from './parser.ts';
import {
  ELEMENTARY, T, fromVmName, isBool, isChar, isElementary, isFloat, isInt, isNumeric, isSpecialInt, isString, libraryBlock, sameType,
  typeName, unifyNumeric, vmTypeOf, type DataType, type Elementary,
} from './types.ts';
import { buildImage, HMI_STRING, HMI_TIME, type DbEntry, type FunctionEntry, type HmiSymbol, type IoModuleConfig, type LineEntry, type ServicesConfig } from './image.ts';
import type { SymbolNode } from './symbols.ts';
import { civilFromDays } from './literals.ts';

export const COMPILER_VERSION = '0.1.0';

export interface SourceFile {
  file: string;
  text: string;
}

export interface CompileOptions {
  sources: SourceFile[];
  /** Program name stored in the image. */
  name?: string;
  /** I/O modules of the device configuration. */
  hardware?: IoModuleConfig[];
  /** Build time stored in the image (Unix seconds); defaults to now. */
  buildTime?: number;
  /** Cycle time of the main OB in milliseconds (CPU property); default 10. */
  cycleMs?: number;
  /** Names of the cyclic and startup OBs (default: "Main"/OB1 and "Startup"/OB100). */
  mainOb?: string;
  startupOb?: string;
  /**
   * Variables exposed to HMIs (OPC UA, S7): paths ("Motor_DB.Speed", case-insensitive, without
   * array indices) that are hidden, or visible but read-only. Everything else is readable and
   * writable (inputs %I are always read-only).
   */
  hmi?: { hidden?: string[]; readOnly?: string[] };
  /** Data block numbers (name -> number) for absolute addressing (DB1.DBW2). */
  dbNumbers?: Record<string, number>;
  /** OPC UA / S7 servers of the CPU. */
  services?: ServicesConfig;
}

export interface CompileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  image?: Uint8Array;
  /** CRC-32 of the image, as reported by the device. */
  programId?: string;
  symbols: SymbolNode[];
  /** Variables exposed to HMIs (flattened) */
  hmiSymbols?: HmiSymbol[];
  /** Data blocks with their number and location */
  dbs?: DbEntry[];
  /** function index -> block name / file, for mapping runtime faults to sources */
  functions: Array<{ name: string; kind: string; file?: string }>;
  stats: { code: number; data: number; constants: number; inputs: number; outputs: number; memory: number };
}

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

type AreaName = 'D' | 'N' | 'I' | 'Q' | 'M' | 'C';

interface Member {
  name: string;
  type: DataType;
  offset: number;
  section: VarDecl['section'] | 'library';
}

interface Layout {
  size: number;
  members: Map<string, Member>;
}

/** What a name refers to. */
type Sym =
  | { k: 'var'; name: string; type: DataType; area: AreaName; offset: number; bit?: number; readonly?: 'input' | 'constant'; section?: string }
  | { k: 'ref'; name: string; type: DataType; area: AreaName; offset: number; section: string }
  | { k: 'const'; name: string; type: DataType; value: number | boolean | string | bigint };

/** Location of a value being read or written. */
type Place =
  | { k: 'static'; type: DataType; area: AreaName; offset: number; bit?: number; readonly?: string; name?: string }
  | { k: 'dynamic'; type: DataType; readonly?: string; name?: string }
  | { k: 'const'; type: DataType; value: number | boolean | string | bigint };

interface FunctionInfo {
  pou: Pou;
  index: number;
  /** FC: parameter slots and locals (absolute D). FB: temps only. OB: temps. */
  locals: Map<string, Sym>;
  frameOffset: number;
  frameSize: number;
  zeroOffset: number;
  zeroSize: number;
  params: VarDecl[];
  returnSlot: number;
  codeOffset: number;
}

const AREA_CODE: Record<AreaName, number> = { D: Area.D, N: Area.N, I: Area.I, Q: Area.Q, M: Area.M, C: Area.C };
const MAX_DATA = 16 * 1024 * 1024;

const STD_PARAMS: Record<string, string[] | null> = {
  ABS: ['IN'], SQR: ['IN'], SQRT: ['IN'], EXP: ['IN'], LN: ['IN'], SIN: ['IN'], COS: ['IN'], TAN: ['IN'],
  ASIN: ['IN'], ACOS: ['IN'], ATAN: ['IN'], TRUNC: ['IN'], ROUND: ['IN'], CEIL: ['IN'], FLOOR: ['IN'], FRAC: ['IN'],
  EXPT: ['IN1', 'IN2'], MIN: null, MAX: null, LIMIT: ['MN', 'IN', 'MX'], SEL: ['G', 'IN0', 'IN1'], MUX: null,
  NORM_X: ['MIN', 'VALUE', 'MAX'], SCALE_X: ['MIN', 'VALUE', 'MAX'], SHL: ['IN', 'N'], SHR: ['IN', 'N'],
  CONCAT: null, LEN: ['IN'], LOG: null, WAIT: ['MS'], MILLIS: [], DEVICE_OK: ['MODULE'], DEVICE_DIAG: ['MODULE'], PN_ALARM: ['MODULE', 'SLOT', 'KIND', 'CODE'],
  RD_SYS_T: null, RD_LOC_T: null,
};
const NS_PER_DAY = 86_400_000_000_000n;
/** Built-in DTL structure (date and time, 12 bytes) */
const DTL_KEY = '#DTL';
const DTL: DataType = { k: 'struct', name: 'DTL', key: DTL_KEY };
const MATH: Record<string, number> = {
  SQRT: MathFn.SQRT, EXP: MathFn.EXP, LN: MathFn.LN, SIN: MathFn.SIN, COS: MathFn.COS, TAN: MathFn.TAN,
  ASIN: MathFn.ASIN, ACOS: MathFn.ACOS, ATAN: MathFn.ATAN, FRAC: MathFn.FRAC, ROUND: MathFn.ROUND,
};
const RESERVED_TYPES = new Set([...Object.keys(ELEMENTARY), 'STRING', 'VOID', ...Object.keys(LIBRARY_BLOCKS)]);
const STRING_SCRATCH = 254;

// ---------------------------------------------------------------------------

export function compile(options: CompileOptions): CompileResult {
  return new Compiler(options).run();
}

/** Convenience: compile a single source text. */
export function compileSource(text: string, file = 'main.scl', options: Omit<CompileOptions, 'sources'> = {}): CompileResult {
  return compile({ ...options, sources: [{ file, text }] });
}

class Compiler {
  private readonly diagnostics: Diagnostic[] = [];
  private program: Program = { vars: [], pous: [], dataBlocks: [], types: [] };
  private readonly userTypes = new Map<string, UserType>();
  private readonly structLayouts = new Map<string, Layout>();
  /** Fields of each struct layout (for start values) */
  private readonly structFields = new Map<string, { fields: VarDecl[]; file?: string }>();
  private readonly anonStructs = new WeakMap<TypeRef, string>();
  private readonly globals = new Map<string, Sym>();
  private readonly pous = new Map<string, Pou>();
  private readonly dataBlocks = new Map<string, DataBlock>();
  private readonly fbLayouts = new Map<string, Layout>();
  private readonly dbLayouts = new Map<string, Layout>();
  private readonly layoutInProgress = new Set<string>();
  private readonly functions = new Map<string, FunctionInfo>();
  private readonly modules = new Map<string, number>();
  private readonly symbols: SymbolNode[] = [];

  private dataTop = 0;
  private init!: MemoryImage;
  private readonly code = new ByteWriter();
  private readonly consts = new ByteWriter();
  private readonly constStrings = new Map<string, number>();
  private readonly lines: LineEntry[] = [];
  private imageSize = { I: 0, Q: 0, M: 0 };

  // codegen state
  private fn: FunctionInfo | null = null;
  private loops: Array<{ exits: number[]; continues: number[] }> = [];
  private file: string | undefined;
  private readonly callGraph = new Map<string, Set<string>>();

  private readonly options: CompileOptions;

  constructor(options: CompileOptions) {
    this.options = options;
    const f = (name: string, type: string, initial?: number): VarDecl => ({
      name, type: { name: type, line: 0 }, initial: initial === undefined ? null : { kind: 'int', value: initial, line: 0 }, address: null, section: 'static', line: 0,
    });
    this.structFields.set(DTL_KEY, {
      fields: [f('YEAR', 'UINT', 1970), f('MONTH', 'USINT', 1), f('DAY', 'USINT', 1), f('WEEKDAY', 'USINT', 5),
        f('HOUR', 'USINT'), f('MINUTE', 'USINT'), f('SECOND', 'USINT'), f('NANOSECOND', 'UDINT')],
    });
  }

  run(): CompileResult {
    this.parseAll();
    if (this.hasErrors()) return this.result();

    this.collect(() => this.declareModules());
    this.collect(() => this.declareBlocks());
    this.collect(() => this.declareGlobals());
    if (this.hasErrors()) return this.result();

    this.collect(() => this.allocate());
    if (this.hasErrors()) return this.result();

    for (const info of this.functions.values()) this.generate(info);
    this.collect(() => this.checkRecursion());
    if (this.hasErrors()) return this.result();

    return this.link();
  }

  // -------------------------------------------------------------------------
  // Phase 1: parsing and declarations
  // -------------------------------------------------------------------------

  private parseAll(): void {
    for (const src of this.options.sources) {
      try {
        const p = parse(src.text, src.file);
        this.program.vars.push(...p.vars);
        this.program.pous.push(...p.pous);
        this.program.dataBlocks.push(...p.dataBlocks);
        this.program.types.push(...p.types);
      } catch (e) {
        this.diagnostics.push(toDiagnostic(e));
      }
    }
  }

  private declareModules(): void {
    (this.options.hardware ?? []).forEach((m, i) => {
      this.modules.set(m.name.toUpperCase(), i);
    });
  }

  private declareBlocks(): void {
    for (const ut of this.program.types) {
      const key = ut.name.toUpperCase();
      this.file = ut.file;
      if (this.userTypes.has(key)) throw this.err(`Duplicate data type '${ut.name}'`, ut.line);
      if (RESERVED_TYPES.has(key) || isElementary(key)) throw this.err(`Data type '${ut.name}' has the name of a built-in type`, ut.line);
      this.userTypes.set(key, ut);
      this.structFields.set(key, { fields: ut.fields, file: ut.file });
    }
    for (const pou of this.program.pous) {
      const key = pou.name.toUpperCase();
      this.file = pou.file;
      if (this.pous.has(key) || this.userTypes.has(key)) throw this.err(`Duplicate block '${pou.name}'`, pou.line);
      if (RESERVED_TYPES.has(key) || key in STD_PARAMS || conversion(key) !== null) {
        throw this.err(`Block '${pou.name}' has the name of a built-in instruction`, pou.line);
      }
      this.pous.set(key, pou);
    }
    for (const db of this.program.dataBlocks) {
      const key = db.name.toUpperCase();
      this.file = db.file;
      if (this.pous.has(key) || this.dataBlocks.has(key) || this.userTypes.has(key)) throw this.err(`Duplicate block '${db.name}'`, db.line);
      this.dataBlocks.set(key, db);
    }
  }

  private declareGlobals(): void {
    for (const v of this.program.vars) {
      this.collect(() => {
        this.file = v.file;
        const key = v.name.toUpperCase();
        if (this.globals.has(key) || this.pous.has(key) || this.dataBlocks.has(key)) {
          throw this.err(`Duplicate declaration of '${v.name}'`, v.line);
        }
        this.checkName(v.name, v.line);
        const type = this.resolveType(v.type);
        if (v.section === 'constant') {
          if (!v.initial) throw this.err(`Constant '${v.name}' needs a value`, v.line);
          this.globals.set(key, { k: 'const', name: v.name, type, value: this.constValue(v.initial, type) });
          return;
        }
        if (v.address) {
          if (type.k !== 'elem' || !addressAccepts(v.address, type.name)) {
            throw this.err(`Type ${typeName(type)} does not fit address ${formatAddress(v.address)} of '${v.name}'`, v.line);
          }
          this.useImage(v.address, ELEMENTARY[type.name].size);
          this.globals.set(key, {
            k: 'var', name: v.name, type, area: v.address.area, offset: v.address.byte,
            bit: v.address.size === 'X' ? v.address.bit : undefined,
            readonly: v.address.area === 'I' ? 'input' : undefined,
          });
          return;
        }
        // Offset assigned in allocate()
        this.globals.set(key, { k: 'var', name: v.name, type, area: 'D', offset: -1 });
      });
    }
  }

  private checkName(name: string, line: number): void {
    const key = name.toUpperCase();
    if (RESERVED_TYPES.has(key) && !(key in LIBRARY_BLOCKS)) throw this.err(`'${name}' is a reserved keyword`, line);
  }

  private resolveType(t: TypeRef): DataType {
    if (t.name === 'ARRAY') {
      return { k: 'array', elem: this.resolveType(t.element!), low: t.low!, high: t.high! };
    }
    if (t.name === 'STRING') return { k: 'string', length: t.length ?? 32 };
    if (isElementary(t.name)) return T.elem(t.name);
    if (t.name === 'STRUCT' && t.fields) {
      let key = this.anonStructs.get(t);
      if (!key) {
        key = `#STRUCT${this.structFields.size}`;
        this.anonStructs.set(t, key);
        this.structFields.set(key, { fields: t.fields, file: this.file });
      }
      return { k: 'struct', name: '', key };
    }
    const ut = this.userTypes.get(t.name.toUpperCase());
    if (ut) return { k: 'struct', name: ut.name, key: ut.name.toUpperCase() };
    if (t.name.toUpperCase() === 'DTL') return DTL;
    const lib = libraryBlock(t.name);
    if (lib) return { k: 'fb', name: lib.key, library: true };
    const pou = this.pous.get(t.name.toUpperCase());
    if (pou && pou.kind === 'FUNCTION_BLOCK') return { k: 'fb', name: pou.name, library: false };
    if (pou) throw this.err(`'${t.name}' is a ${pou.kind === 'FUNCTION' ? 'function (FC)' : 'organization block'}, not a data type`, t.line);
    throw this.err(`Unknown data type '${t.name}'`, t.line);
  }

  // -------------------------------------------------------------------------
  // Phase 2: memory layout
  // -------------------------------------------------------------------------

  private sizeOf(t: DataType): number {
    switch (t.k) {
      case 'elem':
        return ELEMENTARY[t.name].size;
      case 'string':
        return t.length + 2;
      case 'array':
        return (t.high - t.low + 1) * this.sizeOf(t.elem);
      case 'fb':
        return this.fbLayout(t).size;
      case 'db':
        return this.dbLayouts.get(t.name.toUpperCase())?.size ?? 0;
      case 'struct':
        return this.structLayout(t).size;
      default:
        return 8;
    }
  }

  private fbLayout(t: { name: string; library: boolean }): Layout {
    const key = t.name.toUpperCase();
    const cached = this.fbLayouts.get(key);
    if (cached) return cached;

    if (t.library) {
      const spec = LIBRARY_BLOCKS[key];
      const members = new Map<string, Member>();
      for (const [name, [vm, offset]] of Object.entries(spec.members)) {
        const type = name === 'PT' || name === 'ET' ? T.TIME : fromVmName(vm);
        members.set(name, { name, type, offset, section: 'library' });
      }
      const layout = { size: spec.size, members };
      this.fbLayouts.set(key, layout);
      return layout;
    }

    const pou = this.pous.get(key)!;
    if (this.layoutInProgress.has(key)) {
      throw this.err(`Function block '${pou.name}' contains an instance of itself`, pou.line, pou.file);
    }
    this.layoutInProgress.add(key);
    const members = new Map<string, Member>();
    let offset = 0;
    for (const v of pou.vars) {
      if (!['input', 'output', 'inout', 'static'].includes(v.section)) continue;
      const k = v.name.toUpperCase();
      if (members.has(k)) throw this.err(`Duplicate declaration of '${v.name}' in '${pou.name}'`, v.line, pou.file);
      const type = this.resolveType(v.type);
      const size = v.section === 'inout' ? 8 : this.sizeOf(type);
      members.set(k, { name: v.name, type, offset, section: v.section });
      offset += size;
    }
    this.layoutInProgress.delete(key);
    const layout = { size: offset, members };
    this.fbLayouts.set(key, layout);
    return layout;
  }

  private structLayout(t: { name: string; key: string }): Layout {
    const cached = this.structLayouts.get(t.key);
    if (cached) return cached;
    const guard = `TYPE:${t.key}`;
    if (this.layoutInProgress.has(guard)) throw this.err(`Data type '${t.name}' contains itself`, 0);
    this.layoutInProgress.add(guard);
    const { fields, file } = this.structFields.get(t.key)!;
    const saved = this.file;
    this.file = file;
    const members = new Map<string, Member>();
    let offset = 0;
    try {
      for (const v of fields) {
        const k = v.name.toUpperCase();
        if (members.has(k)) throw this.err(`Duplicate declaration of '${v.name}' in ${t.name ? `'${t.name}'` : 'Struct'}`, v.line);
        const type = this.resolveType(v.type);
        if (type.k === 'fb' || type.k === 'db') throw this.err(`'${v.name}': a data type cannot contain a function block instance`, v.line);
        members.set(k, { name: v.name, type, offset, section: 'static' });
        offset += this.sizeOf(type);
      }
    } finally {
      this.file = saved;
      this.layoutInProgress.delete(guard);
    }
    const layout = { size: offset, members };
    this.structLayouts.set(t.key, layout);
    return layout;
  }

  private dbLayout(db: DataBlock): Layout {
    const members = new Map<string, Member>();
    let offset = 0;
    for (const v of db.fields) {
      const k = v.name.toUpperCase();
      if (members.has(k)) throw this.err(`Duplicate declaration of '${v.name}' in '${db.name}'`, v.line, db.file);
      const type = this.resolveType(v.type);
      members.set(k, { name: v.name, type, offset, section: 'static' });
      offset += this.sizeOf(type);
    }
    return { size: offset, members };
  }

  private alloc(size: number): number {
    const at = this.dataTop;
    this.dataTop += size;
    if (this.dataTop > MAX_DATA) throw new CompileError('Program data exceeds 16 MiB');
    return at;
  }

  private allocate(): void {
    // Data block types
    for (const db of this.dataBlocks.values()) {
      this.file = db.file;
      if (db.instanceOf !== null) {
        const t = this.resolveType({ name: db.instanceOf, line: db.line });
        if (t.k !== 'fb') throw this.err(`Instance DB '${db.name}': '${db.instanceOf}' is not a function block`, db.line);
      } else {
        this.dbLayouts.set(db.name.toUpperCase(), this.dbLayout(db));
      }
    }

    // Global tags
    for (const [key, sym] of this.globals) {
      if (sym.k === 'var' && sym.area === 'D' && sym.offset < 0) {
        this.globals.set(key, { ...sym, offset: this.alloc(this.sizeOf(sym.type)) });
      }
    }
    // Data blocks
    for (const db of this.dataBlocks.values()) {
      const type: DataType = db.instanceOf !== null
        ? this.resolveType({ name: db.instanceOf, line: db.line })
        : { k: 'db', name: db.name };
      this.globals.set(db.name.toUpperCase(), { k: 'var', name: db.name, type, area: 'D', offset: this.alloc(this.sizeOf(type)) });
    }

    // Start values of %Q/%M tags are applied by the Startup OB (created if needed).
    const imageInits = this.program.vars.filter((v) => v.address && v.initial && v.section !== 'constant');
    if (imageInits.length > 0) {
      const input = imageInits.find((v) => v.address!.area === 'I');
      if (input) throw this.err(`'${input.name}': inputs cannot have a start value`, input.line, input.file);
      let startup = [this.options.startupOb?.toUpperCase() ?? '', 'STARTUP', 'OB100', 'COMPLETE_RESTART'].map((n) => this.pous.get(n)).find((p) => p?.kind === 'ORGANIZATION_BLOCK');
      if (!startup) {
        startup = { kind: 'ORGANIZATION_BLOCK', name: 'Startup', returnType: null, vars: [], body: [], line: imageInits[0].line, file: imageInits[0].file };
        this.pous.set('STARTUP', startup);
      }
      startup.body.unshift(...imageInits.map((v): Stmt => ({
        kind: 'assign', target: { kind: 'var', name: v.name, scope: 'global', line: v.line }, value: v.initial!, op: null, line: v.line,
      })));
    }

    // Function frames
    let index = 0;
    for (const pou of this.pous.values()) {
      this.file = pou.file;
      this.functions.set(pou.name.toUpperCase(), this.frameFor(pou, index++));
    }

    // Initial data image (start values)
    this.init = new MemoryImage(this.dataTop);
    // FC parameters are not reset by the VM: their STRING headers are set once, here.
    for (const f of this.functions.values()) {
      for (const sym of f.locals.values()) {
        if (sym.k === 'var' && sym.area === 'D' && sym.offset < f.zeroOffset) this.initValue(sym.offset, sym.type);
      }
    }
    for (const v of this.program.vars) {
      const sym = this.globals.get(v.name.toUpperCase());
      if (sym?.k !== 'var') continue;
      this.file = v.file;
      if (sym.area === 'D') {
        this.initValue(sym.offset, sym.type);
        if (v.initial) this.initConst(sym.offset, sym.type, v.initial);
      }
      this.symbols.push(this.symbolFor(v.name, sym.type, sym.area, sym.offset, sym.bit));
    }
    for (const db of this.dataBlocks.values()) {
      this.file = db.file;
      const sym = this.globals.get(db.name.toUpperCase()) as Extract<Sym, { k: 'var' }>;
      if (db.instanceOf === null) {
        const layout = this.dbLayouts.get(db.name.toUpperCase())!;
        for (const f of db.fields) {
          const m = layout.members.get(f.name.toUpperCase())!;
          this.initValue(sym.offset + m.offset, m.type);
          if (f.initial) this.initConst(sym.offset + m.offset, m.type, f.initial);
        }
      } else {
        this.initValue(sym.offset, sym.type);
      }
      // BEGIN section: constant start values
      for (const stmt of db.init) {
        if (stmt.kind !== 'assign' || stmt.op !== null) throw this.err('Only constant assignments are allowed in the BEGIN section of a data block', stmt.line);
        const { offset, type } = this.staticMemberPath(stmt.target, sym.type, sym.offset, db.name);
        this.initConst(offset, type, stmt.value);
      }
      this.symbols.push(this.symbolFor(db.name, sym.type, 'D', sym.offset));
    }
  }

  /** Resolves `a.b[2]` inside a data block to a static offset (for BEGIN start values). */
  private staticMemberPath(e: Expr, baseType: DataType, baseOffset: number, dbName: string): { offset: number; type: DataType } {
    if (e.kind === 'var') {
      const m = this.memberOf(baseType, e.name, e.line);
      return { offset: baseOffset + m.offset, type: m.type };
    }
    if (e.kind === 'member') {
      const inner = this.staticMemberPath(e.base, baseType, baseOffset, dbName);
      const m = this.memberOf(inner.type, e.member, e.line);
      return { offset: inner.offset + m.offset, type: m.type };
    }
    if (e.kind === 'index') {
      const inner = this.staticMemberPath(e.base, baseType, baseOffset, dbName);
      if (inner.type.k !== 'array') throw this.err('Indexing a value that is not an array', e.line);
      const i = Number(this.constValue(e.index, T.DINT));
      if (i < inner.type.low || i > inner.type.high) throw this.err(`Array index ${i} out of bounds`, e.line);
      return { offset: inner.offset + (i - inner.type.low) * this.sizeOf(inner.type.elem), type: inner.type.elem };
    }
    throw this.err(`Invalid start value target in '${dbName}'`, e.line);
  }

  private frameFor(pou: Pou, index: number): FunctionInfo {
    const locals = new Map<string, Sym>();
    const add = (v: VarDecl, sym: Sym) => {
      const k = v.name.toUpperCase();
      if (locals.has(k)) throw this.err(`Duplicate declaration of '${v.name}' in '${pou.name}'`, v.line);
      this.checkName(v.name, v.line);
      locals.set(k, sym);
    };

    // FB: interface lives in the instance (area N); only temps have a frame.
    if (pou.kind === 'FUNCTION_BLOCK') {
      const layout = this.fbLayout({ name: pou.name, library: false });
      for (const m of layout.members.values()) {
        const v = pou.vars.find((x) => x.name.toUpperCase() === m.name.toUpperCase())!;
        if (v.address) throw this.err(`Only global tags can have an address ('${v.name}')`, v.line);
        add(v, m.section === 'inout'
          ? { k: 'ref', name: m.name, type: m.type, area: 'N', offset: m.offset, section: 'inout' }
          : { k: 'var', name: m.name, type: m.type, area: 'N', offset: m.offset, section: m.section });
      }
    }

    const params: VarDecl[] = [];
    const frameOffset = this.dataTop;
    // FC parameters (not zeroed: written by the caller)
    if (pou.kind === 'FUNCTION') {
      for (const v of pou.vars.filter((x) => x.section === 'input' || x.section === 'inout')) {
        const type = this.resolveType(v.type);
        if (v.section === 'input' && (type.k === 'fb' || type.k === 'db')) {
          throw this.err(`'${v.name}': function block instances can only be passed as VAR_IN_OUT`, v.line);
        }
        const offset = this.alloc(v.section === 'inout' ? 8 : this.sizeOf(type));
        add(v, v.section === 'inout'
          ? { k: 'ref', name: v.name, type, area: 'D', offset, section: 'inout' }
          : { k: 'var', name: v.name, type, area: 'D', offset, section: 'input' });
        params.push(v);
      }
    }
    const zeroOffset = this.dataTop;
    let returnSlot = -1;
    for (const v of pou.vars) {
      const isParam = v.section === 'input' || v.section === 'inout';
      if (pou.kind === 'FUNCTION_BLOCK' && v.section !== 'temp' && v.section !== 'constant') continue;
      if (pou.kind === 'FUNCTION' && isParam) continue;
      if (v.address) throw this.err(`Only global tags can have an address ('${v.name}')`, v.line);
      const type = this.resolveType(v.type);
      if (v.section === 'constant') {
        if (!v.initial) throw this.err(`Constant '${v.name}' needs a value`, v.line);
        add(v, { k: 'const', name: v.name, type, value: this.constValue(v.initial, type) });
        continue;
      }
      if ((type.k === 'fb' || type.k === 'db') && pou.kind !== 'FUNCTION_BLOCK') {
        throw this.err(`'${v.name}': function block instances must be declared in a FUNCTION_BLOCK (static) or as a global DB/tag`, v.line);
      }
      if (type.k === 'fb') throw this.err(`'${v.name}': function block instances cannot be temporary`, v.line);
      const offset = this.alloc(this.sizeOf(type));
      add(v, { k: 'var', name: v.name, type, area: 'D', offset, section: v.section });
      if (v.section === 'output') params.push(v);
    }
    if (pou.kind === 'FUNCTION' && pou.returnType) {
      const type = this.resolveType(pou.returnType);
      returnSlot = this.alloc(this.sizeOf(type));
      locals.set(pou.name.toUpperCase(), { k: 'var', name: pou.name, type, area: 'D', offset: returnSlot, section: 'return' });
    }
    return {
      pou, index, locals, frameOffset, frameSize: this.dataTop - frameOffset, zeroOffset, zeroSize: this.dataTop - zeroOffset,
      params, returnSlot, codeOffset: 0,
    };
  }

  /** Default content of a freshly allocated value (library block defaults, string max length). */
  private initValue(offset: number, t: DataType): void {
    switch (t.k) {
      case 'string':
        this.init.write(offset, 1, 'int', t.length);
        break;
      case 'array': {
        const size = this.sizeOf(t.elem);
        for (let i = 0; i <= t.high - t.low; i++) this.initValue(offset + i * size, t.elem);
        break;
      }
      case 'fb': {
        if (t.library) {
          for (const [at, value] of Object.entries(LIBRARY_BLOCKS[t.name.toUpperCase()].init ?? {})) {
            this.init.write(offset + Number(at), 1, 'int', value);
          }
          break;
        }
        const pou = this.pous.get(t.name.toUpperCase())!;
        const layout = this.fbLayout(t);
        for (const v of pou.vars) {
          const m = layout.members.get(v.name.toUpperCase());
          if (!m || m.section === 'inout') continue;
          this.initValue(offset + m.offset, m.type);
          if (v.initial) {
            const saved = this.file;
            this.file = pou.file;
            this.initConst(offset + m.offset, m.type, v.initial);
            this.file = saved;
          }
        }
        break;
      }
      case 'db': {
        const layout = this.dbLayouts.get(t.name.toUpperCase())!;
        for (const m of layout.members.values()) this.initValue(offset + m.offset, m.type);
        break;
      }
      case 'struct': {
        const layout = this.structLayout(t);
        const { fields, file } = this.structFields.get(t.key)!;
        for (const f of fields) {
          const m = layout.members.get(f.name.toUpperCase())!;
          this.initValue(offset + m.offset, m.type);
          if (f.initial) {
            const saved = this.file;
            this.file = file;
            this.initConst(offset + m.offset, m.type, f.initial);
            this.file = saved;
          }
        }
        break;
      }
      default:
    }
  }

  private initConst(offset: number, t: DataType, e: Expr): void {
    if (t.k === 'struct' && t.key === DTL_KEY && e.kind === 'typed' && e.type === 'DTL') {
      this.dtlInit(offset, e.value);
      return;
    }
    const value = this.constValue(e, t);
    if (t.k === 'elem') {
      const info = ELEMENTARY[t.name];
      if (typeof value === 'bigint') this.init.write(offset, info.size, 'int', value);
      else this.init.write(offset, info.size, info.cls === 'float' ? 'float' : 'int', typeof value === 'boolean' ? Number(value) : Number(value));
    } else if (t.k === 'string') {
      const bytes = new TextEncoder().encode(String(value)).subarray(0, t.length);
      this.init.write(offset, 1, 'int', t.length);
      this.init.write(offset + 1, 1, 'int', bytes.length);
      this.init.writeBytes(offset + 2, bytes);
    } else {
      throw this.err(`Start values are not supported for ${typeName(t)}`, e.line);
    }
  }

  /** Evaluates a constant expression and checks it against the target type. */
  private constValue(e: Expr, t: DataType): number | boolean | string | bigint {
    let v = this.fold(e);
    if (v === null) throw this.err('Start value must be a constant', e.line);
    if (isChar(t) && typeof v === 'string' && [...v].length === 1) v = v.codePointAt(0)!;
    if (e.kind === 'time' && t.k === 'elem' && t.name === 'LTIME') v = BigInt(e.value) * 1_000_000n;
    if (typeof v === 'bigint') {
      const nt = this.typeOf(e);
      if (!sameType(nt, t) && !(isChar(nt) && isInt(t))) throw this.err(`Cannot use a ${typeName(nt)} value as ${typeName(t)}`, e.line);
      return v;
    }
    if (isSpecialInt(t) && typeof v === 'number' && !(t.k === 'elem' && t.name === 'TIME') && e.kind !== 'int' && !(isChar(t) && e.kind === 'string')) {
      throw this.err(`Cannot use ${e.kind === 'time' ? 'a Time' : 'this'} value as ${typeName(t)}`, e.line);
    }
    if (t.k === 'string') {
      if (typeof v !== 'string') throw this.err(`Cannot use ${typeof v === 'boolean' ? 'a BOOL' : 'a number'} as ${typeName(t)}`, e.line);
      return v;
    }
    if (t.k !== 'elem') throw this.err(`Start values are not supported for ${typeName(t)}`, e.line);
    const info = ELEMENTARY[t.name];
    if (info.cls === 'bool') {
      if (typeof v !== 'boolean') throw this.err(`Cannot use a number as Bool (use TRUE/FALSE)`, e.line);
      return v;
    }
    if (typeof v !== 'number') throw this.err(`Cannot use ${typeof v === 'boolean' ? 'a BOOL' : 'a string'} as ${typeName(t)}`, e.line);
    if (info.cls === 'int' && !Number.isInteger(v)) throw this.err(`Cannot use a REAL value as ${typeName(t)}`, e.line);
    return v;
  }

  /** Constant folding for start values and CASE labels. */
  private fold(e: Expr): number | boolean | string | bigint | null {
    switch (e.kind) {
      case 'typed':
        return e.value;
      case 'int':
      case 'real':
      case 'time':
      case 'bool':
      case 'string':
        return e.value;
      case 'var': {
        const s = this.lookup(e.name, e.scope);
        return s?.k === 'const' ? s.value : null;
      }
      case 'unary': {
        const v = this.fold(e.operand);
        if (v === null) return null;
        if (e.op === '-') return typeof v === 'number' ? -v : null;
        return typeof v === 'boolean' ? !v : typeof v === 'number' ? ~v : null;
      }
      case 'binary': {
        const a = this.fold(e.left);
        const b = this.fold(e.right);
        if (typeof a !== 'number' || typeof b !== 'number') return null;
        switch (e.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0 ? null : Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
          case 'MOD': return b === 0 ? null : a % b;
          default: return null;
        }
      }
      default:
        return null;
    }
  }

  private useImage(a: Address, size: number): void {
    const end = a.byte + size;
    if (end > 65535) throw new CompileError(`Address ${formatAddress(a)} is out of range`);
    this.imageSize[a.area] = Math.max(this.imageSize[a.area], end);
  }

  // -------------------------------------------------------------------------
  // Symbols for the Studio (monitoring)
  // -------------------------------------------------------------------------

  private symbolFor(name: string, t: DataType, area: AreaName, offset: number, bit?: number): SymbolNode {
    const node: SymbolNode = { name, type: typeName(t), area: area as SymbolNode['area'], offset, size: this.sizeOf(t) };
    if (bit !== undefined) node.bit = bit;
    if (t.k === 'elem') {
      node.vmType = ELEMENTARY[t.name].vm;
      node.kind = ELEMENTARY[t.name].cls;
      if (t.name === 'TIME') node.kind = 'time';
      const special: Partial<Record<Elementary, SymbolNode['kind']>> = {
        LTIME: 'ltime', DATE: 'date', TOD: 'tod', LTOD: 'ltod', DT: 'dt', LDT: 'ldt', CHAR: 'char', WCHAR: 'char',
      };
      if (special[t.name]) node.kind = special[t.name];
    } else if (t.k === 'string') {
      node.kind = 'string';
    } else if (t.k === 'array') {
      node.kind = 'array';
      const size = this.sizeOf(t.elem);
      const count = t.high - t.low + 1;
      if (count <= 256) {
        node.children = [];
        for (let i = t.low; i <= t.high; i++) node.children.push(this.symbolFor(`[${i}]`, t.elem, area, offset + (i - t.low) * size));
      }
    } else if (t.k === 'fb' || t.k === 'db' || t.k === 'struct') {
      node.kind = 'struct';
      const layout = t.k === 'fb' ? this.fbLayout(t) : t.k === 'struct' ? this.structLayout(t) : this.dbLayouts.get(t.name.toUpperCase())!;
      node.children = [...layout.members.values()]
        .filter((m) => m.section !== 'inout')
        .map((m) => this.symbolFor(m.name, m.type, area, offset + m.offset));
    }
    return node;
  }

  // -------------------------------------------------------------------------
  // Phase 3: code generation
  // -------------------------------------------------------------------------

  private generate(info: FunctionInfo): void {
    this.fn = info;
    this.file = info.pou.file;
    this.loops = [];
    info.codeOffset = this.code.length;
    this.callGraph.set(info.pou.name.toUpperCase(), new Set());

    // Prologue: the VM zeroes the frame on each call, so restore the header of STRING variables
    for (const sym of info.locals.values()) {
      if (sym.k === 'var' && sym.area === 'D' && sym.offset >= info.zeroOffset && sym.offset < info.zeroOffset + info.zeroSize) {
        this.stringHeaders(sym.type, sym.offset);
      }
    }
    // Prologue: start values of temporaries / outputs (and of the fields of their data types)
    for (const v of info.pou.vars) {
      if (v.section === 'constant') continue;
      if (info.pou.kind === 'FUNCTION_BLOCK' && v.section !== 'temp') continue;
      if (info.pou.kind === 'FUNCTION' && (v.section === 'input' || v.section === 'inout')) continue;
      const target: Expr = { kind: 'var', name: v.name, scope: 'local', line: v.line };
      if (v.initial) this.collect(() => this.assign(target, v.initial!, v.line));
      else this.collect(() => this.structStartValues(target, this.resolveType(v.type), v.line));
    }

    this.statements(info.pou.body);
    this.emit(info.pou.kind === 'ORGANIZATION_BLOCK' ? Op.HALT : Op.RET);
    this.fn = null;
  }

  /** Code that applies the start values declared in a data type to a zeroed variable. */
  private structStartValues(target: Expr, t: DataType, line: number): void {
    if (t.k === 'array' && (t.elem.k === 'struct' || t.elem.k === 'array') && t.high - t.low < 1024) {
      for (let i = t.low; i <= t.high; i++) {
        this.structStartValues({ kind: 'index', base: target, index: { kind: 'int', value: i, line }, line }, t.elem, line);
      }
    } else if (t.k === 'struct') {
      for (const f of this.structFields.get(t.key)!.fields) {
        const member: Expr = { kind: 'member', base: target, member: f.name, line };
        if (f.initial) this.assign(member, f.initial, line);
        else this.structStartValues(member, this.resolveType(f.type), line);
      }
    }
  }

  private stringHeaders(t: DataType, offset: number): void {
    if (t.k === 'string') {
      this.pushInt(t.length);
      this.emit(Op.STORE, VmType.U8, Area.D, offset);
    } else if (t.k === 'array' && (t.elem.k === 'string' || t.elem.k === 'array' || t.elem.k === 'struct')) {
      const size = this.sizeOf(t.elem);
      for (let i = 0; i <= t.high - t.low; i++) this.stringHeaders(t.elem, offset + i * size);
    } else if (t.k === 'struct') {
      for (const m of this.structLayout(t).members.values()) this.stringHeaders(m.type, offset + m.offset);
    }
  }

  private statements(body: Stmt[]): void {
    for (const s of body) this.collect(() => this.statement(s));
  }

  private statement(s: Stmt): void {
    this.lines.push({ pc: this.code.length, func: this.fn!.index, line: s.line });
    switch (s.kind) {
      case 'assign':
        if (s.op !== null) {
          this.assign(s.target, { kind: 'binary', op: s.op, left: s.target, right: s.value, line: s.line }, s.line);
        } else {
          this.assign(s.target, s.value, s.line);
        }
        return;
      case 'call': {
        const t = this.expr(s.call, null);
        if (t.k !== 'void') this.emit(Op.POP);
        return;
      }
      case 'if': {
        const ends: number[] = [];
        s.branches.forEach((b, i) => {
          this.condition(b.cond);
          const skip = this.jump(Op.JZ);
          this.statements(b.body);
          if (s.else !== null || i < s.branches.length - 1) ends.push(this.jump(Op.JMP));
          this.bind(skip);
        });
        if (s.else) this.statements(s.else);
        ends.forEach((j) => this.bind(j));
        return;
      }
      case 'while': {
        const top = this.code.length;
        this.condition(s.cond);
        const exit = this.jump(Op.JZ);
        this.loop(() => this.statements(s.body), top);
        this.jumpTo(Op.JMP, top);
        this.bind(exit);
        this.endLoop();
        return;
      }
      case 'repeat': {
        const top = this.code.length;
        this.loop(() => this.statements(s.body));
        this.bindContinues(this.code.length);
        this.condition(s.until);
        this.jumpTo(Op.JZ, top);
        this.endLoop();
        return;
      }
      case 'for':
        this.forLoop(s);
        return;
      case 'case':
        this.caseStatement(s);
        return;
      case 'exit':
      case 'continue': {
        const loop = this.loops[this.loops.length - 1];
        if (!loop) throw this.err(`${s.kind.toUpperCase()} used outside of a loop`, s.line);
        (s.kind === 'exit' ? loop.exits : loop.continues).push(this.jump(Op.JMP));
        return;
      }
      case 'return':
        this.emit(this.fn!.pou.kind === 'ORGANIZATION_BLOCK' ? Op.HALT : Op.RET);
        return;
    }
  }

  /** Runs body inside a loop context; continues jump to `continueTarget` if given. */
  private loop(body: () => void, continueTarget?: number): void {
    this.loops.push({ exits: [], continues: [] });
    body();
    if (continueTarget !== undefined) {
      this.bindContinues(continueTarget);
    }
  }

  private bindContinues(target: number): void {
    const loop = this.loops[this.loops.length - 1];
    for (const j of loop.continues) this.patch(j, target);
    loop.continues = [];
  }

  private endLoop(): void {
    const loop = this.loops.pop()!;
    for (const j of loop.exits) this.bind(j);
  }

  private forLoop(s: Extract<Stmt, { kind: 'for' }>): void {
    const counter: Expr = { kind: 'var', name: s.variable, scope: s.scope, line: s.line };
    if (!this.lookup(s.variable, s.scope)) {
      // Historical programs use undeclared counters: implicitly DINT.
      const offset = this.scratch(4);
      this.fn!.locals.set(s.variable.toUpperCase(), { k: 'var', name: s.variable, type: T.DINT, area: 'D', offset, section: 'temp' });
    }
    const counterType = this.typeOf(counter);
    if (!isInt(counterType) || counterType.k !== 'elem') throw this.err('FOR loop counter must be an integer variable', s.line);

    this.assign(counter, s.start, s.line);
    const endSlot = this.scratch(8);
    this.expr(s.end, T.LINT);
    this.emit(Op.STORE, VmType.I64, Area.D, endSlot);

    const stepValue = s.step ? this.fold(s.step) : 1;
    if (stepValue === 0) throw this.err('FOR loop step cannot be 0', s.line);
    let stepSlot = -1;
    if (typeof stepValue !== 'number') {
      stepSlot = this.scratch(8);
      this.expr(s.step!, T.LINT);
      this.emit(Op.DUP);
      this.emit(Op.STORE, VmType.I64, Area.D, stepSlot);
      const ok = this.jump(Op.JNZ);
      this.emit(Op.TRAP, Trap.BOUNDS);
      this.bind(ok);
    }

    const top = this.code.length;
    // condition
    const loadStep = () => (stepSlot >= 0 ? this.emit(Op.LOAD, VmType.I64, Area.D, stepSlot) : this.pushInt(stepValue as number));
    this.expr(counter, T.LINT);
    this.emit(Op.LOAD, VmType.I64, Area.D, endSlot);
    if (stepSlot < 0) {
      this.emit((stepValue as number) > 0 ? Op.LE : Op.GE);
    } else {
      // (step > 0 AND counter <= end) OR (step < 0 AND counter >= end)
      this.emit(Op.LE);
      loadStep();
      this.pushInt(0);
      this.emit(Op.GT);
      this.emit(Op.AND);
      this.expr(counter, T.LINT);
      this.emit(Op.LOAD, VmType.I64, Area.D, endSlot);
      this.emit(Op.GE);
      loadStep();
      this.pushInt(0);
      this.emit(Op.LT);
      this.emit(Op.AND);
      this.emit(Op.OR);
    }
    const exit = this.jump(Op.JZ);
    this.loop(() => this.statements(s.body));
    this.bindContinues(this.code.length);
    // counter += step (stop before overflowing the counter type)
    const place = this.place(counter);
    this.loadPlace(this.place(counter));
    loadStep();
    this.emit(Op.ADD);
    this.storePlace(place, counterType, s.line);
    this.jumpTo(Op.JMP, top);
    this.bind(exit);
    this.endLoop();
  }

  private caseStatement(s: Extract<Stmt, { kind: 'case' }>): void {
    const t = this.typeOf(s.selector);
    if (!isInt(t)) throw this.err(`CASE selector must be an integer, not ${typeName(t)}`, s.line);
    const slot = this.scratch(8);
    this.expr(s.selector, T.LINT);
    this.emit(Op.STORE, VmType.I64, Area.D, slot);
    const ends: number[] = [];
    for (const b of s.branches) {
      const hits: number[] = [];
      for (const [low, high] of b.ranges) {
        this.emit(Op.LOAD, VmType.I64, Area.D, slot);
        if (low === high) {
          this.pushInt(low);
          this.emit(Op.EQ);
        } else {
          this.pushInt(low);
          this.emit(Op.GE);
          this.emit(Op.LOAD, VmType.I64, Area.D, slot);
          this.pushInt(high);
          this.emit(Op.LE);
          this.emit(Op.AND);
        }
        hits.push(this.jump(Op.JNZ));
      }
      const next = this.jump(Op.JMP);
      hits.forEach((h) => this.bind(h));
      this.statements(b.body);
      ends.push(this.jump(Op.JMP));
      this.bind(next);
    }
    if (s.else) this.statements(s.else);
    ends.forEach((j) => this.bind(j));
  }

  private condition(e: Expr): void {
    const t = this.typeOf(e);
    if (!isBool(t)) throw this.err(`Condition must be of type Bool, not ${typeName(t)}`, e.line);
    this.expr(e, T.BOOL);
  }

  // -------------------------------------------------------------------------
  // Assignments and places
  // -------------------------------------------------------------------------

  private assign(target: Expr, value: Expr, line: number): void {
    const place = this.place(target);
    this.checkWritable(place, line);
    const t = place.type;
    if (t.k === 'string') {
      this.pushAddress(place);
      this.stringValue(value);
      this.emit(Op.CALL_STD, StdFn.SASSIGN, 2);
      return;
    }
    if (t.k === 'struct' && t.key === DTL_KEY && value.kind === 'typed' && value.type === 'DTL') {
      this.pushAddress(place);
      this.pushBig(value.value);
      this.emit(Op.CALL_STD, StdFn.LDT2DTL, 2);
      return;
    }
    if (t.k === 'array' || t.k === 'struct') {
      const vt = this.typeOf(value);
      if (!sameType(vt, t)) throw this.err(`Cannot assign ${typeName(vt)} to ${typeName(t)}`, line);
      this.pushAddress(place);
      if (value.kind === 'call') this.expr(value, vt);
      else this.pushAddress(this.place(value));
      this.emit(Op.COPY, this.sizeOf(t));
      return;
    }
    if (t.k === 'fb' || t.k === 'db') throw this.err(`Cannot assign to ${typeName(t)} as a whole`, line);
    this.expr(value, t);
    this.storePlace(place, t, line);
  }

  private checkWritable(p: Place, line: number): void {
    if (p.k === 'const') throw this.err('Cannot assign to a constant', line);
    if (p.readonly === 'input') throw this.err(`Cannot assign to input ${p.name ?? ''} (inputs are read-only)`.replace('  ', ' '), line);
    if (p.readonly === 'constant') throw this.err(`Cannot assign to constant '${p.name}'`, line);
  }

  /** Resolves an lvalue/rvalue location; emits a pointer for dynamic places. */
  private place(e: Expr): Place {
    switch (e.kind) {
      case 'var': {
        const s = this.lookup(e.name, e.scope);
        if (!s) throw this.undeclared(e);
        if (s.k === 'const') return { k: 'const', type: s.type, value: s.value };
        if (s.k === 'ref') {
          this.emit(Op.LOAD, VmType.PTR, AREA_CODE[s.area], s.offset);
          return { k: 'dynamic', type: s.type, name: s.name };
        }
        return { k: 'static', type: s.type, area: s.area, offset: s.offset, bit: s.bit, readonly: s.readonly, name: `'${s.name}'` };
      }
      case 'addr': {
        const a = e.address;
        const type = T.elem(defaultAddressType(a));
        this.useImage(a, ELEMENTARY[defaultAddressType(a)].size);
        return {
          k: 'static', type, area: a.area, offset: a.byte, bit: a.size === 'X' ? a.bit : undefined,
          readonly: a.area === 'I' ? 'input' : undefined, name: formatAddress(a),
        };
      }
      case 'member': {
        const base = this.place(e.base);
        const m = this.memberOf(base.type, e.member, e.line);
        if (base.k === 'static') {
          if (m.section === 'inout') {
            this.emit(Op.LOAD, VmType.PTR, AREA_CODE[base.area], base.offset + m.offset);
            return { k: 'dynamic', type: m.type };
          }
          return { k: 'static', type: m.type, area: base.area, offset: base.offset + m.offset, readonly: base.readonly };
        }
        if (base.k === 'dynamic') {
          this.emit(Op.OFFSET, m.offset);
          if (m.section === 'inout') this.emit(Op.LOAD_IND, VmType.PTR);
          return { k: 'dynamic', type: m.type, readonly: base.readonly };
        }
        throw this.err('Invalid member access', e.line);
      }
      case 'index': {
        const base = this.place(e.base);
        if (base.type.k !== 'array') throw this.err(`Cannot index ${typeName(base.type)}`, e.line);
        const arr = base.type;
        const it = this.typeOf(e.index);
        if (!isInt(it)) throw this.err(`Array index must be an integer, not ${typeName(it)}`, e.line);
        const folded = this.fold(e.index);
        const size = this.sizeOf(arr.elem);
        if (typeof folded === 'number' && base.k === 'static') {
          if (folded < arr.low || folded > arr.high) throw this.err(`Array index ${folded} out of bounds [${arr.low}..${arr.high}]`, e.line);
          return { k: 'static', type: arr.elem, area: base.area, offset: base.offset + (folded - arr.low) * size, readonly: base.readonly };
        }
        this.pushAddress(base);
        this.expr(e.index, T.LINT);
        this.emit(Op.INDEX, size, arr.low, arr.high);
        return { k: 'dynamic', type: arr.elem, readonly: base.k === 'const' ? 'constant' : base.readonly };
      }
      default:
        throw this.err('Expected a variable', e.line);
    }
  }

  private memberOf(t: DataType, member: string, line: number): Member {
    let layout: Layout | undefined;
    if (t.k === 'fb') layout = this.fbLayout(t);
    else if (t.k === 'db') layout = this.dbLayouts.get(t.name.toUpperCase());
    else if (t.k === 'struct') layout = this.structLayout(t);
    if (!layout) throw this.err(`${typeName(t)} has no members`, line);
    const m = layout.members.get(member.toUpperCase());
    if (!m) throw this.err(`${t.k === 'fb' && t.library ? `'${t.name}'` : typeName(t)} has no member '${member}'`, line);
    return m;
  }

  private pushAddress(p: Place): void {
    if (p.k === 'static') {
      if (p.bit !== undefined) throw new CompileError('Cannot take the address of a bit');
      this.emit(Op.PUSH_ADDR, AREA_CODE[p.area], p.offset);
    } else if (p.k === 'const') {
      if (typeof p.value !== 'string') throw new CompileError('Cannot take the address of a constant');
      this.emit(Op.PUSH_ADDR, Area.C, this.constString(p.value));
    }
    // dynamic: pointer already on the stack
  }

  private loadPlace(p: Place): void {
    if (p.k === 'const') {
      this.pushConst(p.value, p.type);
      return;
    }
    const t = p.type;
    if (t.k !== 'elem') {
      this.pushAddress(p);
      return;
    }
    const vm = ELEMENTARY[t.name].vm;
    if (p.k === 'static') {
      if (p.bit !== undefined) this.emit(Op.LOAD_BIT, AREA_CODE[p.area], p.offset, p.bit);
      else this.emit(Op.LOAD, vm, AREA_CODE[p.area], p.offset);
    } else {
      this.emit(Op.LOAD_IND, vm);
    }
  }

  /** Stores the value on top of the stack (already converted to `t`). */
  private storePlace(p: Place, t: DataType, line: number): void {
    if (p.k === 'const') throw this.err('Cannot assign to a constant', line);
    if (t.k !== 'elem') throw this.err(`Cannot assign to ${typeName(t)}`, line);
    const vm = ELEMENTARY[t.name].vm;
    if (p.k === 'static') {
      if (p.bit !== undefined) this.emit(Op.STORE_BIT, AREA_CODE[p.area], p.offset, p.bit);
      else this.emit(Op.STORE, vm, AREA_CODE[p.area], p.offset);
    } else {
      this.emit(Op.STORE_IND, vm);
    }
  }

  private lookup(name: string, scope: 'global' | 'local' | null): Sym | null {
    const key = name.toUpperCase();
    if (scope !== 'global' && this.fn) {
      const s = this.fn.locals.get(key);
      if (s) return s;
    }
    if (scope !== 'local') return this.globals.get(key) ?? null;
    return null;
  }

  private undeclared(e: Extract<Expr, { kind: 'var' }>): CompileError {
    const where = e.scope === 'local' ? ` in the interface of '${this.fn?.pou.name}'`
      : e.scope === 'global' ? ' in the PLC tags or data blocks' : '';
    return this.err(`Undeclared variable '${e.name}'${where}`, e.line);
  }

  // -------------------------------------------------------------------------
  // Expressions: type inference
  // -------------------------------------------------------------------------

  private typeOf(e: Expr): DataType {
    switch (e.kind) {
      case 'int':
        return T.ANYINT;
      case 'real':
        return T.ANYREAL;
      case 'bool':
        return T.BOOL;
      case 'string':
        return { k: 'string', length: Math.max(1, e.value.length) };
      case 'time':
        return T.TIME;
      case 'typed':
        return e.type === 'DTL' ? DTL : T.elem(e.type as Elementary);
      case 'var': {
        const s = this.lookup(e.name, e.scope);
        if (!s) throw this.undeclared(e);
        return s.type;
      }
      case 'addr':
        return T.elem(defaultAddressType(e.address));
      case 'member':
        return this.memberOf(this.typeOf(e.base), e.member, e.line).type;
      case 'index': {
        const t = this.typeOf(e.base);
        if (t.k !== 'array') throw this.err(`Cannot index ${typeName(t)}`, e.line);
        return t.elem;
      }
      case 'unary': {
        const t = this.typeOf(e.operand);
        if (e.op === 'NOT') {
          if (!isBool(t) && !isInt(t)) throw this.err(`NOT cannot be applied to ${typeName(t)}`, e.line);
          return t;
        }
        if (!isNumeric(t)) throw this.err(`Cannot negate ${typeName(t)}`, e.line);
        return t;
      }
      case 'binary':
        return this.binaryType(e);
      case 'call':
        return this.callType(e);
    }
  }

  private binaryType(e: Extract<Expr, { kind: 'binary' }>): DataType {
    const a = this.typeOf(e.left);
    const b = this.typeOf(e.right);
    switch (e.op) {
      case 'AND':
      case 'OR':
      case 'XOR':
        if (isBool(a) && isBool(b)) return T.BOOL;
        if (isInt(a) && isInt(b)) return unifyNumeric(a, b)!;
        throw this.err(`${e.op} needs two Bool or two integer operands, not ${typeName(a)} and ${typeName(b)}`, e.line);
      case '=':
      case '<>':
      case '<':
      case '<=':
      case '>':
      case '>=':
        if (isString(a) && isString(b)) return T.BOOL;
        if (isBool(a) && isBool(b)) {
          if (e.op !== '=' && e.op !== '<>') throw this.err(`Cannot compare Bool values with ${e.op}`, e.line);
          return T.BOOL;
        }
        if (this.charCompare(e)) return T.BOOL;
        if (!unifyNumeric(a, b)) throw this.err(`Cannot compare ${typeName(a)} with ${typeName(b)}`, e.line);
        return T.BOOL;
      case 'MOD':
        if (!isInt(a) || !isInt(b)) throw this.err(`MOD needs integer operands, not ${typeName(a)} and ${typeName(b)}`, e.line);
        return unifyNumeric(a, b)!;
      case '**':
        if (!isNumeric(a) || !isNumeric(b)) throw this.err(`** needs numeric operands`, e.line);
        return isFloat(a) && a.k === 'elem' && a.name === 'REAL' ? T.REAL : T.LREAL;
      default: {
        const temporal = temporalArithmetic(e.op, a, b);
        if (temporal) return temporal.result;
        if ((isSpecialInt(a) || isSpecialInt(b)) && !['+', '-', '*', '/'].includes(e.op)) {
          throw this.err(`Operator ${e.op} cannot be applied to ${typeName(a)} and ${typeName(b)}`, e.line);
        }
        const t = unifyNumeric(a, b);
        if (!t) throw this.err(`Operator ${e.op} cannot be applied to ${typeName(a)} and ${typeName(b)}`, e.line);
        if (isSpecialInt(t) && !(t.k === 'elem' && (t.name === 'TIME' || t.name === 'LTIME'))) {
          throw this.err(`Operator ${e.op} cannot be applied to ${typeName(a)} and ${typeName(b)}`, e.line);
        }
        return t;
      }
    }
  }

  /** CHAR / WCHAR compared with a one-character string literal: the type of the character operand. */
  private charCompare(e: Extract<Expr, { kind: 'binary' }>): DataType | null {
    const lit = (x: Expr) => x.kind === 'string' && [...x.value].length === 1;
    const a = this.typeOf(e.left);
    const b = this.typeOf(e.right);
    if (isChar(a) && lit(e.right)) return a;
    if (isChar(b) && lit(e.left)) return b;
    return null;
  }

  // -------------------------------------------------------------------------
  // Expressions: code generation
  // -------------------------------------------------------------------------

  /** Emits `e` converted to `want` (null = natural type). Returns the type of the value pushed. */
  private expr(e: Expr, want: DataType | null): DataType {
    const natural = this.typeOf(e);
    const target = want ?? (natural.k === 'anyint' ? T.DINT : natural.k === 'anyreal' ? T.LREAL : natural);

    // Literals are emitted directly in the target representation.
    if (e.kind === 'time' && target.k === 'elem' && target.name === 'LTIME') {
      this.pushBig(BigInt(e.value) * 1_000_000n);
      return target;
    }
    if (e.kind === 'time' && isSpecialInt(target) && !(target.k === 'elem' && target.name === 'TIME')) {
      throw this.err(`Cannot use a Time value as ${typeName(target)}`, e.line);
    }
    if (e.kind === 'typed' && e.type !== 'DTL') {
      if (!sameType(natural, target) && !(isInt(target) && !isSpecialInt(target) && (e.type === 'CHAR' || e.type === 'WCHAR'))) {
        throw this.err(`Cannot use a ${typeName(natural)} value as ${typeName(target)}`, e.line);
      }
      this.pushBig(e.value);
      return target;
    }
    if (e.kind === 'string' && isChar(target)) {
      const cp = [...e.value];
      if (cp.length !== 1) throw this.err(`'${e.value}' is not a single character`, e.line);
      this.pushInt(cp[0].codePointAt(0)!);
      return target;
    }
    if (e.kind === 'int' || e.kind === 'real' || e.kind === 'time') {
      if (isFloat(target)) {
        this.emit(Op.PUSH_F64, e.value);
        return target;
      }
      if (e.kind === 'real') throw this.err(`Cannot use a REAL value as ${typeName(target)} (use REAL_TO_${target.k === 'elem' ? target.name : 'DINT'}())`, e.line);
      if (!isInt(target)) throw this.err(`Cannot use a number as ${typeName(target)}`, e.line);
      this.pushInt(e.value);
      return target;
    }

    switch (e.kind) {
      case 'bool':
        this.pushInt(e.value ? 1 : 0);
        break;
      case 'string':
        this.emit(Op.PUSH_ADDR, Area.C, this.constString(e.value));
        break;
      case 'var':
      case 'addr':
      case 'member':
      case 'index':
        this.loadPlace(this.place(e));
        break;
      case 'unary':
        this.expr(e.operand, natural);
        if (e.op === 'NOT') {
          this.emit(isBool(natural) ? Op.LNOT : Op.NOT);
          if (!isBool(natural) && natural.k === 'elem') this.emit(Op.WRAP, ELEMENTARY[natural.name].vm);
        } else {
          this.emit(isFloat(natural) ? Op.FNEG : Op.NEG);
        }
        break;
      case 'binary':
        this.binary(e, natural);
        break;
      case 'call':
        this.call(e);
        break;
    }
    return this.convert(natural, target, e.line);
  }

  /** Converts the value on top of the stack. */
  private convert(from: DataType, to: DataType, line: number): DataType {
    if (to.k === 'void' || sameType(from, to)) return to;
    if (isBool(to) !== isBool(from)) {
      throw this.err(`Cannot convert ${typeName(from)} to ${typeName(to)}${isBool(to) ? '' : ' (use BOOL_TO_INT())'}`, line);
    }
    if (isString(to) || isString(from)) {
      if (isString(to) && isString(from)) return to;
      throw this.err(`Cannot convert ${typeName(from)} to ${typeName(to)}${isString(to) ? ` (use ${from.k === 'elem' ? from.name : 'INT'}_TO_STRING())` : ''}`, line);
    }
    if ((isSpecialInt(from) || isSpecialInt(to)) && from.k !== 'anyint') {
      // integers <-> TIME keep their historical implicit conversion
      const time = (t: DataType) => t.k === 'elem' && t.name === 'TIME';
      const plainInt = (t: DataType) => isInt(t) && !isSpecialInt(t);
      if (!((time(from) && plainInt(to)) || (time(to) && plainInt(from)))) {
        const n = (t: DataType) => (t.k === 'elem' ? t.name : typeName(t).toUpperCase());
        throw this.err(`Cannot convert ${typeName(from)} to ${typeName(to)} (use ${n(from)}_TO_${n(to)}())`, line);
      }
    }
    if (isNumeric(from) && isNumeric(to)) {
      if (isFloat(from) && isInt(to)) {
        throw this.err(`Implicit conversion from ${typeName(from)} to ${typeName(to)} is not allowed, use REAL_TO_${to.k === 'elem' ? to.name : 'DINT'}() or TRUNC()`, line);
      }
      if (isInt(from) && isFloat(to)) this.emit(Op.I2F);
      return to;
    }
    throw this.err(`Cannot convert ${typeName(from)} to ${typeName(to)}`, line);
  }

  private binary(e: Extract<Expr, { kind: 'binary' }>, result: DataType): void {
    const a = this.typeOf(e.left);
    const b = this.typeOf(e.right);

    if (['=', '<>', '<', '<=', '>', '>='].includes(e.op)) {
      if (isString(a)) {
        this.stringValue(e.left);
        this.stringValue(e.right);
        this.emit(Op.SCMP);
        this.pushInt(0);
        this.emit(compareOp(e.op, false));
        return;
      }
      const operand = isBool(a) ? T.BOOL : this.charCompare(e) ?? unifyNumeric(a, b)!;
      this.expr(e.left, operand);
      this.expr(e.right, operand);
      this.emit(compareOp(e.op, isFloat(operand)));
      return;
    }

    if ((e.op === 'AND' || e.op === 'OR') && isBool(result)) {
      // Short-circuit evaluation
      this.expr(e.left, T.BOOL);
      this.emit(Op.DUP);
      const done = this.jump(e.op === 'AND' ? Op.JZ : Op.JNZ);
      this.emit(Op.POP);
      this.expr(e.right, T.BOOL);
      this.bind(done);
      return;
    }

    const temporal = temporalArithmetic(e.op, a, b);
    if (temporal) {
      this.expr(e.left, temporal.left);
      this.expr(e.right, temporal.right);
      if (temporal.scale) {
        this.pushBig(temporal.scale);
        this.emit(Op.MUL);
      }
      this.emit(e.op === '+' ? Op.ADD : Op.SUB);
      if (temporal.modulo) {
        // wrap around midnight
        this.pushBig(temporal.modulo);
        this.emit(Op.MOD);
        this.pushBig(temporal.modulo);
        this.emit(Op.ADD);
        this.pushBig(temporal.modulo);
        this.emit(Op.MOD);
      }
      return;
    }
    const operand = e.op === '**' ? result : result;
    this.expr(e.left, operand);
    this.expr(e.right, operand);
    const float = isFloat(operand);
    const ops: Record<string, [number, number]> = {
      '+': [Op.ADD, Op.FADD], '-': [Op.SUB, Op.FSUB], '*': [Op.MUL, Op.FMUL], '/': [Op.DIV, Op.FDIV],
      MOD: [Op.MOD, Op.MOD], '**': [Op.FPOW, Op.FPOW], AND: [Op.AND, Op.AND], OR: [Op.OR, Op.OR], XOR: [Op.XOR, Op.XOR],
    };
    const pair = ops[e.op];
    if (!pair) throw this.err(`Unsupported operator ${e.op}`, e.line);
    this.emit(float ? pair[1] : pair[0]);
    if (float && result.k === 'elem' && result.name === 'REAL') this.emit(Op.F32);
  }

  /** Pushes a STRING pointer for any expression, converting scalars when needed. */
  private stringValue(e: Expr): void {
    const t = this.typeOf(e);
    if (isString(t)) {
      if (e.kind === 'string') this.emit(Op.PUSH_ADDR, Area.C, this.constString(e.value));
      else this.expr(e, t);
      return;
    }
    throw this.err(`Expected a String, got ${typeName(t)}`, e.line);
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private callType(e: Extract<Expr, { kind: 'call' }>): DataType {
    const c = e.callee;
    if (c.kind === 'var' && c.scope !== 'local') {
      const key = c.name.toUpperCase();
      if (c.scope === null && !this.lookup(c.name, null)) {
        const conv = conversion(key);
        if (conv) return conv[1];
        if (key === 'RD_SYS_T' || key === 'RD_LOC_T') return T.INT;
        if (key in STD_PARAMS) return this.stdType(key, e);
      }
      const pou = this.pous.get(key);
      if (pou && pou.kind === 'FUNCTION') return pou.returnType ? this.resolveType(pou.returnType) : T.VOID;
      if (pou) {
        throw this.err(pou.kind === 'FUNCTION_BLOCK'
          ? `Function block '${pou.name}' must be called through an instance (instance DB or static variable)`
          : `Organization block '${pou.name}' cannot be called`, e.line);
      }
      if (libraryBlock(key) && !this.lookup(c.name, c.scope)) {
        throw this.err(`'${c.name}' must be called through an instance (e.g. #MyTimer : ${key}; #MyTimer(...))`, e.line);
      }
    }
    this.instanceType(e);
    return T.VOID;
  }

  private instanceType(e: Extract<Expr, { kind: 'call' }>): Extract<DataType, { k: 'fb' }> {
    let callee = e.callee;
    if (callee.kind === 'member') {
      const bt = this.typeOf(callee.base);
      if (bt.k === 'fb' && bt.name.toUpperCase() === callee.member.toUpperCase()) callee = callee.base;
    }
    if (callee.kind === 'var' && !this.lookup(callee.name, callee.scope)) {
      throw this.err(`Unknown function or block '${callee.name}'`, e.line);
    }
    const t = this.typeOf(callee);
    if (t.k !== 'fb') throw this.err(`'${exprName(e.callee)}' is not a function block instance`, e.line);
    return t;
  }

  private stdType(key: string, e: Extract<Expr, { kind: 'call' }>): DataType {
    const args = this.stdArgs(key, e);
    const argType = (i: number) => this.typeOf(args[i]);
    const numeric = (i: number) => {
      const t = argType(i);
      if (!isNumeric(t)) throw this.err(`${key}: argument ${i + 1} must be numeric, not ${typeName(t)}`, e.line);
      return t;
    };
    const floatOf = (t: DataType) => (t.k === 'elem' && t.name === 'REAL' ? T.REAL : T.LREAL);
    switch (key) {
      case 'ABS':
      case 'SQR': {
        const t = numeric(0);
        return t.k === 'anyint' ? T.DINT : t.k === 'anyreal' ? T.LREAL : t;
      }
      case 'SQRT': case 'EXP': case 'LN': case 'SIN': case 'COS': case 'TAN': case 'ASIN': case 'ACOS': case 'ATAN':
      case 'FRAC': case 'ROUND':
        return floatOf(numeric(0));
      case 'TRUNC': case 'CEIL': case 'FLOOR':
        numeric(0);
        return T.DINT;
      case 'EXPT':
        numeric(0);
        numeric(1);
        return T.LREAL;
      case 'MIN': case 'MAX': case 'LIMIT': {
        let t = numeric(0);
        for (let i = 1; i < args.length; i++) t = unifyNumeric(t, numeric(i))!;
        return t.k === 'anyint' ? T.DINT : t.k === 'anyreal' ? T.LREAL : t;
      }
      case 'SEL': {
        if (!isBool(argType(0))) throw this.err('SEL: G must be a Bool', e.line);
        return this.unifyAny(argType(1), argType(2), e.line);
      }
      case 'MUX': {
        if (!isInt(argType(0))) throw this.err('MUX: K must be an integer', e.line);
        let t = argType(1);
        for (let i = 2; i < args.length; i++) t = this.unifyAny(t, argType(i), e.line);
        return t;
      }
      case 'NORM_X': case 'SCALE_X':
        [0, 1, 2].forEach(numeric);
        return T.REAL;
      case 'SHL': case 'SHR': {
        const t = argType(0);
        if (!isInt(t) || !isInt(argType(1))) throw this.err(`${key} needs integer arguments`, e.line);
        return t.k === 'anyint' ? T.DINT : t;
      }
      case 'CONCAT':
        return { k: 'string', length: STRING_SCRATCH };
      case 'LEN':
        if (!isString(argType(0))) throw this.err('LEN needs a String', e.line);
        return T.INT;
      case 'MILLIS':
        return T.elem('UDINT');
      case 'DEVICE_OK':
      case 'DEVICE_DIAG':
      case 'PN_ALARM':
        return T.BOOL;
      default:
        return T.VOID; // LOG, WAIT
    }
  }

  private unifyAny(a: DataType, b: DataType, line: number): DataType {
    if (isNumeric(a) && isNumeric(b)) {
      const t = unifyNumeric(a, b)!;
      return t.k === 'anyint' ? T.DINT : t.k === 'anyreal' ? T.LREAL : t;
    }
    if (isString(a) && isString(b)) return { k: 'string', length: STRING_SCRATCH };
    if (isBool(a) && isBool(b)) return T.BOOL;
    throw this.err(`Incompatible types ${typeName(a)} and ${typeName(b)}`, line);
  }

  /** Maps named/positional arguments of a standard function to positional order. */
  private stdArgs(key: string, e: Extract<Expr, { kind: 'call' }>): Expr[] {
    const params = STD_PARAMS[key];
    for (const a of e.args) if (a.output) throw this.err(`${key} has no output parameters`, e.line);
    if (params === null) {
      if (e.args.some((a) => a.name !== null && !/^IN\d+$/i.test(a.name))) throw this.err(`${key}: unknown parameter`, e.line);
      const minArgs: Record<string, number> = { MIN: 2, MAX: 2, MUX: 2, CONCAT: 1, LOG: 1 };
      if (e.args.length < (minArgs[key] ?? 0)) throw this.err(`${key} needs at least ${minArgs[key]} arguments`, e.line);
      return e.args.map((a) => a.value);
    }
    const out: Array<Expr | undefined> = new Array(params.length);
    e.args.forEach((a, i) => {
      const idx = a.name === null ? i : params.indexOf(a.name.toUpperCase());
      if (idx < 0 || idx >= params.length) throw this.err(a.name === null ? `Too many arguments for ${key}` : `${key} has no parameter '${a.name}'`, e.line);
      out[idx] = a.value;
    });
    if (out.some((x) => x === undefined) || out.length !== params.length) {
      throw this.err(`${key} expects ${params.length} argument${params.length === 1 ? '' : 's'} (${params.join(', ')})`, e.line);
    }
    return out as Expr[];
  }

  private call(e: Extract<Expr, { kind: 'call' }>): void {
    const c = e.callee;
    if (c.kind === 'var' && c.scope !== 'local') {
      const key = c.name.toUpperCase();
      if (c.scope === null && !this.lookup(c.name, null)) {
        const conv = conversion(key);
        if (conv) return this.conversionCall(conv, e);
        if (key === 'RD_SYS_T' || key === 'RD_LOC_T') return this.readClock(key, e);
        if (key in STD_PARAMS) return this.stdCall(key, e);
      }
      const pou = this.pous.get(key);
      if (pou && pou.kind === 'FUNCTION') return this.callFunction(pou, e);
    }
    this.callInstance(e);
  }

  private conversionCall([from, to]: [DataType, DataType], e: Extract<Expr, { kind: 'call' }>): void {
    if (e.args.length !== 1 || e.args[0].output || (e.args[0].name !== null && e.args[0].name.toUpperCase() !== 'IN')) {
      throw this.err(`${exprName(e.callee)} takes exactly one argument (IN)`, e.line);
    }
    const arg = e.args[0].value;
    const at = this.typeOf(arg);
    if (this.temporalConversion(from, to, arg, at, e)) return;
    // The argument must be compatible with the source type of the conversion.
    const compatible = isString(from) ? isString(at)
      : isBool(from) ? isBool(at)
        : isFloat(from) ? isNumeric(at)
          : isInt(at);
    if (!compatible) throw this.err(`${exprName(e.callee)} expects ${typeName(from)}, got ${typeName(at)}`, e.line);

    if (isString(to)) {
      const slot = this.scratch(STRING_SCRATCH + 2, true);
      this.emit(Op.PUSH_ADDR, Area.D, slot);
      if (isString(from)) {
        this.stringValue(arg);
        this.emit(Op.CALL_STD, StdFn.SASSIGN, 2);
        this.emit(Op.PUSH_ADDR, Area.D, slot);
        return;
      }
      this.expr(arg, from);
      this.emit(Op.CALL_STD, isBool(from) ? StdFn.B2S : isFloat(from) ? StdFn.F2S : StdFn.I2S, 2);
      return;
    }
    if (isString(from)) {
      this.stringValue(arg);
      this.emit(Op.CALL_STD, isFloat(to) ? StdFn.S2F : StdFn.S2I, 1);
      if (isBool(to)) this.emit(Op.BOOL);
      else if (to.k === 'elem' && isInt(to)) this.emit(Op.WRAP, ELEMENTARY[to.name].vm);
      return;
    }
    this.expr(arg, from);
    if (isBool(to)) {
      if (isFloat(from)) {
        this.emit(Op.PUSH_F64, 0);
        this.emit(Op.FNE);
      } else {
        this.emit(Op.BOOL);
      }
    } else if (isFloat(to)) {
      if (!isFloat(from)) this.emit(Op.I2F);
      if (to.k === 'elem' && to.name === 'REAL') this.emit(Op.F32);
    } else {
      if (isFloat(from)) this.emit(Op.F2I_ROUND);
      if (to.k === 'elem') this.emit(Op.WRAP, ELEMENTARY[to.name].vm);
    }
  }

  /**
   * Conversions between dates, times, durations and characters (LDT_TO_DTL, DT_TO_DATE, TIME_TO_LTIME,
   * CHAR_TO_STRING...). Returns false when the pair is not one of them (generic numeric conversion).
   */
  private temporalConversion(from: DataType, to: DataType, arg: Expr, at: DataType, e: Extract<Expr, { kind: 'call' }>): boolean {
    const name = (t: DataType) => (t.k === 'elem' ? t.name : t.k === 'struct' && t.key === DTL_KEY ? 'DTL' : t.k === 'string' ? 'STRING' : '');
    const [f, t] = [name(from), name(to)];
    const DATETIME = ['DT', 'LDT', 'DTL'];
    const chars = ['CHAR', 'WCHAR'];
    if (!(DATETIME.includes(f) || DATETIME.includes(t) || (chars.includes(f) && t === 'STRING') || (f === 'STRING' && chars.includes(t))
      || ['TIME_LTIME', 'LTIME_TIME', 'TOD_LTOD', 'LTOD_TOD', 'DATE_LDT'].includes(`${f}_${t}`))) return false;
    if (!sameType(at, from) && !(from.k === 'string' && isString(at)) && !(at.k === 'anyint' && from.k === 'elem')) {
      throw this.err(`${exprName(e.callee)} expects ${typeName(from)}, got ${typeName(at)}`, e.line);
    }
    // 1. the argument as an LDT (ns since 1970) when it is a date and time
    const toLdt = () => {
      if (f === 'LDT') this.expr(arg, from);
      else if (f === 'DT') {
        this.expr(arg, from);
        this.emit(Op.CALL_STD, StdFn.DT2LDT, 1);
      } else {
        this.pushAddress(this.place(arg));
        this.emit(Op.CALL_STD, StdFn.DTL2LDT, 1);
      }
    };
    const scale = (factor: bigint, divide: boolean) => {
      this.pushBig(factor);
      this.emit(divide ? Op.DIV : Op.MUL);
    };
    switch (`${f}_${t}`) {
      case 'TIME_LTIME': this.expr(arg, from); scale(1_000_000n, false); return true;
      case 'LTIME_TIME': this.expr(arg, from); scale(1_000_000n, true); this.emit(Op.WRAP, VmType.I32); return true;
      case 'TOD_LTOD': this.expr(arg, from); scale(1_000_000n, false); return true;
      case 'LTOD_TOD': this.expr(arg, from); scale(1_000_000n, true); return true;
      case 'DATE_LDT': this.expr(arg, from); this.pushInt(7305); this.emit(Op.ADD); scale(NS_PER_DAY, false); return true;
      case 'CHAR_STRING':
      case 'WCHAR_STRING': {
        const slot = this.scratch(STRING_SCRATCH + 2, true);
        this.emit(Op.PUSH_ADDR, Area.D, slot);
        this.expr(arg, from);
        this.emit(Op.CALL_STD, StdFn.C2S, 2);
        return true;
      }
      case 'STRING_CHAR':
      case 'STRING_WCHAR':
        this.stringValue(arg);
        this.emit(Op.CALL_STD, StdFn.S2C, 1);
        return true;
    }
    if (!DATETIME.includes(f)) throw this.err(`${exprName(e.callee)} is not supported`, e.line);
    toLdt();
    switch (t) {
      case 'LDT': return true;
      case 'DT': this.emit(Op.CALL_STD, StdFn.LDT2DT, 1); return true;
      case 'DTL': {
        // result in a scratch DTL: its address is the value
        const slot = this.scratch(12);
        this.emit(Op.PUSH_ADDR, Area.D, slot);
        this.emit(Op.SWAP);
        this.emit(Op.CALL_STD, StdFn.LDT2DTL, 2);
        this.emit(Op.PUSH_ADDR, Area.D, slot);
        return true;
      }
      case 'DATE': scale(NS_PER_DAY, true); this.pushInt(7305); this.emit(Op.SUB); return true;
      case 'TOD': this.pushBig(NS_PER_DAY); this.emit(Op.MOD); scale(1_000_000n, true); return true;
      case 'LTOD': this.pushBig(NS_PER_DAY); this.emit(Op.MOD); return true;
      default: throw this.err(`${exprName(e.callee)} is not supported`, e.line);
    }
  }

  /** RD_SYS_T / RD_LOC_T (OUT => DTL, LDT or DT): date and time of the CPU (UTC / local). Returns 0. */
  private readClock(key: string, e: Extract<Expr, { kind: 'call' }>): void {
    const out = e.args.find((a) => a.output && a.name?.toUpperCase() === 'OUT');
    if (!out || e.args.length !== 1) throw this.err(`${key} expects one output parameter: ${key}(OUT => ...)`, e.line);
    const dest = this.place(out.value);
    this.checkWritable(dest, e.line);
    const t = dest.type;
    const isDtl = t.k === 'struct' && t.key === DTL_KEY;
    if (!isDtl && !(t.k === 'elem' && (t.name === 'LDT' || t.name === 'DT'))) {
      throw this.err(`${key}: OUT must be a DTL, LDT or DATE_AND_TIME, not ${typeName(t)}`, e.line);
    }
    if (isDtl) this.pushAddress(dest);
    this.pushInt(key === 'RD_LOC_T' ? 1 : 0);
    this.emit(Op.SYS, SysFn.CLOCK, 1);
    if (isDtl) {
      this.emit(Op.CALL_STD, StdFn.LDT2DTL, 2);
    } else {
      if (t.k === 'elem' && t.name === 'DT') this.emit(Op.CALL_STD, StdFn.LDT2DT, 1);
      this.storePlace(dest, t, e.line);
    }
    this.pushInt(0);
  }

  private stdCall(key: string, e: Extract<Expr, { kind: 'call' }>): void {
    const args = this.stdArgs(key, e);
    const result = this.stdType(key, e);
    const f = isFloat(result);
    switch (key) {
      case 'ABS':
        this.expr(args[0], result);
        this.emit(f ? Op.FABS : Op.ABS);
        return;
      case 'SQR':
        this.expr(args[0], result);
        this.emit(Op.DUP);
        this.emit(f ? Op.FMUL : Op.MUL);
        return;
      case 'TRUNC': case 'CEIL': case 'FLOOR':
        this.expr(args[0], T.LREAL);
        if (key !== 'TRUNC') this.emit(Op.FMATH, key === 'CEIL' ? MathFn.CEIL : MathFn.FLOOR);
        this.emit(Op.F2I_TRUNC);
        this.emit(Op.WRAP, VmType.I32);
        return;
      case 'EXPT':
        this.expr(args[0], T.LREAL);
        this.expr(args[1], T.LREAL);
        this.emit(Op.FPOW);
        return;
      case 'MIN': case 'MAX': case 'LIMIT': {
        args.forEach((a) => this.expr(a, result));
        const fn = { MIN: [StdFn.MIN, StdFn.FMIN], MAX: [StdFn.MAX, StdFn.FMAX], LIMIT: [StdFn.LIMIT, StdFn.FLIMIT] }[key]!;
        this.emit(Op.CALL_STD, f ? fn[1] : fn[0], args.length);
        return;
      }
      case 'SEL':
        this.expr(args[0], T.BOOL);
        args.slice(1).forEach((a) => (isString(result) ? this.stringValue(a) : this.expr(a, result)));
        this.emit(Op.CALL_STD, StdFn.SEL, 3);
        return;
      case 'MUX':
        this.expr(args[0], T.LINT);
        args.slice(1).forEach((a) => (isString(result) ? this.stringValue(a) : this.expr(a, result)));
        this.emit(Op.CALL_STD, StdFn.MUX, args.length);
        return;
      case 'NORM_X': case 'SCALE_X':
        args.forEach((a) => this.expr(a, T.LREAL));
        this.emit(Op.CALL_STD, key === 'NORM_X' ? StdFn.NORM_X : StdFn.SCALE_X, 3);
        this.emit(Op.F32);
        return;
      case 'SHL': case 'SHR':
        this.expr(args[0], result);
        this.expr(args[1], T.LINT);
        this.emit(key === 'SHL' ? Op.SHL : Op.SHR);
        if (result.k === 'elem') this.emit(Op.WRAP, ELEMENTARY[result.name].vm);
        return;
      case 'CONCAT': {
        const slot = this.scratch(STRING_SCRATCH + 2, true);
        this.emit(Op.PUSH_ADDR, Area.D, slot);
        args.forEach((a) => this.stringValue(a));
        this.emit(Op.CALL_STD, StdFn.CONCAT, args.length + 1);
        return;
      }
      case 'LEN':
        this.stringValue(args[0]);
        this.emit(Op.CALL_STD, StdFn.LEN, 1);
        return;
      case 'LOG':
        args.forEach((a) => this.toStringValue(a));
        this.emit(Op.SYS, SysFn.LOG, args.length);
        return;
      case 'WAIT': {
        if (this.fn?.pou.kind !== 'ORGANIZATION_BLOCK') throw this.err('WAIT can only be used in an organization block', e.line);
        const t = this.typeOf(args[0]);
        if (!isInt(t)) throw this.err('WAIT expects a duration in milliseconds (integer or TIME)', e.line);
        this.expr(args[0], T.LINT);
        this.emit(Op.SYS, SysFn.WAIT, 1);
        return;
      }
      case 'MILLIS':
        this.emit(Op.SYS, SysFn.MILLIS, 0);
        return;
      case 'DEVICE_OK':
      case 'DEVICE_DIAG':
      case 'PN_ALARM': {
        const a = args[0];
        const name = a.kind === 'var' ? a.name : a.kind === 'string' ? a.value : null;
        const index = name === null ? undefined : this.modules.get(name.toUpperCase());
        if (index === undefined) throw this.err(`${key}: unknown I/O module${name ? ` '${name}'` : ''} (see the device configuration)`, e.line);
        this.pushInt(index);
        if (key === 'PN_ALARM') {
          const kind = (this.options.hardware ?? [])[index]?.kind;
          if (kind !== 'profinet-device') throw this.err(`PN_ALARM: '${name}' is not a PROFINET IO-Device module of this CPU`, e.line);
          if (args.length !== 4) throw this.err('PN_ALARM expects MODULE, SLOT, KIND (1 diagnosis, 12 diagnosis gone, 2 process) and CODE', e.line);
          for (const x of args.slice(1)) {
            if (!isInt(this.typeOf(x))) throw this.err('PN_ALARM: SLOT, KIND and CODE are integers', e.line);
            this.expr(x, T.LINT);
          }
          this.emit(Op.SYS, SysFn.PN_ALARM, 4);
          return;
        }
        this.emit(Op.SYS, SysFn[key], 1);
        return;
      }
      default:
        this.expr(args[0], result);
        this.emit(Op.FMATH, MATH[key]);
        if (result.k === 'elem' && result.name === 'REAL') this.emit(Op.F32);
    }
  }

  /** Pushes a STRING pointer for LOG: strings as is, other values converted. */
  private toStringValue(a: Expr): void {
    const t = this.typeOf(a);
    if (isString(t)) {
      this.stringValue(a);
      return;
    }
    const slot = this.scratch(40, true);
    this.emit(Op.PUSH_ADDR, Area.D, slot);
    if (isBool(t)) {
      this.expr(a, T.BOOL);
      this.emit(Op.CALL_STD, StdFn.B2S, 2);
    } else if (isFloat(t)) {
      this.expr(a, T.LREAL);
      this.emit(Op.CALL_STD, StdFn.F2S, 2);
    } else if (isInt(t)) {
      this.expr(a, T.LINT);
      this.emit(Op.CALL_STD, StdFn.I2S, 2);
    } else {
      throw this.err(`LOG cannot print ${typeName(t)}`, a.line);
    }
  }

  private callFunction(pou: Pou, e: Extract<Expr, { kind: 'call' }>): void {
    const callee = this.functions.get(pou.name.toUpperCase())!;
    this.callGraph.get(this.fn!.pou.name.toUpperCase())?.add(pou.name.toUpperCase());

    const inputs = callee.params.filter((p) => p.section !== 'output');
    const byName = new Map(callee.params.map((p) => [p.name.toUpperCase(), p]));
    const given = new Map<string, CallArg>();
    e.args.forEach((a, i) => {
      const p = a.name === null ? inputs[i] : byName.get(a.name.toUpperCase());
      if (!p) throw this.err(a.name === null ? `Too many arguments for '${pou.name}'` : `'${pou.name}' has no parameter '${a.name}'`, e.line);
      if (given.has(p.name.toUpperCase())) throw this.err(`Parameter '${p.name}' given twice`, e.line);
      if (p.section === 'output' && !a.output) throw this.err(`'${p.name}' is an output of '${pou.name}': use '=>' instead of ':='`, e.line);
      if (p.section !== 'output' && a.output) throw this.err(`'${p.name}' is an input of '${pou.name}': use ':=' instead of '=>'`, e.line);
      given.set(p.name.toUpperCase(), a);
    });
    for (const p of inputs) {
      if (!given.has(p.name.toUpperCase())) throw this.err(`Missing parameter '${p.name}' in call to '${pou.name}'`, e.line);
    }

    // Evaluate every input first (a nested call to the same FC would overwrite its frame), then store.
    const stores: Array<() => void> = [];
    for (const p of inputs) {
      const a = given.get(p.name.toUpperCase())!;
      const sym = callee.locals.get(p.name.toUpperCase()) as Extract<Sym, { k: 'var' | 'ref' }>;
      if (p.section === 'inout') {
        const target = this.place(a.value);
        if (!sameType(target.type, sym.type) && !(isString(target.type) && isString(sym.type))) {
          throw this.err(`In-out parameter '${p.name}' expects ${typeName(sym.type)}, got ${typeName(target.type)}`, e.line);
        }
        this.checkWritable(target, e.line);
        this.pushAddress(target);
        stores.push(() => this.emit(Op.STORE, VmType.PTR, Area.D, sym.offset));
      } else if (isString(sym.type)) {
        this.stringValue(a.value);
        stores.push(() => {
          this.emit(Op.PUSH_ADDR, Area.D, sym.offset);
          this.emit(Op.SWAP);
          this.emit(Op.CALL_STD, StdFn.SASSIGN, 2);
        });
      } else if (sym.type.k === 'array' || sym.type.k === 'struct') {
        const at = this.typeOf(a.value);
        if (!sameType(at, sym.type)) throw this.err(`Parameter '${p.name}' expects ${typeName(sym.type)}, got ${typeName(at)}`, e.line);
        this.pushAddress(this.place(a.value));
        stores.push(() => {
          this.emit(Op.PUSH_ADDR, Area.D, sym.offset);
          this.emit(Op.SWAP);
          this.emit(Op.COPY, this.sizeOf(sym.type));
        });
      } else {
        this.expr(a.value, sym.type);
        stores.push(() => this.emit(Op.STORE, ELEMENTARY[(sym.type as { name: Elementary }).name].vm, Area.D, sym.offset));
      }
    }
    for (const s of stores.reverse()) s();
    this.emit(Op.CALL, callee.index);

    // Outputs
    for (const p of callee.params.filter((x) => x.section === 'output')) {
      const a = given.get(p.name.toUpperCase());
      if (!a) continue;
      const sym = callee.locals.get(p.name.toUpperCase()) as Extract<Sym, { k: 'var' }>;
      this.copyOut(a.value, { k: 'static', type: sym.type, area: 'D', offset: sym.offset }, e.line);
    }

    if (callee.returnSlot >= 0) {
      const rt = this.resolveType(pou.returnType!);
      this.loadPlace({ k: 'static', type: rt, area: 'D', offset: callee.returnSlot });
    }
  }

  /** Copies a value from `source` into the lvalue `target` (for => outputs). */
  private copyOut(target: Expr, source: Place, line: number): void {
    const dest = this.place(target);
    this.checkWritable(dest, line);
    if (isString(dest.type)) {
      if (!isString(source.type)) throw this.err(`Cannot assign ${typeName(source.type)} to ${typeName(dest.type)}`, line);
      this.pushAddress(dest);
      this.pushAddress(source);
      this.emit(Op.CALL_STD, StdFn.SASSIGN, 2);
      return;
    }
    if (dest.type.k === 'array' || dest.type.k === 'struct') {
      if (!sameType(dest.type, source.type)) throw this.err(`Cannot assign ${typeName(source.type)} to ${typeName(dest.type)}`, line);
      if (source.k !== 'static') throw this.err(`Cannot copy ${typeName(source.type)} from this output`, line);
      this.pushAddress(dest);
      this.pushAddress(source);
      this.emit(Op.COPY, this.sizeOf(dest.type));
      return;
    }
    this.loadPlace(source);
    this.storePlace(dest, this.convert(source.type, dest.type, line), line);
  }

  private callInstance(e: Extract<Expr, { kind: 'call' }>): void {
    const fbType = this.instanceType(e);
    let callee = e.callee;
    if (callee.kind === 'member' && this.typeOf(callee.base).k === 'fb'
      && (this.typeOf(callee.base) as { name: string }).name.toUpperCase() === callee.member.toUpperCase()) {
      callee = callee.base;
    }
    const layout = this.fbLayout(fbType);
    const pou = fbType.library ? null : this.pous.get(fbType.name.toUpperCase())!;
    if (pou) this.callGraph.get(this.fn!.pou.name.toUpperCase())?.add(pou.name.toUpperCase());

    // Instance location: static, or a pointer kept in a scratch slot.
    let instance = this.place(callee);
    if (instance.k === 'dynamic') {
      const slot = this.scratch(8);
      this.emit(Op.STORE, VmType.PTR, Area.D, slot);
      instance = { k: 'dynamic', type: instance.type };
      const ptrSlot = slot;
      const memberPlace = (m: Member): Place => {
        this.emit(Op.LOAD, VmType.PTR, Area.D, ptrSlot);
        this.emit(Op.OFFSET, m.offset);
        return { k: 'dynamic', type: m.type };
      };
      this.instanceCall(e, fbType, layout, pou, memberPlace, () => this.emit(Op.LOAD, VmType.PTR, Area.D, ptrSlot));
      return;
    }
    if (instance.k !== 'static') throw this.err('Invalid function block instance', e.line);
    const base = instance;
    this.instanceCall(
      e, fbType, layout, pou,
      (m) => ({ k: 'static', type: m.type, area: base.area, offset: base.offset + m.offset }),
      () => this.emit(Op.PUSH_ADDR, AREA_CODE[base.area], base.offset),
    );
  }

  private instanceCall(
    e: Extract<Expr, { kind: 'call' }>,
    fbType: Extract<DataType, { k: 'fb' }>,
    layout: Layout,
    pou: Pou | null,
    memberPlace: (m: Member) => Place,
    pushInstance: () => void,
  ): void {
    const seen = new Set<string>();
    const outputs: Array<{ member: Member; target: Expr }> = [];
    const inouts: Array<{ member: Member; target: Expr }> = [];
    const stores: Array<() => void> = [];

    for (const a of e.args) {
      if (a.name === null) throw this.err(`Function block ${fbType.name} must be called with named parameters (IN := ...)`, e.line);
      const m = layout.members.get(a.name.toUpperCase());
      const isInterface = m && (m.section === 'input' || m.section === 'output' || m.section === 'inout'
        || (m.section === 'library' && !Object.hasOwn(LIBRARY_BLOCKS[fbType.name.toUpperCase()]?.hidden ?? {}, m.name)));
      if (!m || !isInterface) throw this.err(`'${fbType.name}' has no parameter '${a.name}'`, e.line);
      if (seen.has(m.name.toUpperCase())) throw this.err(`Parameter '${m.name}' given twice`, e.line);
      seen.add(m.name.toUpperCase());
      const isOutput = m.section === 'output' || (m.section === 'library' && libraryIsOutput(fbType.name, m.name));
      if (isOutput && !a.output) throw this.err(`'${a.name}' is an output of '${fbType.name}': use '=>' instead of ':='`, e.line);
      if (!isOutput && a.output) throw this.err(`'${a.name}' is an input of '${fbType.name}': use ':=' instead of '=>'`, e.line);
      if (isOutput) {
        outputs.push({ member: m, target: a.value });
      } else if (m.section === 'inout') {
        inouts.push({ member: m, target: a.value });
        const target = this.place(a.value);
        this.checkWritable(target, e.line);
        if (!sameType(target.type, m.type)) throw this.err(`In-out parameter '${m.name}' expects ${typeName(m.type)}, got ${typeName(target.type)}`, e.line);
        this.pushAddress(target);
        stores.push(() => {
          const p = memberPlace({ ...m, type: T.LINT });
          if (p.k === 'static') this.emit(Op.STORE, VmType.PTR, AREA_CODE[p.area], p.offset);
          else {
            this.emit(Op.SWAP);
            this.emit(Op.STORE_IND, VmType.PTR);
          }
        });
      } else if (m.type.k === 'array' || m.type.k === 'struct') {
        const at = this.typeOf(a.value);
        if (!sameType(at, m.type)) throw this.err(`Parameter '${m.name}' expects ${typeName(m.type)}, got ${typeName(at)}`, e.line);
        this.pushAddress(this.place(a.value));
        stores.push(() => {
          this.pushAddress(memberPlace(m));
          this.emit(Op.SWAP);
          this.emit(Op.COPY, this.sizeOf(m.type));
        });
      } else if (isString(m.type)) {
        this.stringValue(a.value);
        stores.push(() => {
          const p = memberPlace(m);
          this.pushAddress(p);
          this.emit(Op.SWAP);
          this.emit(Op.CALL_STD, StdFn.SASSIGN, 2);
        });
      } else {
        this.expr(a.value, m.type);
        stores.push(() => {
          const p = memberPlace(m);
          if (p.k === 'dynamic') this.emit(Op.SWAP);
          this.storePlace(p, m.type, e.line);
        });
      }
    }
    if (pou) {
      for (const m of layout.members.values()) {
        if (m.section === 'inout' && !seen.has(m.name.toUpperCase())) {
          throw this.err(`Missing in-out parameter '${m.name}' in call to '${fbType.name}'`, e.line);
        }
      }
    }
    for (const s of stores.reverse()) s();

    pushInstance();
    if (fbType.library) {
      this.emit(Op.CALL_LIB, LIBRARY_BLOCKS[fbType.name.toUpperCase()].code);
    } else {
      this.emit(Op.CALL_FB, this.functions.get(fbType.name.toUpperCase())!.index);
    }

    for (const o of outputs) {
      const source = memberPlace(o.member);
      if (source.k === 'dynamic') {
        // pointer is on the stack: load value into a scratch cell first
        const slot = this.scratch(8);
        this.loadPlace(source);
        this.emit(Op.STORE, isFloat(o.member.type) ? VmType.F64 : VmType.I64, Area.D, slot);
        const dest = this.place(o.target);
        this.checkWritable(dest, e.line);
        this.emit(Op.LOAD, isFloat(o.member.type) ? VmType.F64 : VmType.I64, Area.D, slot);
        this.storePlace(dest, this.convert(o.member.type, dest.type, e.line), e.line);
      } else {
        this.copyOut(o.target, source, e.line);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Recursion check, linking
  // -------------------------------------------------------------------------

  private checkRecursion(): void {
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string, path: string[]): void => {
      if (state.get(name) === 'done') return;
      if (state.get(name) === 'visiting') {
        const cycle = [...path.slice(path.indexOf(name)), name].map((n) => this.pous.get(n)!.name).join(' -> ');
        const pou = this.pous.get(name)!;
        throw this.err(`Recursive calls are not allowed: ${cycle}`, pou.line, pou.file);
      }
      state.set(name, 'visiting');
      for (const next of this.callGraph.get(name) ?? []) visit(next, [...path, name]);
      state.set(name, 'done');
    };
    for (const name of this.callGraph.keys()) visit(name, []);
  }

  private link(): CompileResult {
    const ordered = [...this.functions.values()].sort((a, b) => a.index - b.index);
    const find = (names: string[]) => ordered.find((f) => f.pou.kind === 'ORGANIZATION_BLOCK' && names.includes(f.pou.name.toUpperCase()));
    const main = find(this.options.mainOb ? [this.options.mainOb.toUpperCase()] : ['MAIN', 'OB1', 'OB_MAIN']);
    const startup = find(this.options.startupOb ? [this.options.startupOb.toUpperCase()] : ['STARTUP', 'OB100', 'COMPLETE_RESTART']);
    if (!main) this.diagnostics.push({ severity: 'warning', message: 'No cyclic organization block "Main" (OB1): the CPU will run without program logic' });

    const entries: FunctionEntry[] = ordered.map((f) => ({ codeOffset: f.codeOffset, frameOffset: f.zeroOffset, frameSize: f.zeroSize }));
    const initBytes = this.init.bytes.subarray(0, this.init.used);
    const hardware = this.options.hardware ?? [];
    for (const m of hardware) {
      for (const [area, byte, count, unit] of ioUsage(m)) {
        if (count > 0) this.imageSize[area] = Math.max(this.imageSize[area], byte + (unit === 'bits' ? Math.ceil(count / 8) : unit === 'words' ? count * 2 : count));
      }
    }
    const hmiSymbols = this.hmiSymbols();
    const dbs = this.dbTable();
    const image = buildImage({
      name: this.options.name ?? 'program',
      compilerVersion: COMPILER_VERSION,
      buildTime: this.options.buildTime ?? Math.floor(Date.now() / 1000),
      dataSize: this.dataTop,
      imageSizes: this.imageSize,
      stackCells: 256,
      callDepth: 32,
      cycleMs: Math.max(1, Math.min(60000, Math.round(this.options.cycleMs ?? 10))),
      code: this.code.toBytes(),
      consts: this.consts.toBytes(),
      init: initBytes,
      functions: entries,
      startup: startup?.index ?? 0xffff,
      main: main?.index ?? 0xffff,
      lines: this.lines,
      hardware,
      symbols: hmiSymbols,
      dbs,
      services: this.options.services,
    });
    const crc = new DataView(image.buffer, image.byteOffset + image.length - 4, 4).getUint32(0, true);
    return {
      ...this.result(),
      ok: true,
      image,
      programId: crc.toString(16).padStart(8, '0'),
      hmiSymbols,
      dbs,
    };
  }

  /** Flattens the symbol tree into the variables visible to HMIs. */
  private hmiSymbols(): HmiSymbol[] {
    const norm = (p: string) => p.replace(/"/g, '').replace(/\[[^\]]*\]/g, '').toLowerCase();
    const hidden = new Set((this.options.hmi?.hidden ?? []).map(norm));
    const readOnly = new Set((this.options.hmi?.readOnly ?? []).map(norm));
    const out: HmiSymbol[] = [];
    const walk = (n: SymbolNode, path: string[], key: string, ro: boolean) => {
      if (hidden.has(key)) return;
      const locked = ro || readOnly.has(key) || n.area === 'I';
      if (n.children) {
        for (const c of n.children) {
          const isIndex = c.name.startsWith('[');
          const p = isIndex ? [...path.slice(0, -1), `${path[path.length - 1]}${c.name}`] : [...path, c.name];
          walk(c, p, isIndex ? key : `${key}.${c.name.toLowerCase()}`, locked);
        }
        return;
      }
      const type = n.kind === 'string' ? HMI_STRING : n.kind === 'time' ? HMI_TIME : n.vmType;
      if (type === undefined || out.length >= 65535) return;
      out.push({ path, area: n.area, offset: n.offset, bit: n.bit, type, size: n.size, writable: !locked });
    };
    for (const s of this.symbols) walk(s, [s.name], s.name.toLowerCase(), false);
    return out;
  }

  /** Numbered data blocks and their location in the data memory. */
  private dbTable(): DbEntry[] {
    const numbers = new Map(Object.entries(this.options.dbNumbers ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
    const out: DbEntry[] = [];
    for (const db of this.dataBlocks.values()) {
      const n = numbers.get(db.name.toUpperCase());
      const sym = this.globals.get(db.name.toUpperCase());
      if (n === undefined || sym?.k !== 'var') continue;
      out.push({ number: n, name: db.name, offset: sym.offset, size: this.sizeOf(sym.type) });
    }
    return out.sort((a, b) => a.number - b.number);
  }

  private result(): CompileResult {
    const ordered = [...this.functions.values()].sort((a, b) => a.index - b.index);
    return {
      ok: false,
      diagnostics: this.diagnostics,
      symbols: this.symbols,
      functions: ordered.map((f) => ({ name: f.pou.name, kind: f.pou.kind, file: f.pou.file })),
      stats: {
        code: this.code.length, data: this.dataTop, constants: this.consts.length,
        inputs: this.imageSize.I, outputs: this.imageSize.Q, memory: this.imageSize.M,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Emission helpers
  // -------------------------------------------------------------------------

  private emit(op: number, ...operands: Array<number | bigint>): void {
    const kinds = OPERANDS[op];
    if (kinds.length !== operands.length) throw new Error(`Internal: bad operand count for opcode ${op}`);
    this.code.u8(op);
    kinds.forEach((k, i) => {
      const v = operands[i];
      switch (k) {
        case 'u8': this.code.u8(Number(v)); break;
        case 'u16': this.code.u16(Number(v)); break;
        case 'u32': this.code.u32(Number(v)); break;
        case 'i32': this.code.i32(Number(v)); break;
        case 'i64': this.code.i64(v); break;
        case 'f64': this.code.f64(Number(v)); break;
        default: throw new Error(`Internal: unknown operand kind ${k}`);
      }
    });
  }

  private pushInt(v: number): void {
    if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) this.emit(Op.PUSH_I32, v);
    else this.emit(Op.PUSH_I64, BigInt(Math.trunc(v)));
  }

  private pushBig(v: bigint): void {
    if (v >= -0x80000000n && v <= 0x7fffffffn) this.emit(Op.PUSH_I32, Number(v));
    else this.emit(Op.PUSH_I64, BigInt.asIntN(64, v));
  }

  /** Start value of a DTL from DTL#... (ns since 1970) */
  private dtlInit(offset: number, ns: bigint): void {
    const days = Number(ns / NS_PER_DAY);
    const rest = ns - BigInt(days) * NS_PER_DAY;
    const c = civilFromDays(days);
    const put = (at: number, size: number, v: number) => this.init.write(offset + at, size, 'int', v);
    put(0, 2, c.year);
    put(2, 1, c.month);
    put(3, 1, c.day);
    put(4, 1, c.weekday);
    put(5, 1, Number(rest / 3_600_000_000_000n));
    put(6, 1, Number((rest / 60_000_000_000n) % 60n));
    put(7, 1, Number((rest / 1_000_000_000n) % 60n));
    put(8, 4, Number(rest % 1_000_000_000n));
  }

  private pushConst(value: number | boolean | string | bigint, t: DataType): void {
    if (typeof value === 'bigint') this.pushBig(value);
    else if (typeof value === 'boolean') this.pushInt(value ? 1 : 0);
    else if (typeof value === 'string') this.emit(Op.PUSH_ADDR, Area.C, this.constString(value));
    else if (isFloat(t)) this.emit(Op.PUSH_F64, value);
    else this.pushInt(value);
  }

  /** Emits a jump with a placeholder target; returns the patch position. */
  private jump(op: number): number {
    this.emit(op, 0);
    return this.code.length - 4;
  }

  private jumpTo(op: number, target: number): void {
    this.emit(op, 0);
    this.patch(this.code.length - 4, target);
  }

  private bind(patchAt: number): void {
    this.patch(patchAt, this.code.length);
  }

  private patch(patchAt: number, target: number): void {
    this.code.patchI32(patchAt, target - (patchAt + 4));
  }

  private constString(s: string): number {
    const cached = this.constStrings.get(s);
    if (cached !== undefined) return cached;
    const bytes = new TextEncoder().encode(s).subarray(0, 254);
    const at = this.consts.length;
    this.consts.u8(bytes.length).u8(bytes.length).bytes(bytes);
    this.constStrings.set(s, at);
    return at;
  }

  /** Allocates a scratch slot in data memory, private to the current function. */
  private scratch(size: number, isString = false): number {
    const at = this.dataTop;
    this.dataTop += size;
    if (isString) {
      // max length byte must be valid before first use: stored in the INIT image
      const grown = new MemoryImage(Math.max(this.dataTop, this.init.bytes.length));
      grown.writeBytes(0, this.init.bytes.subarray(0, this.init.used));
      grown.used = this.init.used;
      this.init = grown;
      this.init.write(at, 1, 'int', size - 2);
    }
    return at;
  }

  private collect(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (e instanceof CompileError && e.file === undefined) e.file = this.file;
      if (e instanceof CompileError || !(e instanceof Error) || e.message.startsWith('Internal')) {
        this.diagnostics.push(toDiagnostic(e));
      } else {
        throw e;
      }
    }
  }

  private hasErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }

  private err(message: string, line: number, file?: string): CompileError {
    return new CompileError(message, line, undefined, file ?? this.file);
  }
}

// ---------------------------------------------------------------------------

function defaultAddressType(a: Address): Elementary {
  return a.size === 'X' ? 'BOOL' : a.size === 'B' ? 'BYTE' : a.size === 'W' ? 'WORD' : 'DWORD';
}

function addressAccepts(a: Address, t: Elementary): boolean {
  switch (a.size) {
    case 'X': return t === 'BOOL';
    case 'B': return ['BYTE', 'SINT', 'USINT', 'CHAR'].includes(t);
    case 'W': return ['WORD', 'INT', 'UINT', 'DATE', 'WCHAR'].includes(t);
    default: return ['DWORD', 'DINT', 'UDINT', 'REAL', 'TIME', 'TOD'].includes(t);
  }
}

/**
 * Arithmetic on dates and times: TOD ± TIME, LTOD ± LTIME, LDT ± LTIME (and the difference
 * of two values of the same kind). Null when the operands are not such a combination.
 */
function temporalArithmetic(op: string, a: DataType, b: DataType): { result: DataType; left: DataType; right: DataType; modulo?: bigint; scale?: bigint } | null {
  if (op !== '+' && op !== '-') return null;
  const n = (t: DataType) => (t.k === 'elem' ? t.name : '');
  const [x, y] = [n(a), n(b)];
  const lit = (t: DataType) => t.k === 'anyint';
  if (x === 'TOD' && (y === 'TIME' || lit(b))) return { result: T.elem('TOD'), left: T.elem('TOD'), right: T.TIME, modulo: 86_400_000n };
  if (x === 'LTOD' && (y === 'LTIME' || lit(b))) return { result: T.elem('LTOD'), left: T.elem('LTOD'), right: T.elem('LTIME'), modulo: NS_PER_DAY };
  if (x === 'LDT' && (y === 'LTIME' || lit(b))) return { result: T.elem('LDT'), left: T.elem('LDT'), right: T.elem('LTIME') };
  if (op === '+' && y === 'TOD' && x === 'TIME') return { result: T.elem('TOD'), left: T.TIME, right: T.elem('TOD'), modulo: 86_400_000n };
  if (op === '-' && x === y && x === 'TOD') return { result: T.TIME, left: a, right: b };
  if (op === '-' && x === y && x === 'LTOD') return { result: T.elem('LTIME'), left: a, right: b };
  if (op === '-' && x === y && x === 'LDT') return { result: T.elem('LTIME'), left: a, right: b };
  return null;
}

function compareOp(op: string, float: boolean): number {
  const ops: Record<string, [number, number]> = {
    '=': [Op.EQ, Op.FEQ], '<>': [Op.NE, Op.FNE], '<': [Op.LT, Op.FLT], '<=': [Op.LE, Op.FLE], '>': [Op.GT, Op.FGT], '>=': [Op.GE, Op.FGE],
  };
  return ops[op][float ? 1 : 0];
}

/** REAL_TO_INT -> [REAL, INT]; null when not a conversion. */
function conversion(name: string): [DataType, DataType] | null {
  const m = /^([A-Z]+)_TO_([A-Z]+)$/.exec(name.toUpperCase());
  if (!m) return null;
  const type = (n: string): DataType | null => (n === 'STRING' || n === 'WSTRING' ? { k: 'string', length: STRING_SCRATCH }
    : n === 'DTL' ? DTL : isElementary(n) ? T.elem(n) : null);
  const from = type(m[1]);
  const to = type(m[2]);
  return from && to ? [from, to] : null;
}

function libraryIsOutput(block: string, member: string): boolean {
  const outputs: Record<string, string[]> = {
    TON: ['Q', 'ET'], TOF: ['Q', 'ET'], TP: ['Q', 'ET'], R_TRIG: ['Q'], F_TRIG: ['Q'],
    CTU: ['Q', 'CV'], CTD: ['Q', 'CV'], CTUD: ['QU', 'QD', 'CV'],
  };
  return outputs[block.toUpperCase()]?.includes(member.toUpperCase()) ?? false;
}

function exprName(e: Expr): string {
  switch (e.kind) {
    case 'var': return e.name;
    case 'member': return `${exprName(e.base)}.${e.member}`;
    case 'index': return `${exprName(e.base)}[...]`;
    default: return 'expression';
  }
}

/** [area, start byte, count, isBits] ranges of the process image used by a module. */
function ioUsage(m: IoModuleConfig): Array<['I' | 'Q', number, number, 'bits' | 'words' | 'bytes']> {
  switch (m.kind) {
    case 'modbus-tcp':
      return [
        ['I', m.di?.byte ?? 0, m.di?.count ?? 0, 'bits'],
        ['Q', m.coils?.byte ?? 0, m.coils?.count ?? 0, 'bits'],
        ['I', m.ir?.byte ?? 0, m.ir?.count ?? 0, 'words'],
        ['Q', m.hr?.byte ?? 0, m.hr?.count ?? 0, 'words'],
      ];
    case 'gpio-di':
      return [['I', m.byte, m.bit + 1, 'bits']];
    case 'gpio-do':
      return [['Q', m.byte, m.bit + 1, 'bits']];
    case 'gpio-ai':
      return [['I', m.byte, 1, 'words']];
    case 'gpio-ao':
      return [['Q', m.byte, 1, 'words']];
    case 'iolink-master':
      return m.ports.flatMap((p): Array<['I' | 'Q', number, number, 'bytes']> => [['I', p.inByte, p.inLength, 'bytes'], ['Q', p.outByte, p.outLength, 'bytes']]);
    case 'profinet-device':
      return [['I', m.inByte, m.inLength, 'bytes'], ['Q', m.outByte, m.outLength, 'bytes']];
    case 'profinet-remote':
      return m.submodules.flatMap((x): Array<['I' | 'Q', number, number, 'bytes']> => [['I', x.inByte, x.inLength, 'bytes'], ['Q', x.outByte, x.outLength, 'bytes']]);
  }
}
