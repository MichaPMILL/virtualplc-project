// Graphical ladder editor (CONT / LAD): networks of contacts, coils, parallel branches and boxes.
import {
  BOXES, ladElements, ladId, type Block, type Device, type LadElement, type LadNetwork, type ProjectDiagnostic,
} from '../../../../sdk/src/browser.ts';
import { clear, h } from '../dom.ts';

type Box = Extract<LadElement, { kind: 'box' }>;
type Selection = { kind: 'el'; id: string } | { kind: 'path'; branch: string; index: number } | { kind: 'net'; index: number } | null;

export interface LadderHost {
  device: Device;
  block: Block;
  onChange(): void;
  /** Local names of the block interface */
  locals(): string[];
  /** Monitoring path of an operand ("Tag", #x, %M0.0 …), null if it can't be read */
  monitorPath(operand: string): string | null;
  /** Creates the instance of a timer / counter / edge block; returns the operand (#x or "DB") */
  createInstance(fb: string): Promise<string | null>;
}

/** Insertable elements (toolbar and instruction palette). */
export const LAD_PALETTE: Array<{ key: string; label: string; title: string }> = [
  { key: 'contact:no', label: '┤ ├', title: 'Contact à fermeture' },
  { key: 'contact:nc', label: '┤/├', title: 'Contact à ouverture' },
  { key: 'contact:p', label: '┤P├', title: 'Contact front montant' },
  { key: 'contact:n', label: '┤N├', title: 'Contact front descendant' },
  { key: 'contact:not', label: '┤NOT├', title: 'Inverser le RLO' },
  { key: 'coil:normal', label: '( )', title: 'Bobine d\'affectation' },
  { key: 'coil:negated', label: '(/)', title: 'Bobine d\'affectation inversée' },
  { key: 'coil:set', label: '(S)', title: 'Mettre à 1' },
  { key: 'coil:reset', label: '(R)', title: 'Mettre à 0' },
];

/** Palette instructions (task card) mapped to LAD boxes. */
const PALETTE_BOXES: Record<string, string> = {
  TON: 'TON', TOF: 'TOF', TP: 'TP', CTU: 'CTU', CTD: 'CTD', CTUD: 'CTUD', R_TRIG: 'R_TRIG', F_TRIG: 'F_TRIG',
  '=': 'CMP==', '<>': 'CMP<>', '>=': 'CMP>=', '<=': 'CMP<=', '>': 'CMP>', '<': 'CMP<', MOD: 'MOD', ':=': 'MOVE',
};

const BOX_TITLES: Record<string, string> = {
  TON: 'Retard à la montée', TOF: 'Retard à la retombée', TP: 'Impulsion', CTU: 'Compteur', CTD: 'Décompteur', CTUD: 'Compteur-décompteur',
  R_TRIG: 'Front montant', F_TRIG: 'Front descendant', SR: 'Bascule SR (mise à 1 prioritaire à 0)', RS: 'Bascule RS (mise à 1 prioritaire)',
  MOVE: 'Copier une valeur', ADD: 'Additionner', SUB: 'Soustraire', MUL: 'Multiplier', DIV: 'Diviser', MOD: 'Reste de division',
  'CMP==': 'Égal', 'CMP<>': 'Différent', 'CMP>': 'Supérieur', 'CMP>=': 'Supérieur ou égal', 'CMP<': 'Inférieur', 'CMP<=': 'Inférieur ou égal',
  IN_RANGE: 'Valeur dans la plage', OUT_RANGE: 'Valeur hors de la plage', CALL: 'Appeler un bloc',
};

const DEFAULT_INPUTS: Record<string, Record<string, string>> = {
  TON: { PT: 'T#1S' }, TOF: { PT: 'T#1S' }, TP: { PT: 'T#1S' }, CTU: { R: 'FALSE', PV: '10' }, CTD: { LD: 'FALSE', PV: '10' },
  CTUD: { CD: 'FALSE', R: 'FALSE', LD: 'FALSE', PV: '10' },
};

/** Power flow state during monitoring: true, false or unknown. */
type Flow = boolean | undefined;
const andF = (a: Flow, b: Flow): Flow => (a === false || b === false ? false : a === undefined || b === undefined ? undefined : true);
const orF = (list: Flow[]): Flow => (list.includes(true) ? true : list.includes(undefined) ? undefined : false);

