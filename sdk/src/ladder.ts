// Ladder diagram (LAD / CONT): networks of contacts, coils, parallel branches and boxes,
// translated to SCL statements (then compiled like any SCL block). Operands are SCL
// expressions as the engineer types them ("Start", #Timer, %M0.1, "DB".Value...).

export type ContactType = 'no' | 'nc' | 'p' | 'n' | 'not';
export type CoilType = 'normal' | 'negated' | 'set' | 'reset' | 'p' | 'n';

export type LadElement =
  | { kind: 'contact'; id: string; type: ContactType; operand: string; /** edge memory bit (P / N contacts) */ edge?: string }
  | { kind: 'coil'; id: string; type: CoilType; operand: string; edge?: string }
  | {
    kind: 'box'; id: string;
    /** TON, TOF, TP, CTU, CTD, CTUD, R_TRIG, F_TRIG, SR, RS, MOVE, ADD, SUB, MUL, DIV, MOD, CMP==, CMP<>, CMP>, CMP>=, CMP<, CMP<=, IN_RANGE, OUT_RANGE, CALL */
    box: string;
    /** instance (timers, counters, edge / flip-flop blocks, FB calls) */
    instance?: string;
    /** called block (CALL) */
    block?: string;
    inputs: Record<string, string>;
    outputs: Record<string, string>;
  }
  | { kind: 'branch'; id: string; /** parallel paths, each a series of elements */ branches: LadElement[][] };

export interface LadNetwork {
  id: string;
  title?: string;
  comment?: string;
  /** series of elements from the left power rail */
  elements: LadElement[];
}

export interface BoxSpec {
  /** input parameters shown on the left (the first one receives the power flow unless `en`) */
  inputs: string[];
  outputs: string[];
  /** the power flow enters EN (the box runs only when it is TRUE) */
  en?: boolean;
  /** output driving the power flow after the box ('ENO' = the power flow passes through) */
  q: string;
  instance?: boolean;
}

export const BOXES: Record<string, BoxSpec> = {
  TON: { inputs: ['IN', 'PT'], outputs: ['Q', 'ET'], q: 'Q', instance: true },
  TOF: { inputs: ['IN', 'PT'], outputs: ['Q', 'ET'], q: 'Q', instance: true },
  TP: { inputs: ['IN', 'PT'], outputs: ['Q', 'ET'], q: 'Q', instance: true },
  CTU: { inputs: ['CU', 'R', 'PV'], outputs: ['Q', 'CV'], q: 'Q', instance: true },
  CTD: { inputs: ['CD', 'LD', 'PV'], outputs: ['Q', 'CV'], q: 'Q', instance: true },
  CTUD: { inputs: ['CU', 'CD', 'R', 'LD', 'PV'], outputs: ['QU', 'QD', 'CV'], q: 'QU', instance: true },
  R_TRIG: { inputs: ['CLK'], outputs: ['Q'], q: 'Q', instance: true },
  F_TRIG: { inputs: ['CLK'], outputs: ['Q'], q: 'Q', instance: true },
  SR: { inputs: ['S', 'R1'], outputs: ['Q'], q: 'Q', instance: true },
  RS: { inputs: ['R', 'S1'], outputs: ['Q'], q: 'Q', instance: true },
  MOVE: { inputs: ['IN'], outputs: ['OUT1'], en: true, q: 'ENO' },
  ADD: { inputs: ['IN1', 'IN2'], outputs: ['OUT'], en: true, q: 'ENO' },
  SUB: { inputs: ['IN1', 'IN2'], outputs: ['OUT'], en: true, q: 'ENO' },
  MUL: { inputs: ['IN1', 'IN2'], outputs: ['OUT'], en: true, q: 'ENO' },
  DIV: { inputs: ['IN1', 'IN2'], outputs: ['OUT'], en: true, q: 'ENO' },
  MOD: { inputs: ['IN1', 'IN2'], outputs: ['OUT'], en: true, q: 'ENO' },
  'CMP==': { inputs: ['IN1', 'IN2'], outputs: [], q: 'RLO' },
  'CMP<>': { inputs: ['IN1', 'IN2'], outputs: [], q: 'RLO' },
  'CMP>': { inputs: ['IN1', 'IN2'], outputs: [], q: 'RLO' },
  'CMP>=': { inputs: ['IN1', 'IN2'], outputs: [], q: 'RLO' },
  'CMP<': { inputs: ['IN1', 'IN2'], outputs: [], q: 'RLO' },
  'CMP<=': { inputs: ['IN1', 'IN2'], outputs: [], q: 'RLO' },
  IN_RANGE: { inputs: ['MIN', 'VAL', 'MAX'], outputs: [], q: 'RLO' },
  OUT_RANGE: { inputs: ['MIN', 'VAL', 'MAX'], outputs: [], q: 'RLO' },
  CALL: { inputs: [], outputs: [], en: true, q: 'ENO' },
};

