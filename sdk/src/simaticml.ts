// Import of SimaticML documents: the XML files written by the engineering tool's public
// export interface (Openness "Export" of blocks, PLC data types and tag tables). Blocks in
// LAD become CONT blocks (networks), SCL blocks become SCL code.
//
// Only this documented exchange format is read: project archives (.zap*, .ap*) are
// proprietary and must first be exported with the export tool (tools/openness-export).
import { BOXES, ladderToScl, type LadElement, type LadNetwork } from './ladder.ts';
import { emptyInterface, newId, nextBlockNumber, type Block, type BlockType, type DataTypeDef, type Device, type Member, type Tag, type TagTable } from './project.ts';
import { childrenXml, childXml, findXml, parseXml, walkXml, type XmlNode } from './xml.ts';

export interface SimaticMlImport {
  blocks: Block[];
  types: DataTypeDef[];
  tagTables: TagTable[];
  /** Objects or networks that could not be imported, with the reason */
  warnings: string[];
}

export class SimaticMlError extends Error {}

/** True when the text is a SimaticML document. */
export function isSimaticMl(text: string): boolean {
  return /<Document[\s>]/.test(text) && /<SW\.(Blocks|Types|Tags)\./.test(text);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (name: string) => `"${name}"`;
const local = (name: string) => `#${IDENT.test(name) ? name : `"${name}"`}`;

/** Timer / counter data types of the engineering tool → IEC function blocks. */
function mapDataType(t: string): string {
  const s = t.trim();
  const m = /^(TON|TOF|TP)_L?TIME$/i.exec(s) ?? /^(CTU|CTD|CTUD)_\w+$/i.exec(s);
  if (m) return m[1].toUpperCase();
  if (/^IEC_L?TIMER$/i.test(s)) return 'TON';
  if (/^IEC_\w*COUNTER$/i.test(s)) return 'CTU';
  // Array[0..9] of "Udt" / String[20] / "Udt" : kept as written
  return s;
}

function text(n: XmlNode | undefined): string {
  return (n?.text ?? '').trim();
}

/** Text of a multilingual comment / title (<Comment><MultiLanguageText Lang=…>) */
function multiLanguage(n: XmlNode | undefined): string | undefined {
  if (!n) return undefined;
  const items = [...walkXml(n)].filter((x) => x.name === 'MultiLanguageText');
  const fr = items.find((x) => /^fr/i.test(x.attrs.Lang ?? ''));
  const t = text(fr ?? items.find((x) => text(x)) ?? items[0]);
  return t || undefined;
}

/** Title / comment of an object (<ObjectList><MultilingualText CompositionName="Title">…) */
function compositionText(obj: XmlNode, composition: string): string | undefined {
  const list = childXml(obj, 'ObjectList');
  const mt = childrenXml(list, 'MultilingualText').find((x) => x.attrs.CompositionName === composition);
  if (!mt) return undefined;
  const items = [...walkXml(mt)].filter((x) => x.name === 'MultilingualTextItem');
  const pick = items.find((x) => /^fr/i.test(text(findXml(x, 'Culture')))) ?? items.find((x) => text(findXml(x, 'Text')));
  const t = text(findXml(pick, 'Text'));
  return t || undefined;
}

const attr = (obj: XmlNode, name: string) => text(childXml(childXml(obj, 'AttributeList'), name));

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

function member(m: XmlNode): Member {
  const nested = childrenXml(m, 'Member');
  const out: Member = { name: m.attrs.Name, dataType: mapDataType(m.attrs.Datatype ?? 'Bool') };
  const start = text(childXml(m, 'StartValue'));
  if (start) out.defaultValue = start;
  const comment = multiLanguage(childXml(m, 'Comment'));
  if (comment) out.comment = comment;
  if (/^struct$/i.test(out.dataType) && nested.length) out.members = nested.map(member);
  // hidden from HMI
  for (const b of childrenXml(childXml(m, 'AttributeList'), 'BooleanAttribute')) {
    if (b.attrs.Name === 'ExternalVisible' && text(b) === 'false') out.hmiVisible = false;
    if (b.attrs.Name === 'ExternalWritable' && text(b) === 'false') out.hmiWritable = false;
  }
  return out;
}

function sections(obj: XmlNode): Map<string, Member[]> {
  const out = new Map<string, Member[]>();
  const iface = findXml(childXml(obj, 'AttributeList'), 'Sections');
  for (const s of childrenXml(iface, 'Section')) out.set(s.attrs.Name, childrenXml(s, 'Member').map(member));
  return out;
}

// ---------------------------------------------------------------------------
// Operands (Access)
// ---------------------------------------------------------------------------

const AREAS: Record<string, string> = { Input: 'I', Output: 'Q', Memory: 'M', PeripheryInput: 'I', PeripheryOutput: 'Q' };
const SIZES: Record<string, string> = { Bool: '', Byte: 'B', Char: 'B', SInt: 'B', USInt: 'B', Word: 'W', Int: 'W', UInt: 'W', DWord: 'D', DInt: 'D', UDInt: 'D', Real: 'D', Time: 'D' };

/** Renders the children of an SCL element in order (tokens, blanks, operands…). */
function renderSt(n: XmlNode): string {
  return n.children.map(stNode).join('');
}

function stNode(c: XmlNode): string {
  switch (c.name) {
    case 'Token': return c.attrs.Text ?? '';
    case 'Blank': return ' '.repeat(Number(c.attrs.Num ?? 1));
    case 'NewLine': return '\n'.repeat(Number(c.attrs.Num ?? 1));
    case 'LineComment': return `//${(findXml(c, 'Text') ?? c).text.replace(/[\r\n]+$/, '')}`;
    case 'Comment': return `(*${(findXml(c, 'Text') ?? c).text}*)`;
    case 'Text': return c.text;
    case 'Access': return access(c);
    case 'Parameter': return c.attrs.Informal === 'true' ? renderSt(c) : `${c.attrs.Name}${renderSt(c)}`;
    case 'CallInfo': return callInfo(c);
    case 'Instruction': return `${c.attrs.Name}${renderSt(c)}`;
    default: return renderSt(c);
  }
}

function component(c: XmlNode, first: boolean, global: boolean): string {
  const name = c.attrs.Name;
  const head = first ? (global ? quote(name) : local(name)) : IDENT.test(name) ? name : quote(name);
  if (c.children.some((x) => x.name === 'Token')) return head + renderSt(c);
  const idx = childrenXml(c, 'Access');
  return idx.length ? `${head}[${idx.map(access).join(', ')}]` : head;
}

function symbol(sym: XmlNode, global: boolean): string {
  if (sym.children.some((x) => x.name === 'Token')) {
    let first = true;
    return sym.children.map((x) => {
      if (x.name !== 'Component') return stNode(x);
      const s = component(x, first, global);
      first = false;
      return s;
    }).join('');
  }
  return childrenXml(sym, 'Component').map((x, i) => component(x, i === 0, global)).join('.');
}

function callInfo(ci: XmlNode): string {
  const inst = childXml(ci, 'Instance');
  const head = inst ? instanceRef(inst) : quote(ci.attrs.Name);
  return head + ci.children.filter((x) => x.name !== 'Instance').map(stNode).join('');
}

function instanceRef(inst: XmlNode): string {
  const global = inst.attrs.Scope === 'GlobalVariable';
  const comps = childrenXml(inst, 'Component');
  return comps.map((x, i) => component(x, i === 0, global)).join('.');
}

/** An operand as SCL text: "Tag".x, #local, %I0.1, literal… */
function access(a: XmlNode): string {
  const scope = a.attrs.Scope ?? '';
  const sym = childXml(a, 'Symbol');
  const constant = childXml(a, 'Constant');
  switch (scope) {
    case 'GlobalVariable': return sym ? symbol(sym, true) : '';
    case 'LocalVariable': return sym ? symbol(sym, false) : '';
    case 'GlobalConstant': return quote(constant?.attrs.Name ?? text(constant));
    case 'LocalConstant': return local(constant?.attrs.Name ?? text(constant));
    case 'LiteralConstant':
    case 'TypedConstant': {
      const v = text(childXml(constant, 'ConstantValue')) || text(constant);
      return /^(true|false)$/i.test(v) ? v.toUpperCase() : v;
    }
    case 'Address': {
      const ad = childXml(a, 'Address')!;
      const area = AREAS[ad.attrs.Area];
      const size = SIZES[ad.attrs.Type ?? 'Bool'];
      const bit = Number(ad.attrs.BitOffset ?? 0);
      if (!area || size === undefined) throw new SimaticMlError(`Absolute address not supported (${ad.attrs.Area} ${ad.attrs.Type})`);
      return size ? `%${area}${size}${Math.floor(bit / 8)}` : `%${area}${Math.floor(bit / 8)}.${bit % 8}`;
    }
    case 'Call':
    case 'Instruction': {
      const ci = childXml(a, 'CallInfo');
      const ins = childXml(a, 'Instruction');
      return ci ? callInfo(ci) : ins ? stNode(ins) : renderSt(a);
    }
    default:
      if (sym) return symbol(sym, !/Local/.test(scope));
      return renderSt(a);
  }
}

// ---------------------------------------------------------------------------
// LAD networks (FlgNet)
// ---------------------------------------------------------------------------

interface Part {
  uid: string;
  /** FlgNet part name (Contact, Coil, TON, Add…) or 'Call' */
  name: string;
  negated: Set<string>;
  instance?: string;
  call?: { block: string; inputs: string[]; outputs: string[] };
  node: XmlNode;
}

type Source = { kind: 'rail' } | { kind: 'ident'; uid: string } | { kind: 'pin'; uid: string; pin: string };

/** How a FlgNet part maps to a ladder element. */
interface PartMap {
  /** power flow input and output pins (lower case) */
  flowIn: string[];
  flowOut: string;
  /** our box / pin names: FlgNet pin (lower case) → box parameter */
  box?: string;
  pins?: Record<string, string>;
}

const binary = { in1: 'IN1', in2: 'IN2' };
const PARTS: Record<string, PartMap> = {
  contact: { flowIn: ['in'], flowOut: 'out' },
  pcontact: { flowIn: ['in'], flowOut: 'out' },
  ncontact: { flowIn: ['in'], flowOut: 'out' },
  notcontact: { flowIn: ['in'], flowOut: 'out' },
  negaterlo: { flowIn: ['in'], flowOut: 'out' },
  not: { flowIn: ['in'], flowOut: 'out' },
  coil: { flowIn: ['in'], flowOut: 'out' },
  scoil: { flowIn: ['in'], flowOut: 'out' },
  rcoil: { flowIn: ['in'], flowOut: 'out' },
  pcoil: { flowIn: ['in'], flowOut: 'out' },
  ncoil: { flowIn: ['in'], flowOut: 'out' },
  ton: { flowIn: ['in'], flowOut: 'q', box: 'TON', pins: { in: 'IN', pt: 'PT', q: 'Q', et: 'ET' } },
  tof: { flowIn: ['in'], flowOut: 'q', box: 'TOF', pins: { in: 'IN', pt: 'PT', q: 'Q', et: 'ET' } },
  tp: { flowIn: ['in'], flowOut: 'q', box: 'TP', pins: { in: 'IN', pt: 'PT', q: 'Q', et: 'ET' } },
  ctu: { flowIn: ['cu'], flowOut: 'q', box: 'CTU', pins: { cu: 'CU', r: 'R', pv: 'PV', q: 'Q', cv: 'CV' } },
  ctd: { flowIn: ['cd'], flowOut: 'q', box: 'CTD', pins: { cd: 'CD', ld: 'LD', pv: 'PV', q: 'Q', cv: 'CV' } },
  ctud: { flowIn: ['cu'], flowOut: 'qu', box: 'CTUD', pins: { cu: 'CU', cd: 'CD', r: 'R', ld: 'LD', pv: 'PV', qu: 'QU', qd: 'QD', cv: 'CV' } },
  r_trig: { flowIn: ['clk'], flowOut: 'q', box: 'R_TRIG', pins: { clk: 'CLK', q: 'Q' } },
  f_trig: { flowIn: ['clk'], flowOut: 'q', box: 'F_TRIG', pins: { clk: 'CLK', q: 'Q' } },
  sr: { flowIn: ['s'], flowOut: 'q', box: 'SR', pins: { s: 'S', r1: 'R1', q: 'Q' } },
  rs: { flowIn: ['r'], flowOut: 'q', box: 'RS', pins: { r: 'R', s1: 'S1', q: 'Q' } },
  move: { flowIn: ['en'], flowOut: 'eno', box: 'MOVE', pins: { in: 'IN', out1: 'OUT1', out2: 'OUT2', out3: 'OUT3', out4: 'OUT4' } },
  add: { flowIn: ['en'], flowOut: 'eno', box: 'ADD', pins: { ...binary, out: 'OUT' } },
  sub: { flowIn: ['en'], flowOut: 'eno', box: 'SUB', pins: { ...binary, out: 'OUT' } },
  mul: { flowIn: ['en'], flowOut: 'eno', box: 'MUL', pins: { ...binary, out: 'OUT' } },
  div: { flowIn: ['en'], flowOut: 'eno', box: 'DIV', pins: { ...binary, out: 'OUT' } },
  mod: { flowIn: ['en'], flowOut: 'eno', box: 'MOD', pins: { ...binary, out: 'OUT' } },
  eq: { flowIn: ['pre', 'in'], flowOut: 'out', box: 'CMP==', pins: binary },
  ne: { flowIn: ['pre', 'in'], flowOut: 'out', box: 'CMP<>', pins: binary },
  gt: { flowIn: ['pre', 'in'], flowOut: 'out', box: 'CMP>', pins: binary },
  ge: { flowIn: ['pre', 'in'], flowOut: 'out', box: 'CMP>=', pins: binary },
  lt: { flowIn: ['pre', 'in'], flowOut: 'out', box: 'CMP<', pins: binary },
  le: { flowIn: ['pre', 'in'], flowOut: 'out', box: 'CMP<=', pins: binary },
  inrange: { flowIn: ['pre'], flowOut: 'out', box: 'IN_RANGE', pins: { min: 'MIN', val: 'VAL', in: 'VAL', max: 'MAX' } },
  outrange: { flowIn: ['pre'], flowOut: 'out', box: 'OUT_RANGE', pins: { min: 'MIN', val: 'VAL', in: 'VAL', max: 'MAX' } },
  call: { flowIn: ['en'], flowOut: 'eno' },
};

class NetworkError extends Error {}

/** Translates a FlgNet (LAD network graph) to series / parallel ladder elements. */
export function flgNetToLadder(flg: XmlNode): LadElement[] {
  const idents = new Map<string, string>();
  const parts = new Map<string, Part>();
  for (const p of childXml(flg, 'Parts')?.children ?? []) {
    if (p.name === 'Access') idents.set(p.attrs.UId, access(p));
    else if (p.name === 'Part') {
      const inst = childXml(p, 'Instance');
      parts.set(p.attrs.UId, {
        uid: p.attrs.UId, name: p.attrs.Name, node: p,
        negated: new Set(childrenXml(p, 'Negated').map((x) => x.attrs.Name.toLowerCase())),
        instance: inst ? instanceRef(inst) : undefined,
      });
    } else if (p.name === 'Call') {
      const ci = childXml(p, 'CallInfo')!;
      const inst = childXml(ci, 'Instance');
      const params = childrenXml(ci, 'Parameter');
      parts.set(p.attrs.UId, {
        uid: p.attrs.UId, name: 'Call', node: p, negated: new Set(),
        instance: inst ? instanceRef(inst) : undefined,
        call: {
          block: ci.attrs.Name,
          inputs: params.filter((x) => x.attrs.Section !== 'Output').map((x) => x.attrs.Name),
          outputs: params.filter((x) => x.attrs.Section === 'Output' || x.attrs.Section === 'InOut').map((x) => x.attrs.Name),
        },
      });
    }
  }
  const mapOf = (p: Part): PartMap => {
    const m = PARTS[p.name.toLowerCase()];
    if (!m) throw new NetworkError(`instruction ${p.name} not supported in CONT`);
    return m;
  };
  const isOutput = (p: Part, pin: string): boolean => {
    const m = mapOf(p);
    if (pin === m.flowOut || pin === 'eno') return true;
    if (p.call) return p.call.outputs.some((o) => o.toLowerCase() === pin) && !p.call.inputs.some((o) => o.toLowerCase() === pin);
    if (m.box) return BOXES[m.box].outputs.includes(m.pins?.[pin] ?? '');
    return false;
  };

  // incoming sources of every part input pin
  const incoming = new Map<string, Source[]>();
  const consumed = new Set<string>();
  for (const w of childrenXml(childXml(flg, 'Wires'), 'Wire')) {
    const sources: Source[] = [];
    const sinks: Array<{ uid: string; pin: string }> = [];
    for (const e of w.children) {
      if (e.name === 'Powerrail') sources.push({ kind: 'rail' });
      else if (e.name === 'IdentCon') sources.push({ kind: 'ident', uid: e.attrs.UId });
      else if (e.name === 'NameCon') {
        const part = parts.get(e.attrs.UId);
        const pin = e.attrs.Name.toLowerCase();
        if (!part) continue;
        if (isOutput(part, pin)) sources.push({ kind: 'pin', uid: part.uid, pin });
        else sinks.push({ uid: part.uid, pin });
      }
    }
    for (const s of sinks) {
      const key = `${s.uid}:${s.pin}`;
      incoming.set(key, [...(incoming.get(key) ?? []), ...sources]);
    }
    if (sinks.length) for (const s of sources) if (s.kind === 'pin') consumed.add(s.uid);
  }
  const sourcesOf = (p: Part, pin: string) => incoming.get(`${p.uid}:${pin}`) ?? [];

  /** Operand of a data pin (SCL text). Boolean pins may be driven by contacts. */
  const operand = (p: Part, pin: string): string => {
    const src = sourcesOf(p, pin);
    if (!src.length) return '';
    if (src.length === 1 && src[0].kind === 'ident') return idents.get(src[0].uid) ?? '';
    return boolExpr(src);
  };
  const boolExpr = (src: Source[]): string => {
    const terms = src.map((s) => {
      if (s.kind === 'rail') return 'TRUE';
      if (s.kind === 'ident') return idents.get(s.uid) ?? '';
      const p = parts.get(s.uid)!;
      const n = p.name.toLowerCase();
      if (n !== 'contact') throw new NetworkError(`output ${s.pin} of ${p.name} used as a value (not supported)`);
      const before = boolExpr(sourcesOf(p, 'in'));
      const op = operand(p, 'operand');
      const test = p.negated.has('operand') ? `NOT ${op}` : op;
      return before === 'TRUE' ? test : `(${before}) AND ${test}`;
    });
    return terms.length === 1 ? terms[0] : terms.map((t) => `(${t})`).join(' OR ');
  };

  const element = (p: Part): LadElement => {
    const m = mapOf(p);
    const id = `u${p.uid}`;
    const n = p.name.toLowerCase();
    const op = () => operand(p, 'operand');
    switch (n) {
      case 'contact': return { kind: 'contact', id, type: p.negated.has('operand') ? 'nc' : 'no', operand: op() };
      case 'pcontact': return { kind: 'contact', id, type: 'p', operand: op(), edge: operand(p, 'bit') };
      case 'ncontact': return { kind: 'contact', id, type: 'n', operand: op(), edge: operand(p, 'bit') };
      case 'notcontact':
      case 'negaterlo':
      case 'not': return { kind: 'contact', id, type: 'not', operand: '' };
      case 'coil': return { kind: 'coil', id, type: p.negated.has('operand') ? 'negated' : 'normal', operand: op() };
      case 'scoil': return { kind: 'coil', id, type: 'set', operand: op() };
      case 'rcoil': return { kind: 'coil', id, type: 'reset', operand: op() };
      case 'pcoil': return { kind: 'coil', id, type: 'p', operand: op(), edge: operand(p, 'bit') };
      case 'ncoil': return { kind: 'coil', id, type: 'n', operand: op(), edge: operand(p, 'bit') };
      case 'call': {
        const inputs: Record<string, string> = {};
        const outputs: Record<string, string> = {};
        for (const name of p.call!.inputs) inputs[name] = operand(p, name.toLowerCase());
        for (const name of p.call!.outputs.filter((x) => !p.call!.inputs.includes(x))) {
          const target = targetOf(p, name.toLowerCase());
          if (target) outputs[name] = target;
        }
        return { kind: 'box', id, box: 'CALL', block: p.call!.block, instance: p.instance, inputs, outputs };
      }
    }
    const spec = BOXES[m.box!];
    const inputs: Record<string, string> = {};
    const outputs: Record<string, string> = {};
    for (const [pin, name] of Object.entries(m.pins ?? {})) {
      if (m.flowIn.includes(pin) && name === spec.inputs[0] && !spec.en) continue;
      if (spec.inputs.includes(name)) {
        const v = operand(p, pin);
        if (v) inputs[name] = v;
      } else if (spec.outputs.includes(name) && name !== spec.q) {
        const target = targetOf(p, pin);
        if (target) outputs[name] = target;
      }
    }
    const instance = m.box === 'SR' || m.box === 'RS' ? operand(p, 'operand') : p.instance;
    return { kind: 'box', id, box: m.box!, instance, inputs, outputs };
  };

  /** Operand written by an output pin (wire from the pin to an IdentCon). */
  const targets = new Map<string, string>();
  for (const w of childrenXml(childXml(flg, 'Wires'), 'Wire')) {
    const name = w.children.find((e) => e.name === 'NameCon');
    const ident = w.children.find((e) => e.name === 'IdentCon');
    if (name && ident && w.children.length === 2) targets.set(`${name.attrs.UId}:${name.attrs.Name.toLowerCase()}`, idents.get(ident.attrs.UId) ?? '');
  }
  const targetOf = (p: Part, pin: string) => targets.get(`${p.uid}:${pin}`);

  const flowInPin = (p: Part) => {
    const m = mapOf(p);
    return m.flowIn.find((x) => incoming.has(`${p.uid}:${x}`)) ?? m.flowIn[0];
  };

  const cache = new Map<string, LadElement[]>();
  const pathTo = (p: Part, depth = 0): LadElement[] => {
    if (depth > 200) throw new NetworkError('loop in the network');
    const cached = cache.get(p.uid);
    if (cached) return cached;
    const path = [...seriesFor(sourcesOf(p, flowInPin(p)), depth + 1), element(p)];
    cache.set(p.uid, path);
    return path;
  };
  const seriesFor = (src: Source[], depth: number): LadElement[] => {
    const paths = src.map((s): LadElement[] => {
      if (s.kind === 'rail') return [];
      if (s.kind === 'ident') throw new NetworkError('an operand is wired to a power flow input');
      const p = parts.get(s.uid)!;
      if (s.pin !== mapOf(p).flowOut) throw new NetworkError(`output ${s.pin} of ${p.name} used as power flow (not supported)`);
      return pathTo(p, depth);
    });
    return paths.length ? merge(paths) : [];
  };

  // terminal parts: their power flow output is not used (coils, boxes at the right)
  const terminals = [...parts.values()].filter((p) => !consumed.has(p.uid));
  const elements = merge(terminals.map((p) => pathTo(p)));
  // an element present twice would run twice: only contacts may be shared
  const seen = new Set<string>();
  const dedupe = (items: LadElement[]): LadElement[] => items.map((el) => {
    if (el.kind === 'branch') return { ...el, branches: el.branches.map(dedupe) };
    if (!seen.has(el.id)) {
      seen.add(el.id);
      return el;
    }
    if (el.kind !== 'contact') throw new NetworkError('network structure not supported (shared instruction on several paths)');
    let n = 2;
    while (seen.has(`${el.id}_${n}`)) n++;
    seen.add(`${el.id}_${n}`);
    return { ...el, id: `${el.id}_${n}` };
  });
  return dedupe(elements);
}

/** Parallel paths from the same point: common beginning, then a branch. */
function merge(paths: LadElement[][]): LadElement[] {
  if (paths.length <= 1) return paths[0] ?? [];
  let k = 0;
  const shortest = Math.min(...paths.map((p) => p.length));
  while (k < shortest && paths.every((p) => p[k].id === paths[0][k].id)) k++;
  const prefix = paths[0].slice(0, k);
  const groups = new Map<string, LadElement[][]>();
  for (const p of paths) {
    const rest = p.slice(k);
    const key = rest[0]?.id ?? '';
    if (!groups.has(key)) groups.set(key, []);
    // identical paths: once
    if (key || !groups.get(key)!.length) groups.get(key)!.push(rest);
  }
  const branches = [...groups.values()].map((g) => merge(g));
  return branches.length === 1 ? [...prefix, ...branches[0]] : [...prefix, { kind: 'branch', id: `b${prefix.length}_${branches.map((b) => b[0]?.id ?? 'x').join('_')}`, branches }];
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function block(obj: XmlNode, warnings: string[]): Block | null {
  const kind = obj.name.replace(/^SW\.Blocks\./, '');
  const name = attr(obj, 'Name');
  const number = Number(attr(obj, 'Number')) || 0;
  const s = sections(obj);
  const type: BlockType = kind === 'OB' ? 'OB' : kind === 'FC' ? 'FC' : kind === 'FB' ? 'FB' : 'DB';
  const b: Block = { id: newId('blk'), name, type, number, interface: emptyInterface(), code: '' };
  const comment = compositionText(obj, 'Comment');
  if (comment) b.comment = comment;
  if (type === 'DB') {
    const instanceOf = attr(obj, 'InstanceOfName');
    if (kind === 'InstanceDB' && instanceOf) b.instanceOf = mapDataType(instanceOf);
    else b.members = s.get('Static') ?? [];
    return b;
  }
  b.interface = {
    // OB start information (Initial_Call…) is not an interface of ours
    input: type === 'OB' ? [] : s.get('Input') ?? [], output: s.get('Output') ?? [], inout: s.get('InOut') ?? [],
    static: s.get('Static') ?? [], temp: s.get('Temp') ?? [], constant: s.get('Constant') ?? [],
  };
  if (type === 'FC') b.returnType = s.get('Return')?.[0]?.dataType ?? 'Void';
  if (type === 'OB') {
    const secondary = attr(obj, 'SecondaryType');
    if (secondary && !/^(ProgramCycle|Startup)$/.test(secondary)) warnings.push(`${name} : OB ${secondary} importé comme OB de cycle de programme`);
    b.event = secondary === 'Startup' ? 'Startup' : 'ProgramCycle';
  }
  const language = attr(obj, 'ProgrammingLanguage');
  const units = [...walkXml(childXml(obj, 'ObjectList') ?? obj)].filter((x) => x.name === 'SW.Blocks.CompileUnit');
  const networks: LadNetwork[] = [];
  const scl: string[] = [];
  let lad = true;
  units.forEach((u, i) => {
    const lang = attr(u, 'ProgrammingLanguage') || language;
    const title = compositionText(u, 'Title');
    const ncomment = compositionText(u, 'Comment');
    const source = findXml(childXml(u, 'AttributeList'), 'NetworkSource');
    const flg = findXml(source, 'FlgNet');
    const st = findXml(source, 'StructuredText');
    if (lang === 'LAD' && flg) {
      try {
        networks.push({ id: `n${i + 1}`, title, comment: ncomment, elements: flgNetToLadder(flg) });
      } catch (e) {
        warnings.push(`${name}, réseau ${i + 1} : ${(e as Error).message}`);
        networks.push({ id: `n${i + 1}`, title: `${title ?? ''} [non importé : ${(e as Error).message}]`.trim(), comment: ncomment, elements: [] });
      }
    } else if (st) {
      lad = false;
      if (title) scl.push(`// ${title}`);
      scl.push(renderSt(st).replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
    } else if (source && source.children.length) {
      lad = false;
      warnings.push(`${name}, réseau ${i + 1} : langage ${lang || '?'} non pris en charge (exportez le bloc en SCL ou en CONT)`);
    }
  });
  if (lad && (language === 'LAD' || networks.length)) {
    b.language = 'LAD';
    b.networks = networks.length ? networks : [{ id: 'n1', elements: [] }];
  } else {
    // SCL, or LAD mixed with SCL networks: everything as SCL
    if (networks.length) {
      try {
        scl.unshift(ladderToScl(networks).code);
      } catch (e) {
        warnings.push(`${name} : ${(e as Error).message}`);
      }
    }
    b.code = scl.join('\n');
  }
  return b;
}

function dataType(obj: XmlNode): DataTypeDef {
  const s = sections(obj);
  const t: DataTypeDef = { id: newId('udt'), name: attr(obj, 'Name'), members: s.get('None') ?? [...s.values()][0] ?? [] };
  const comment = compositionText(obj, 'Comment');
  if (comment) t.comment = comment;
  return t;
}

function tagTable(obj: XmlNode): TagTable {
  const table: TagTable = { id: newId('tt'), name: attr(obj, 'Name') || 'Table de variables', tags: [], constants: [] };
  for (const x of walkXml(childXml(obj, 'ObjectList') ?? obj)) {
    if (x.name === 'SW.Tags.PlcTag') {
      const address = attr(x, 'LogicalAddress');
      const tag: Tag = { name: attr(x, 'Name'), dataType: mapDataType(attr(x, 'DataTypeName') || 'Bool'), address: address && !address.startsWith('%') ? `%${address}` : address };
      const comment = compositionText(x, 'Comment');
      if (comment) tag.comment = comment;
      for (const b of childrenXml(childXml(x, 'AttributeList'), 'ExternalVisible').concat(childrenXml(childXml(x, 'AttributeList'), 'ExternalAccessible'))) {
        if (text(b) === 'false') tag.hmiVisible = false;
      }
      if (text(childXml(childXml(x, 'AttributeList'), 'ExternalWritable')) === 'false') tag.hmiWritable = false;
      table.tags.push(tag);
    } else if (x.name === 'SW.Tags.PlcUserConstant') {
      table.constants.push({ name: attr(x, 'Name'), dataType: attr(x, 'DataTypeName') || 'Int', value: attr(x, 'Value') });
    }
  }
  return table;
}

/** Reads a SimaticML document (one exported object per file, or several). */
export function importSimaticMl(device: Device, xml: string): SimaticMlImport {
  const doc = parseXml(xml);
  if (!findXml(doc, 'Document')) throw new SimaticMlError('Not a SimaticML document');
  const out: SimaticMlImport = { blocks: [], types: [], tagTables: [], warnings: [] };
  const top = [...walkXml(doc)].filter((x) => /^SW\.(Blocks\.(OB|FB|FC|GlobalDB|InstanceDB|ArrayDB)|Types\.PlcStruct|Tags\.PlcTagTable)$/.test(x.name));
  for (const obj of top) {
    if (obj.name.startsWith('SW.Blocks.')) {
      if (obj.name === 'SW.Blocks.ArrayDB') {
        out.warnings.push(`${attr(obj, 'Name')} : DB de tableau non pris en charge`);
        continue;
      }
      const b = block(obj, out.warnings);
      if (b) out.blocks.push(b);
    } else if (obj.name === 'SW.Types.PlcStruct') {
      out.types.push(dataType(obj));
    } else {
      out.tagTables.push(tagTable(obj));
    }
  }
  if (!top.length) throw new SimaticMlError('The document contains no block, PLC data type or tag table');
  // keep the numbers of the source project when they are free
  const numbered = [...device.blocks];
  for (const b of out.blocks) {
    const taken = numbered.some((x) => x.type === b.type && x.number === b.number && x.name.toLowerCase() !== b.name.toLowerCase());
    if (!b.number || taken) b.number = nextBlockNumber({ ...device, blocks: numbered }, b.type);
    numbered.push(b);
  }
  return out;
}

/**
 * Instance DBs of IEC timers / counters are exported as IEC_TIMER / IEC_COUNTER: give them
 * the type of the box or call that uses them (TOF, CTD…).
 */
export function fixIecInstances(device: Device): void {
  const used = new Map<string, string>();
  for (const b of device.blocks) {
    for (const n of b.networks ?? []) {
      const stack = [...n.elements];
      while (stack.length) {
        const el = stack.pop()!;
        if (el.kind === 'branch') stack.push(...el.branches.flat());
        else if (el.kind === 'box' && el.instance && /^"[^"]+"$/.test(el.instance) && BOXES[el.box]?.instance) used.set(el.instance.slice(1, -1).toLowerCase(), el.box);
      }
    }
    for (const m of b.code.matchAll(/"([^"]+)"\.(TON|TOF|TP|CTU|CTD|CTUD)\s*\(/gi)) used.set(m[1].toLowerCase(), m[2].toUpperCase());
  }
  for (const db of device.blocks) {
    const box = used.get(db.name.toLowerCase());
    if (db.type === 'DB' && box && ['TON', 'CTU'].includes(db.instanceOf ?? '') && box !== 'SR' && box !== 'RS') db.instanceOf = box;
  }
}