export class LadderEditor {
  private selection: Selection = null;
  private undo: string[] = [];
  private redo: string[] = [];
  private errors = new Map<string, string>();
  private netErrors = new Map<number, string>();
  private values = new Map<string, string>();
  private monitoring = false;
  private readonly list: HTMLDataListElement;
  private readonly body: HTMLElement;
  private readonly root: HTMLElement;

  constructor(host: HTMLElement, private readonly h_: LadderHost) {
    const block = h_.block;
    block.networks ??= [];
    if (!block.networks.length) block.networks.push(this.newNetwork());
    this.list = h('datalist', { id: `lad-ops-${block.id}` });
    this.body = h('div', { className: 'lad-body', tabindex: '0' });
    this.root = h('div', { className: 'lad-editor' }, this.toolbar(), this.body, this.list);
    this.body.addEventListener('keydown', (e) => this.onKey(e));
    this.body.addEventListener('mousedown', (e) => {
      if (e.target === this.body) this.select(null);
    });
    host.append(this.root);
    this.render();
  }

  private get networks(): LadNetwork[] {
    return this.h_.block.networks!;
  }

  private newNetwork(): LadNetwork {
    return { id: ladId('n'), elements: [] };
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  private toolbar(): HTMLElement {
    const bar = h('div', { className: 'panel-toolbar lad-toolbar' });
    const tb = (label: string, title: string, run: () => void, cls = '') => h('button', {
      className: `tbtn lad-tb ${cls}`, title, onmousedown: (e: Event) => e.preventDefault(), onclick: run,
    }, label);
    bar.append(
      tb('+ Réseau', 'Insérer un réseau après le réseau sélectionné', () => this.addNetwork()),
      h('span', { className: 'sep' }),
      ...LAD_PALETTE.map((p) => tb(p.label, p.title, () => this.insertKey(p.key), 'mono')),
      h('span', { className: 'sep' }),
      tb('┬ Branche', 'Ouvrir une branche parallèle autour de l\'élément sélectionné (ou ajouter un chemin)', () => this.branch()),
    );
    const boxSel = h('select', { title: 'Insérer une boîte', style: 'height:22px;margin-left:4px' },
      h('option', { value: '' }, 'Boîte…'),
      ...Object.keys(BOXES).map((k) => h('option', { value: k }, `${k.replace(/^CMP/, 'CMP ')} — ${BOX_TITLES[k] ?? ''}`)));
    boxSel.onchange = () => {
      const k = boxSel.value;
      boxSel.value = '';
      if (k) void this.insertBox(k);
    };
    bar.append(boxSel, h('span', { className: 'sep' }),
      tb('↶', 'Annuler (Ctrl+Z)', () => this.undoCmd()),
      tb('↷', 'Rétablir (Ctrl+Y)', () => this.redoCmd()),
      tb('✕', 'Supprimer la sélection (Suppr)', () => this.deleteSelection()));
    return bar;
  }

  // -------------------------------------------------------------------------
  // Model helpers
  // -------------------------------------------------------------------------

  /** Series containing the element, its index and the network. */
  private locate(id: string): { series: LadElement[]; index: number; network: number } | null {
    const search = (series: LadElement[], network: number): ReturnType<LadderEditor['locate']> => {
      for (let i = 0; i < series.length; i++) {
        const el = series[i];
        if (el.id === id) return { series, index: i, network };
        if (el.kind === 'branch') for (const b of el.branches) {
          const r = search(b, network);
          if (r) return r;
        }
      }
      return null;
    };
    for (let n = 0; n < this.networks.length; n++) {
      const r = search(this.networks[n].elements, n);
      if (r) return r;
    }
    return null;
  }

  private findBranch(id: string): Extract<LadElement, { kind: 'branch' }> | undefined {
    for (const n of this.networks) for (const el of ladElements(n.elements)) if (el.id === id && el.kind === 'branch') return el;
    return undefined;
  }

  private selectedNetwork(): number {
    const s = this.selection;
    if (!s) return this.networks.length - 1;
    if (s.kind === 'net') return s.index;
    const id = s.kind === 'el' ? s.id : s.branch;
    return this.locate(id)?.network ?? this.networks.length - 1;
  }

  private change(mutate: () => void, rerender = true): void {
    this.undo.push(JSON.stringify(this.networks));
    if (this.undo.length > 100) this.undo.shift();
    this.redo = [];
    mutate();
    this.h_.onChange();
    // text fields already show their new value: re-rendering would move the focus away
    if (rerender) this.render();
  }

  private restore(from: string[], to: string[]): void {
    const s = from.pop();
    if (s === undefined) return;
    to.push(JSON.stringify(this.networks));
    this.h_.block.networks = JSON.parse(s) as LadNetwork[];
    this.h_.onChange();
    this.render();
  }

  undoCmd(): void { this.restore(this.undo, this.redo); }
  redoCmd(): void { this.restore(this.redo, this.undo); }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  addNetwork(): void {
    const at = this.selectedNetwork() + 1;
    const n = this.newNetwork();
    this.change(() => this.networks.splice(at, 0, n));
    this.select({ kind: 'net', index: at });
  }

  private insert(el: LadElement): void {
    const s = this.selection;
    this.change(() => {
      if (s?.kind === 'el') {
        const loc = this.locate(s.id);
        if (loc) {
          loc.series.splice(loc.index + 1, 0, el);
          return;
        }
      }
      if (s?.kind === 'path') {
        const b = this.findBranch(s.branch);
        if (b) {
          b.branches[s.index].push(el);
          return;
        }
      }
      if (!this.networks.length) this.networks.push(this.newNetwork());
      const net = this.networks[this.selectedNetwork()];
      // before the coils ending the network
      let at = net.elements.length;
      while (el.kind !== 'coil' && at > 0 && net.elements[at - 1].kind === 'coil') at--;
      net.elements.splice(at, 0, el);
    });
    this.select({ kind: 'el', id: el.id });
    requestAnimationFrame(() => (this.body.querySelector(`[data-id="${el.id}"] input`) as HTMLInputElement | null)?.focus());
  }

  insertKey(key: string): void {
    const [kind, type] = key.split(':');
    if (kind === 'contact') {
      const edge = type === 'p' || type === 'n' ? '' : undefined;
      this.insert({ kind: 'contact', id: ladId(), type: type as 'no', operand: type === 'not' ? '' : '', edge });
    } else {
      this.insert({ kind: 'coil', id: ladId(), type: type as 'normal', operand: '' });
    }
  }

  async insertBox(name: string): Promise<void> {
    const spec = BOXES[name];
    let instance: string | undefined;
    if (spec.instance && name !== 'SR' && name !== 'RS') {
      const r = await this.h_.createInstance(name);
      if (!r) return;
      instance = r;
    } else if (name === 'SR' || name === 'RS') {
      instance = '';
    }
    this.insert({
      kind: 'box', id: ladId(), box: name, instance, block: name === 'CALL' ? '' : undefined,
      inputs: { ...(DEFAULT_INPUTS[name] ?? {}) }, outputs: {},
    });
  }

  /** Instruction double-clicked in the palette. Returns false when it has no LAD form. */
  insertInstruction(it: { name: string; fb?: string }): boolean {
    const box = PALETTE_BOXES[it.fb ?? it.name];
    if (!box) return false;
    void this.insertBox(box);
    return true;
  }

  branch(): void {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'el') {
      const loc = this.locate(s.id);
      if (!loc) return;
      const el = loc.series[loc.index];
      if (el.kind === 'branch') {
        this.change(() => el.branches.push([]));
        this.select({ kind: 'path', branch: el.id, index: el.branches.length - 1 });
        return;
      }
      const b: LadElement = { kind: 'branch', id: ladId('b'), branches: [[el], []] };
      this.change(() => loc.series.splice(loc.index, 1, b));
      this.select({ kind: 'path', branch: b.id, index: 1 });
    } else if (s.kind === 'path') {
      const b = this.findBranch(s.branch);
      if (!b) return;
      this.change(() => b.branches.push([]));
      this.select({ kind: 'path', branch: b.id, index: b.branches.length - 1 });
    }
  }