/** Generated SCL with, for each line, the network (0-based) and element it comes from. */
export interface LadderScl {
  code: string;
  temps: string[];
  lines: Array<{ network: number; element?: string }>;
}

class LadderError extends Error {
  readonly network: number;
  readonly element?: string;
  constructor(message: string, network: number, element?: string) {
    super(message);
    this.network = network;
    this.element = element;
  }
}

export { LadderError };

const isIdentifier = (s: string) => /^(#?[A-Za-z_]\w*|"[^"]+"|TRUE|FALSE)$/i.test(s);

/** Translates the networks of a LAD block to SCL statements. */
export function ladderToScl(networks: LadNetwork[]): LadderScl {
  const out: string[] = [];
  const lines: LadderScl['lines'] = [];
  const temps: string[] = [];
  let tempCount = 0;
  let network = 0;
  let element: string | undefined;
  let lastOfNetwork: LadElement | undefined;

  const emit = (text: string) => {
    out.push(text);
    lines.push({ network, element });
  };
  const temp = () => {
    const name = `__rlo${++tempCount}`;
    temps.push(name);
    return `#${name}`;
  };
  /** Keeps a power flow expression in a temporary when it is not a simple operand. */
  const materialize = (expr: string) => {
    if (isIdentifier(expr)) return expr;
    const t = temp();
    emit(`${t} := ${expr};`);
    return t;
  };
  const operand = (el: { id: string; operand: string }, what: string) => {
    const op = el.operand.trim();
    if (!op || op === '??') throw new LadderError(`${what}: operand missing`, network, el.id);
    return op;
  };
  const and = (a: string, b: string) => (a === 'TRUE' ? b : `${a} AND ${b}`);

  const series = (items: LadElement[], rlo: string): string => {
    let flow = rlo;
    for (const el of items) flow = step(el, flow);
    return flow;
  };

  const step = (el: LadElement, rlo: string): string => {
    element = el.id;
    switch (el.kind) {
      case 'contact': {
        if (el.type === 'not') return `NOT (${rlo})`;
        const op = operand(el, 'Contact');
        if (el.type === 'no') return and(rlo, isIdentifier(op) ? op : `(${op})`);
        if (el.type === 'nc') return and(rlo, `NOT ${isIdentifier(op) ? op : `(${op})`}`);
        // edge contacts: RLO AND operand edge, the edge memory bit keeps the operand state
        if (!el.edge?.trim()) throw new LadderError('Edge contact: edge memory bit missing', network, el.id);
        const before = materialize(rlo);
        const t = temp();
        emit(el.type === 'p' ? `${t} := ${and(before, `${op} AND NOT ${el.edge}`)};` : `${t} := ${and(before, `NOT ${op} AND ${el.edge}`)};`);
        emit(`${el.edge} := ${op};`);
        return t;
      }
      case 'coil': {
        const op = operand(el, 'Coil');
        // the power flow is kept in a temporary unless the coil ends the network
        const flow = el === lastOfNetwork && el.type !== 'p' && el.type !== 'n' ? rlo : materialize(rlo);
        element = el.id;
        switch (el.type) {
          case 'normal': emit(`${op} := ${flow};`); break;
          case 'negated': emit(`${op} := NOT ${isIdentifier(flow) ? flow : `(${flow})`};`); break;
          case 'set': emit(`IF ${flow} THEN ${op} := TRUE; END_IF;`); break;
          case 'reset': emit(`IF ${flow} THEN ${op} := FALSE; END_IF;`); break;
          case 'p':
          case 'n': {
            if (!el.edge?.trim()) throw new LadderError('Edge coil: edge memory bit missing', network, el.id);
            emit(el.type === 'p' ? `${op} := ${flow} AND NOT ${el.edge};` : `${op} := NOT ${flow} AND ${el.edge};`);
            emit(`${el.edge} := ${flow};`);
            break;
          }
        }
        return flow;
      }
      case 'branch': {
        const flow = materialize(rlo);
        const results = el.branches.map((b) => (b.length ? series(b, flow) : flow));
        element = el.id;
        return results.length === 1 ? results[0] : `(${results.join(' OR ')})`;
      }
      case 'box':
        return box(el, rlo);
    }
  };

  const box = (el: Extract<LadElement, { kind: 'box' }>, rlo: string): string => {
    const spec = BOXES[el.box];
    if (!spec) throw new LadderError(`Unknown instruction ${el.box}`, network, el.id);
    const arg = (name: string) => {
      const v = (el.inputs[name] ?? '').trim();
      if (!v || v === '??') throw new LadderError(`${el.box}: parameter ${name} missing`, network, el.id);
      return v;
    };
    const flow = materialize(rlo);
    element = el.id;
    const cmp = /^CMP(.+)$/.exec(el.box);
    if (cmp) return and(flow, `(${arg('IN1')} ${cmp[1] === '==' ? '=' : cmp[1]} ${arg('IN2')})`);
    if (el.box === 'IN_RANGE') return and(flow, `(${arg('VAL')} >= ${arg('MIN')} AND ${arg('VAL')} <= ${arg('MAX')})`);
    if (el.box === 'OUT_RANGE') return and(flow, `(${arg('VAL')} < ${arg('MIN')} OR ${arg('VAL')} > ${arg('MAX')})`);

    if (spec.en) {
      emit(`IF ${flow} THEN`);
      switch (el.box) {
        case 'MOVE': {
          const targets = Object.entries(el.outputs).filter(([k, v]) => /^OUT\d+$/.test(k) && v.trim());
          if (!targets.length) throw new LadderError('MOVE: output OUT1 missing', network, el.id);
          for (const [, v] of targets) emit(`    ${v} := ${arg('IN')};`);
          break;
        }
        case 'CALL': {
          if (!el.block?.trim()) throw new LadderError('CALL: block missing', network, el.id);
          const params = [
            ...Object.entries(el.inputs).filter(([, v]) => v.trim()).map(([k, v]) => `${k} := ${v}`),
            ...Object.entries(el.outputs).filter(([, v]) => v.trim()).map(([k, v]) => `${k} => ${v}`),
          ].join(', ');
          emit(`    ${el.instance?.trim() ? `${el.instance}` : el.block}(${params});`);
          break;
        }
        default: {
          const op = { ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: 'MOD' }[el.box];
          const target = (el.outputs.OUT ?? '').trim();
          if (!target) throw new LadderError(`${el.box}: output OUT missing`, network, el.id);
          emit(`    ${target} := ${arg('IN1')} ${op} ${arg('IN2')};`);
        }
      }
      emit('END_IF;');
      return flow;
    }

    // blocks with an instance: the power flow drives their first input
    const inst = (el.instance ?? '').trim();
    if (!inst || inst === '??') throw new LadderError(`${el.box}: instance missing`, network, el.id);
    const params = spec.inputs.map((p, i) => (i === 0 ? `${p} := ${flow}` : el.inputs[p]?.trim() ? `${p} := ${el.inputs[p]}` : ''))
      .filter(Boolean);
    const outs = spec.outputs.filter((o) => el.outputs[o]?.trim()).map((o) => `${o} => ${el.outputs[o]}`);
    if (el.box === 'SR' || el.box === 'RS') {
      // flip-flops (static Bool instance): set / reset with priority
      const other = arg(el.box === 'SR' ? 'R1' : 'S1');
      if (el.box === 'SR') emit(`${inst} := (${flow} OR ${inst}) AND NOT (${other});`);
      else emit(`${inst} := (${other} OR ${inst}) AND NOT ${flow};`);
      for (const o of outs) emit(`${o.replace(/^Q => /, '')} := ${inst};`);
      return inst;
    }
    for (const p of spec.inputs.slice(1)) {
      if (['PV', 'PT'].includes(p) && !el.inputs[p]?.trim()) throw new LadderError(`${el.box}: parameter ${p} missing`, network, el.id);
    }
    emit(`${inst}(${[...params, ...outs].join(', ')});`);
    return `${inst}.${spec.q}`;
  };

  networks.forEach((n, i) => {
    network = i;
    element = undefined;
    lastOfNetwork = n.elements[n.elements.length - 1];
    emit(`// Network ${i + 1}${n.title ? `: ${n.title.replace(/[\r\n]+/g, ' ')}` : ''}`);
    try {
      series(n.elements, 'TRUE');
    } catch (e) {
      if (e instanceof LadderError) throw e;
      throw new LadderError((e as Error).message, i);
    }
  });
  return { code: out.join('\n'), temps, lines };
}

let counter = 0;
export function ladId(prefix = 'e'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Walks every element of a network (depth first). */
export function* ladElements(items: LadElement[]): Generator<LadElement> {
  for (const el of items) {
    yield el;
    if (el.kind === 'branch') for (const b of el.branches) yield* ladElements(b);
  }
}

/** Texts typed by the engineer in an element (operands, parameters, instance). */
export function ladOperands(el: LadElement): string[] {
  switch (el.kind) {
    case 'contact':
    case 'coil': return [el.operand, el.edge ?? ''];
    case 'box': return [el.instance ?? '', el.block ?? '', ...Object.values(el.inputs), ...Object.values(el.outputs)];
    case 'branch': return [];
  }
}

/**
 * Element of a network a compiler message is about: the one using the name quoted in the
 * message ('Nope'), else the element that produced the code line.
 */
export function ladElementFor(network: LadNetwork, message: string, fallback?: string): string | undefined {
  const names = [...message.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => (m[1] ?? m[2]).replace(/^#/, '').toLowerCase());
  for (const name of names) {
    const re = new RegExp(`(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`, 'i');
    for (const el of ladElements(network.elements)) if (ladOperands(el).some((t) => re.test(t))) return el.id;
  }
  return fallback;
}