  deleteSelection(): void {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'net') {
      if (this.networks.length <= 1) {
        this.change(() => { this.networks[0] = this.newNetwork(); });
      } else {
        this.change(() => this.networks.splice(s.index, 1));
      }
      this.select({ kind: 'net', index: Math.min(s.index, this.networks.length - 1) });
      return;
    }
    if (s.kind === 'path') {
      const b = this.findBranch(s.branch);
      const loc = this.locate(s.branch);
      if (!b || !loc) return;
      this.change(() => {
        b.branches.splice(s.index, 1);
        if (b.branches.length <= 1) loc.series.splice(loc.index, 1, ...(b.branches[0] ?? []));
      });
      this.select(null);
      return;
    }
    const loc = this.locate(s.id);
    if (!loc) return;
    this.change(() => loc.series.splice(loc.index, 1));
    const next = loc.series[Math.min(loc.index, loc.series.length - 1)];
    this.select(next ? { kind: 'el', id: next.id } : { kind: 'net', index: loc.network });
  }

  private onKey(e: KeyboardEvent): void {
    const inField = (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField) {
      e.preventDefault();
      if (e.shiftKey) this.redoCmd(); else this.undoCmd();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !inField) {
      e.preventDefault();
      this.redoCmd();
    } else if (e.key === 'Delete' && !inField) {
      e.preventDefault();
      this.deleteSelection();
    }
  }

  private select(s: Selection): void {
    this.selection = s;
    for (const el of this.body.querySelectorAll('.sel')) el.classList.remove('sel');
    if (!s) return;
    const q = s.kind === 'el' ? `[data-id="${s.id}"]` : s.kind === 'path' ? `[data-path="${s.branch}:${s.index}"]` : `[data-net="${s.index}"]`;
    this.body.querySelector(q)?.classList.add('sel');
  }

  goto(network: number, element?: string): void {
    this.select(element ? { kind: 'el', id: element } : { kind: 'net', index: network });
    const target = this.body.querySelector(element ? `[data-id="${element}"]` : `[data-net="${network}"]`) ?? this.body.querySelector(`[data-net="${network}"]`);
    target?.scrollIntoView({ block: 'center' });
  }

  // -------------------------------------------------------------------------
  // Errors and monitoring
  // -------------------------------------------------------------------------

  setErrors(diags: ProjectDiagnostic[]): void {
    this.errors.clear();
    this.netErrors.clear();
    for (const d of diags) {
      if (d.network === undefined) continue;
      if (d.element) this.errors.set(d.element, d.message);
      else this.netErrors.set(d.network, d.message);
      if (!this.netErrors.has(d.network)) this.netErrors.set(d.network, d.message);
    }
    this.render();
  }

  /** Operands read during monitoring (paths for the device). */
  monitorPaths(): string[] {
    const paths = new Set<string>();
    for (const n of this.networks) {
      for (const el of ladElements(n.elements)) {
        for (const op of this.operandsOf(el)) {
          const p = this.h_.monitorPath(op);
          if (p) paths.add(p);
        }
      }
    }
    return [...paths];
  }

  private operandsOf(el: LadElement): string[] {
    switch (el.kind) {
      case 'contact':
      case 'coil': return el.operand.trim() ? [el.operand.trim()] : [];
      case 'box': {
        const spec = BOXES[el.box];
        const inst = (el.instance ?? '').trim();
        return [
          ...Object.values(el.inputs), ...Object.values(el.outputs),
          ...(inst && spec?.instance ? (el.box === 'SR' || el.box === 'RS' ? [inst] : spec.outputs.map((o) => `${inst}.${o}`)) : []),
        ].map((x) => x.trim()).filter(Boolean);
      }
      case 'branch': return [];
    }
  }

  applyMonitor(values: Map<string, string>): void {
    this.values = values;
    this.monitoring = true;
    this.render();
  }

  stopMonitor(): void {
    this.monitoring = false;
    this.values = new Map();
    this.render();
  }

  private valueOf(operand: string): string | undefined {
    const op = operand.trim();
    if (/^(TRUE|FALSE)$/i.test(op)) return op.toUpperCase();
    if (/^[+-]?\d+(\.\d+)?$/.test(op)) return op;
    const p = this.h_.monitorPath(op);
    return p ? this.values.get(p) : undefined;
  }

  private boolOf(operand: string): Flow {
    const v = this.valueOf(operand);
    return v === 'TRUE' ? true : v === 'FALSE' ? false : undefined;
  }

  private numOf(operand: string): number | undefined {
    const v = this.valueOf(operand);
    if (v === undefined) return undefined;
    const n = Number(v.replace(/^[A-Z_]+#/i, '').replace(/^16#/, '0x'));
    return Number.isFinite(n) ? n : undefined;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(): void {
    const scroll = this.body.scrollTop;
    clear(this.body);
    this.refreshCompletions();
    this.networks.forEach((n, i) => this.body.append(this.renderNetwork(n, i)));
    this.body.append(h('div', { className: 'lad-add', onclick: () => { this.select({ kind: 'net', index: this.networks.length - 1 }); this.addNetwork(); } }, '+ Ajouter un réseau'));
    this.body.scrollTop = scroll;
    this.select(this.selection);
  }

  private refreshCompletions(): void {
    clear(this.list);
    const d = this.h_.device;
    const names = [
      ...this.h_.locals().map((x) => `#${x}`),
      ...d.tagTables.flatMap((t) => t.tags.map((x) => `"${x.name}"`)),
      ...d.blocks.filter((b) => b.type === 'DB').map((b) => `"${b.name}"`),
    ];
    for (const n of names) this.list.append(h('option', { value: n }));
  }

  private renderNetwork(n: LadNetwork, index: number): HTMLElement {
    const title = h('input', {
      className: 'lad-title', value: n.title ?? '', placeholder: 'Titre du réseau…',
      onchange: (e: Event) => this.change(() => { n.title = (e.target as HTMLInputElement).value || undefined; }, false),
    });
    const comment = h('input', {
      className: 'lad-comment', value: n.comment ?? '', placeholder: 'Commentaire',
      onchange: (e: Event) => this.change(() => { n.comment = (e.target as HTMLInputElement).value || undefined; }, false),
    });
    const error = this.netErrors.get(index);
    const flow: Flow = this.monitoring ? true : undefined;
    const rung = h('div', { className: 'lad-rung' });
    const series = this.renderSeries(n.elements, flow, true);
    rung.append(series.el);
    const head = h('div', {
      className: `lad-net-head${error ? ' err' : ''}`, 'data-net': String(index), title: error ?? '',
      onmousedown: (e: Event) => { if ((e.target as HTMLElement).tagName !== 'INPUT') this.select({ kind: 'net', index }); },
    }, h('b', null, `Réseau ${index + 1} :`), title);
    return h('div', { className: 'lad-net' }, head, h('div', { className: 'lad-net-comment' }, comment),
      error ? h('div', { className: 'lad-net-error' }, error) : null, rung);
  }

  /** A series of elements; returns the element and the power flow after it. */
  private renderSeries(items: LadElement[], flow: Flow, top: boolean): { el: HTMLElement; flow: Flow } {
    const row = h('div', { className: `lad-series${top ? ' top' : ''}` });
    let f = flow;
    // the coils ending a path (and parallel coils) are drawn at the right rail
    const isOutput = (el: LadElement): boolean => el.kind === 'coil' || (el.kind === 'branch' && el.branches.every((b) => b.length > 0 && isOutput(b[b.length - 1])));
    let lastLogic = items.length;
    while (lastLogic > 0 && isOutput(items[lastLogic - 1])) lastLogic--;
    items.forEach((el, i) => {
      if (i === lastLogic) row.append(this.wire(f, true));
      const r = this.renderElement(el, f);
      if (i >= lastLogic && el.kind === 'branch') r.el.classList.add('stretch');
      row.append(r.el);
      f = r.flow;
    });
    if (lastLogic === items.length) row.append(this.wire(f, true));
    if (!items.length && top) row.prepend(h('span', { className: 'lad-empty' }, 'Réseau vide : sélectionnez-le puis insérez des contacts et des bobines'));
    return { el: row, flow: f };
  }

  private wire(flow: Flow, stretch = false): HTMLElement {
    return h('div', { className: `lad-wire${stretch ? ' stretch' : ''}`, 'data-on': flow === true ? '1' : '' });
  }

  private operandInput(value: string, set: (v: string) => void, placeholder = '<??.?>', extra = ''): HTMLInputElement {
    const input = h('input', {
      className: `lad-op ${extra}`, value, placeholder, list: this.list.id, spellcheck: 'false',
      onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value.trim();
        this.change(() => set(v), false);
        (e.target as HTMLInputElement).title = v;
      },
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') (e.target as HTMLInputElement).blur(); },
    });
    input.title = value;
    return input;
  }

  private shell(el: LadElement, cls: string, flowIn: Flow, flowOut: Flow, ...children: Array<Node | null>): HTMLElement {
    const err = this.errors.get(el.id);
    const div = h('div', {
      className: `lad-el ${cls}${err ? ' err' : ''}`, 'data-id': el.id, title: err ?? '',
      'data-in': flowIn === true ? '1' : '', 'data-out': flowOut === true ? '1' : '',
      onmousedown: (e: Event) => {
        e.stopPropagation();
        this.select({ kind: 'el', id: el.id });
      },
    });
    for (const c of children) if (c) div.append(c);
    return div;
  }

  private renderElement(el: LadElement, flow: Flow): { el: HTMLElement; flow: Flow } {
    const mon = this.monitoring;
    switch (el.kind) {
      case 'contact': {
        const v = el.type === 'not' ? undefined : this.boolOf(el.operand);
        const closed: Flow = !mon ? undefined : el.type === 'no' ? v : el.type === 'nc' ? (v === undefined ? undefined : !v) : el.type === 'not' ? undefined : undefined;
        const out: Flow = !mon ? undefined : el.type === 'not' ? (flow === undefined ? undefined : !flow) : andF(flow, closed);
        const mark = { no: '', nc: '/', p: 'P', n: 'N', not: 'NOT' }[el.type];
        const sym = h('div', { className: `lad-sym contact${closed ? ' closed' : ''}${el.type === 'not' ? ' not' : ''}` }, h('span', null, mark));
        return {
          el: this.shell(el, 'contact', flow, out,
            el.type === 'not' ? h('div', { className: 'lad-op-spacer' }) : this.operandInput(el.operand, (x) => { el.operand = x; }),
            sym,
            el.type === 'p' || el.type === 'n' ? this.operandInput(el.edge ?? '', (x) => { el.edge = x; }, '<mémoire>', 'edge') : null),
          flow: out,
        };
      }
      case 'coil': {
        const mark = { normal: '', negated: '/', set: 'S', reset: 'R', p: 'P', n: 'N' }[el.type];
        const v = this.boolOf(el.operand);
        const sym = h('div', { className: `lad-sym coil${mon && v ? ' closed' : ''}` }, h('span', null, mark));
        return {
          el: this.shell(el, 'coil', flow, flow,
            this.operandInput(el.operand, (x) => { el.operand = x; }), sym,
            el.type === 'p' || el.type === 'n' ? this.operandInput(el.edge ?? '', (x) => { el.edge = x; }, '<mémoire>', 'edge') : null),
          flow,
        };
      }
      case 'branch': {
        const col = h('div', { className: 'lad-branch', 'data-id': el.id });
        const outs: Flow[] = [];
        el.branches.forEach((b, i) => {
          const pathRow = h('div', { className: 'lad-brow' });
          if (!b.length) {
            pathRow.append(h('div', {
              className: 'lad-path-empty', 'data-path': `${el.id}:${i}`, title: 'Chemin vide : cliquez puis insérez des éléments',
              onmousedown: (e: Event) => { e.stopPropagation(); this.select({ kind: 'path', branch: el.id, index: i }); },
            }), this.wire(flow, true));
            outs.push(flow);
          } else {
            const r = this.renderSeries(b, flow, false);
            pathRow.append(r.el);
            outs.push(r.flow);
          }
          col.append(pathRow);
        });
        const out = mon ? orF(outs) : undefined;
        const wrap = this.shell(el, 'branchwrap', flow, out, col);
        return { el: wrap, flow: out };
      }
      case 'box':
        return this.renderBox(el, flow);
    }
  }

  private renderBox(el: Box, flow: Flow): { el: HTMLElement; flow: Flow } {
    const spec = BOXES[el.box];
    const mon = this.monitoring;
    const leftRest = spec.en ? spec.inputs : spec.q === 'RLO' ? spec.inputs : spec.inputs.slice(1);
    const rightRest = spec.q === 'RLO' || spec.en ? spec.outputs : spec.outputs.filter((o) => o !== spec.q);
    const first = spec.en ? ['EN', 'ENO'] : spec.q === 'RLO' ? ['', ''] : [spec.inputs[0], spec.q];

    // power flow after the box
    let out: Flow;
    if (mon) {
      const inst = (el.instance ?? '').trim();
      if (spec.en) out = flow;
      else if (spec.q === 'RLO') {
        const [a, b, c] = spec.inputs.map((p) => this.numOf(el.inputs[p] ?? ''));
        let test: Flow;
        const cmp = /^CMP(.+)$/.exec(el.box)?.[1];
        if (a !== undefined && b !== undefined && cmp) {
          test = { '==': a === b, '<>': a !== b, '>': a > b, '>=': a >= b, '<': a < b, '<=': a <= b }[cmp];
        } else if (a !== undefined && b !== undefined && c !== undefined) {
          test = el.box === 'IN_RANGE' ? b >= a && b <= c : b < a || b > c;
        }
        out = andF(flow, test);
      } else out = inst ? this.boolOf(el.box === 'SR' || el.box === 'RS' ? inst : `${inst}.${spec.q}`) : undefined;
    }

    const grid = h('div', { className: 'lad-boxgrid' });
    const cell = (cls: string, ...c: Array<Node | string | null>) => {
      const d = h('div', { className: cls });
      for (const x of c) if (x !== null) d.append(x);
      grid.append(d);
      return d;
    };
    // row 1: instance above the box
    cell('lad-inst', el.box === 'CALL'
      ? this.operandInput(el.block ?? '', (x) => { el.block = x.replace(/^"|"$/g, ''); }, '<bloc>')
      : spec.instance ? this.operandInput(el.instance ?? '', (x) => { el.instance = x; }, el.box === 'SR' || el.box === 'RS' ? '<bit>' : '<instance>') : null);
    // row 2: name
    cell('');
    cell('lad-bx top', h('b', null, el.box.replace(/^CMP/, 'CMP ')));
    cell('');
    // row 3: power flow
    cell('lad-wcell w-in');
    cell('lad-bx', h('span', null, first[0]), h('span', null, first[1]));
    cell('lad-wcell w-out');
    const rows = Math.max(leftRest.length, rightRest.length);
    const valueHint = (operand: string) => {
      if (!mon) return null;
      const v = this.valueOf(operand);
      return v !== undefined && operand.trim() && !/^[+-]?\d/.test(operand.trim()) ? h('span', { className: 'lad-val' }, v) : null;
    };
    for (let i = 0; i < rows; i++) {
      const l = leftRest[i];
      const r = rightRest[i];
      const optional = l !== undefined && spec.instance && !['PT', 'PV'].includes(l);
      cell('lad-pin left', l ? this.operandInput(el.inputs[l] ?? '', (x) => { el.inputs[l] = x; }, optional ? '…' : '<???>', optional ? 'opt' : '') : null, l ? valueHint(el.inputs[l] ?? '') : null);
      cell(`lad-bx${i === rows - 1 ? ' bottom' : ''}`, h('span', null, l ?? ''), h('span', null, r ?? ''));
      // outputs are optional, except the targets of MOVE and of the arithmetic boxes
      const outOptional = !spec.en;
      cell('lad-pin right', r ? this.operandInput(el.outputs[r] ?? '', (x) => { el.outputs[r] = x; }, outOptional ? '…' : '<???>', outOptional ? 'opt' : '') : null, r ? valueHint(el.outputs[r] ?? '') : null);
    }
    if (!rows) grid.children[grid.children.length - 2].classList.add('bottom');
    return { el: this.shell(el, 'box', flow, out, grid), flow: out };
  }

  destroy(): void {
    this.root.remove();
  }
}
