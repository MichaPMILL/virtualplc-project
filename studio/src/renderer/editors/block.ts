// Program editor for OB / FC / FB (interface + SCL) and data block editor.
import { blockLabel, findSymbol, ladderToScl, newId, type Block, type Device, type Member, type SymbolNode } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { icons, type IconName } from '../icons.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import { hmiColumns } from './tagTable.ts';
import { DATA_TYPES, FB_TYPES, Grid, valueClass } from './grid.ts';
import { alertDialog, button, confirmDialog, openDialog } from '../ui/dialogs.ts';
import { LadderEditor } from './ladder.ts';
import { operandsOf, SclEditor, type CompletionSource } from './sclEditor.ts';
import type { EditorView } from './types.ts';

type SectionKey = 'input' | 'output' | 'inout' | 'static' | 'temp' | 'constant';
type Row = Member & { _section?: SectionKey };

const SECTION_LABELS: Record<SectionKey, string> = {
  input: t.sInput, output: t.sOutput, inout: t.sInOut, static: t.sStatic, temp: t.sTemp, constant: t.sConstant,
};

function sectionsFor(b: Block): SectionKey[] {
  switch (b.type) {
    case 'OB': return ['temp', 'constant'];
    case 'FC': return ['input', 'output', 'inout', 'temp', 'constant'];
    case 'FB': return ['input', 'output', 'inout', 'static', 'temp', 'constant'];
    default: return [];
  }
}

export function typeSuggestions(device: Device, withFb = true): string[] {
  return [...DATA_TYPES, 'Struct', ...(device.types ?? []).map((x) => `"${x.name}"`),
    ...(withFb ? [...FB_TYPES, ...device.blocks.filter((b) => b.type === 'FB').map((b) => `"${b.name}"`)] : [])];
}

function blockIcon(b: Block): IconName {
  return ({ OB: 'ob', FB: 'fb', FC: 'fc', DB: 'db' } as const)[b.type];
}

function uniqueName(existing: Member[], base: string): string {
  let n = 1;
  while (existing.some((m) => m.name.toLowerCase() === `${base}_${n}`.toLowerCase())) n++;
  return `${base}_${n}`;
}

export function blockEditor(device: Device, block: Block): EditorView {
  if (block.type === 'DB') return dbEditor(device, block);

  const sections = sectionsFor(block);
  const allMembers = () => sections.flatMap((s) => block.interface[s]);
  const nameCheck = (value: string, row: Member) => {
    if (!/^[A-Za-z_]\w*$/.test(value.trim())) return 'Nom invalide (lettres, chiffres et _)';
    return allMembers().some((m) => m !== row && m.name.toLowerCase() === value.trim().toLowerCase()) ? `Le nom « ${value} » existe déjà` : null;
  };
  const returnRow: Row = { name: block.name, dataType: block.returnType ?? 'Void' };

  const iface = new Grid<Row>({
    columns: [
      { title: t.name, width: '26%', kind: 'text', primary: true, get: (r) => r.name, set: (r, v) => { r.name = v.trim(); }, validate: (v, r) => (r === returnRow ? null : nameCheck(v, r)) },
      { title: t.dataType, width: '20%', kind: 'text', get: (r) => r.dataType, set: (r, v) => { if (r === returnRow) block.returnType = v.trim(); r.dataType = v.trim(); }, suggestions: () => typeSuggestions(device) },
      { title: t.defaultValue, width: '14%', kind: 'text', mono: true, get: (r) => r.defaultValue ?? '', set: (r, v) => { r.defaultValue = v.trim() || undefined; } },
      { title: t.monitorValue, width: '12%', kind: 'monitor', get: () => '' },
      { title: t.comment, kind: 'text', get: (r) => r.comment ?? '', set: (r, v) => { r.comment = v || undefined; } },
    ],
    rowIcon: () => 'tagTable',
    sections: () => [
      ...sections.map((s) => ({
        title: SECTION_LABELS[s],
        icon: 'folder' as IconName,
        rows: block.interface[s] as Row[],
        create: (name: string) => ({ name: /^[A-Za-z_]\w*$/.test(name) ? name : uniqueName(allMembers(), 'Var'), dataType: s === 'static' ? 'Bool' : 'Bool', _section: s }),
      })),
      ...(block.type === 'FC' ? [{ title: t.sReturn, icon: 'folder' as IconName, rows: [returnRow], canAdd: false }] : []),
    ],
    onChange: () => {
      store.touch();
    },
  });

  // --- code
  const codeWrap = h('div', { className: 'cm-wrap' });
  const completions: CompletionSource = {
    globals: () => [
      ...device.tagTables.flatMap((tt) => tt.tags.map((x) => ({ name: x.name, type: x.dataType }))),
      ...device.blocks.filter((b) => b.type === 'DB').map((b) => ({ name: b.name, type: b.instanceOf ?? 'DB' })),
      ...device.blocks.filter((b) => b.type === 'FC').map((b) => ({ name: b.name, type: 'FC' })),
    ],
    locals: () => allMembers().map((m) => ({ name: m.name, type: m.dataType })),
    members: (path) => {
      const sym = findSymbol(store.symbols(device.id), path.replace(/^#/, instancePrefix()));
      return (sym?.children ?? []).map((c) => ({ name: c.name, type: c.type }));
    },
  };
  let editor: SclEditor | null = null;
  let ladder: LadderEditor | null = null;
  const isLad = block.language === 'LAD';
  let instance = '';
  const instances = () => device.blocks.filter((b) => b.type === 'DB' && b.instanceOf === block.name).map((b) => b.name);
  const instancePrefix = () => (instance ? `"${instance}".` : '');

  const instanceSel = h('select', { title: 'Instance visualisée', style: 'height:22px' });
  const refreshInstances = () => {
    const list = instances();
    clear(instanceSel);
    for (const n of list) instanceSel.append(h('option', { value: n }, n));
    if (!list.includes(instance)) instance = list[0] ?? '';
    instanceSel.value = instance;
    instanceSel.parentElement?.classList.toggle('hidden', block.type !== 'FB');
  };
  instanceSel.onchange = () => { instance = instanceSel.value; };

  let ifaceHeight = 210;
  const ifacePanel = h('div', { className: 'block-interface', style: `--iface-h:${ifaceHeight}px` });
  const ifaceBody = h('div', { style: 'flex:1;display:flex;min-height:0' }, iface.element);
  const toggleIface = h('button', { className: 'tbtn', title: 'Afficher / masquer l\'interface', onclick: () => {
    ifacePanel.classList.toggle('collapsed');
    ifaceBody.classList.toggle('hidden');
  } }, '▾');
  ifacePanel.append(h('div', { className: 'panel-subheader' }, toggleIface, ` ${t.blockInterface}`), ifaceBody);
  const resizer = h('div', { className: 'hsplitter', style: 'height:5px;cursor:row-resize;background:var(--panel-alt)' });
  resizer.addEventListener('mousedown', (e) => {
    const startY = e.clientY;
    const start = ifaceHeight;
    const move = (ev: MouseEvent) => {
      ifaceHeight = Math.max(60, Math.min(600, start + ev.clientY - startY));
      ifacePanel.style.setProperty('--iface-h', `${ifaceHeight}px`);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  const comment = h('input', {
    value: block.comment ?? '', placeholder: 'Commentaire du bloc', style: 'flex:1;height:22px;border:1px solid transparent;background:transparent;padding:0 6px',
    onchange: (e: Event) => { block.comment = (e.target as HTMLInputElement).value; store.touch(); },
  });

  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'panel-toolbar' },
      h('button', { className: 'tbtn', title: t.compile, onclick: () => void A.compileCmd(device) }, svg(icons.compile)),
      h('span', { className: 'sep' }),
      ...(isLad ? [
        h('button', { className: 'tbtn', title: 'Convertir le bloc en SCL', onclick: () => void convertToScl() }, 'CONT→SCL'),
      ] : [
        h('button', { className: 'tbtn', title: 'Commenter la sélection', onclick: () => toggleComment() }, '//'),
        h('button', { className: 'tbtn', title: 'Insérer une REGION', onclick: () => editor?.insert('REGION Nouvelle région\n    \nEND_REGION\n') }, '{ }'),
      ]),
      h('span', { className: 'sep' }),
      h('button', { className: 'tbtn', title: t.monitorAll, onclick: () => void A.toggleMonitorCmd() }, svg(icons.glasses)),
      h('span', { style: 'display:flex;align-items:center;gap:4px;margin-left:8px' }, h('span', { className: 'muted' }, 'Instance :'), instanceSel)),
    h('div', { className: 'block-editor', style: 'flex:1;min-height:0' },
      ifacePanel, resizer,
      h('div', { className: 'block-code' },
        h('div', { className: 'panel-subheader', style: 'gap:6px' }, svg(icons[blockIcon(block)]), blockLabel(block), isLad ? h('span', { className: 'muted' }, 'CONT') : null, comment),
        codeWrap)));

  const toggleComment = () => {
    if (!editor) return;
    const v = editor.view;
    const { from, to } = v.state.selection.main;
    const first = v.state.doc.lineAt(from).number;
    const last = v.state.doc.lineAt(to).number;
    const lines = [];
    for (let i = first; i <= last; i++) lines.push(v.state.doc.line(i));
    const allCommented = lines.every((l) => /^\s*\/\//.test(l.text) || !l.text.trim());
    v.dispatch({
      changes: lines.map((l) => allCommented
        ? { from: l.from + l.text.indexOf('//'), to: l.from + l.text.indexOf('//') + (l.text.includes('// ') ? 3 : 2), insert: '' }
        : { from: l.from, insert: '// ' }).filter((c) => !allCommented || c.from >= 0),
    });
  };

  const convertToScl = async () => {
    if (!await confirmDialog('Convertir en SCL', `Le bloc « ${block.name} » sera converti en SCL : les réseaux CONT seront remplacés par le code SCL équivalent. Continuer ?`)) return;
    let r;
    try {
      r = ladderToScl(block.networks ?? []);
    } catch (e) {
      await alertDialog('Convertir en SCL', `Conversion impossible : ${(e as Error).message}`, 'error');
      return;
    }
    block.interface.temp.push(...r.temps.map((name) => ({ name, dataType: 'Bool' })));
    block.code = r.code;
    block.language = undefined;
    block.networks = undefined;
    store.touch();
    const ref = { kind: 'block' as const, deviceId: device.id, blockId: block.id };
    A.closeEditor(ref);
    A.openEditor(ref);
  };

  const applyErrors = () => {
    if (ladder) {
      ladder.setErrors(store.diagnosticsFor(block.id).filter((d) => d.location === 'code'));
      return;
    }
    if (!editor) return;
    const diags = store.diagnosticsFor(block.id).filter((d) => d.location === 'code' && d.codeLine);
    editor.setErrors(diags.map((d) => ({ line: d.codeLine!, message: d.message, severity: d.severity })));
  };

  const onGoto = (e: Event) => {
    const { blockId, line, network, element: el } = (e as CustomEvent).detail as { blockId: string; line: number; network?: number; element?: string };
    if (blockId !== block.id) return;
    if (ladder) setTimeout(() => ladder?.goto(network ?? 0, el), 30);
    else setTimeout(() => editor?.gotoLine(line), 30);
  };
  window.addEventListener('studio:goto-line', onGoto);

  // Instructions inserted from the task card ("Options d'appel" for timers/counters)
  /** Instance of a timer / counter / edge block: #multi-instance or "single instance DB". */
  const createInstance = async (fb: string): Promise<{ ref: string; multi: boolean; name: string } | null> => {
    const base = fb.includes('TRIG') ? 'R_TRIG_Instance' : fb.startsWith('CT') ? 'IEC_Counter_0' : 'IEC_Timer_0';
    const choice = await callOptionsDialog(device, block, fb, base);
    if (!choice) return null;
    if (choice.multi) {
      block.interface.static.push({ name: choice.name, dataType: fb });
      iface.render();
    } else if (!device.blocks.some((b) => b.name.toLowerCase() === choice.name.toLowerCase())) {
      const used = new Set(device.blocks.filter((b) => b.type === 'DB').map((b) => b.number));
      let n = 1;
      while (used.has(n)) n++;
      device.blocks.push({ id: newId('blk'), name: choice.name, type: 'DB', number: n, interface: { input: [], output: [], inout: [], static: [], temp: [], constant: [] }, code: '', instanceOf: fb });
    }
    store.touch();
    return { ref: choice.multi ? `#${choice.name}` : `"${choice.name}"`, ...choice };
  };

  const onInsert = async (e: Event) => {
    if (!element.isConnected) return;
    const it = (e as CustomEvent).detail as { name: string; snippet?: string; fb?: string };
    if (ladder) {
      if (!ladder.insertInstruction(it)) store.addMessage({ severity: 'warning', text: `L'instruction ${it.name} n'existe pas en CONT : utilisez un bloc SCL.`, path: blockLabel(block) });
      return;
    }
    if (!editor) return;
    if (!it.fb) {
      editor.insert(it.snippet ?? it.name);
      return;
    }
    const params: Record<string, string> = {
      TON: 'IN := , PT := T#1S', TOF: 'IN := , PT := T#1S', TP: 'IN := , PT := T#1S',
      CTU: 'CU := , R := , PV := ', CTD: 'CD := , LD := , PV := ', CTUD: 'CU := , CD := , R := , LD := , PV := ',
      R_TRIG: 'CLK := ', F_TRIG: 'CLK := ',
    };
    const choice = await createInstance(it.fb);
    if (!choice) return;
    editor.insert(choice.multi ? `#${choice.name}(${params[it.fb]});` : `"${choice.name}".${it.fb}(${params[it.fb]});`);
  };
  window.addEventListener('studio:insert-instruction', onInsert);
  const unsubscribe = store.on((topic) => {
    if (topic === 'compile') applyErrors();
  });

  // Monitoring: operands of each line
  let lineOperands: Array<{ line: number; label: string; path: string }> = [];
  /** Monitoring path of an operand as written in the code, null when it can't be read. */
  const pathOf = (op: string, symbols: SymbolNode[], globals: Set<string>, locals: Set<string>): string | null => {
    let path: string | null = null;
    if (op.startsWith('%') || op.startsWith('"')) path = op;
    else if (op.startsWith('#')) path = block.type === 'FB' && instance ? `"${instance}".${op.slice(1)}` : null;
    else if (locals.has(op.split('.')[0].toLowerCase())) path = block.type === 'FB' && instance ? `"${instance}".${op}` : null;
    else if (globals.has(op.split('.')[0].toLowerCase()) || device.blocks.some((b) => b.type === 'DB' && b.name.toLowerCase() === op.split('.')[0].toLowerCase())) {
      const [first, ...rest] = op.split('.');
      path = [`"${first}"`, ...rest].join('.');
    }
    if (!path) return null;
    const sym = op.startsWith('%') ? null : findSymbol(symbols, path);
    if (!op.startsWith('%') && (!sym || sym.children)) return null;
    return path;
  };
  const monitorContext = () => ({
    symbols: store.symbols(device.id),
    globals: new Set(device.tagTables.flatMap((tt) => tt.tags.map((x) => x.name.toLowerCase()))),
    locals: new Set(allMembers().map((m) => m.name.toLowerCase())),
  });
  let ladPaths: string[] = [];
  const ifaceMembers = () => (block.type === 'FB' && instance ? sections.filter((s) => s !== 'temp' && s !== 'constant').flatMap((s) => block.interface[s]) : []);
  const monitor = {
    deviceId: device.id,
    paths: () => {
      if (ladder) {
        ladPaths = ladder.monitorPaths();
        return [...ladPaths, ...ifaceMembers().map((m) => `"${instance}".${m.name}`)];
      }
      if (!editor) return [];
      const symbols = store.symbols(device.id);
      const globals = new Set(device.tagTables.flatMap((tt) => tt.tags.map((x) => x.name.toLowerCase())));
      const locals = new Set(allMembers().map((m) => m.name.toLowerCase()));
      const doc = editor.view.state.doc;
      const { from, to } = editor.view.viewport;
      const firstLine = doc.lineAt(from).number;
      const lastLine = doc.lineAt(to).number;
      lineOperands = [];
      for (let n = firstLine; n <= lastLine; n++) {
        for (const op of operandsOf(doc.line(n).text).slice(0, 6)) {
          const path = pathOf(op, symbols, globals, locals);
          if (path) lineOperands.push({ line: n, label: op, path });
        }
      }
      const ifacePaths = ifaceMembers().map((m) => `"${instance}".${m.name}`);
      return [...lineOperands.map((o) => o.path), ...ifacePaths];
    },
    apply: (values: Array<{ path: string; text?: string; error?: string }>) => {
      if (ladder) {
        const map = new Map<string, string>();
        ladPaths.forEach((p, i) => { if (values[i]?.text !== undefined && !values[i].error) map.set(p, values[i].text!); });
        ladder.applyMonitor(map);
        ifaceMembers().forEach((m, i) => {
          const v = values[ladPaths.length + i];
          iface.setMonitor(m, [{ text: v?.text ?? '', cls: valueClass(v?.text) }]);
        });
        return;
      }
      if (!editor) return;
      const byLine = new Map<number, Array<{ label: string; text: string }>>();
      lineOperands.forEach((o, i) => {
        const v = values[i];
        if (!v || v.error || v.text === undefined) return;
        const list = byLine.get(o.line) ?? [];
        list.push({ label: o.label, text: v.text });
        byLine.set(o.line, list);
      });
      editor.setMonitor([...byLine.entries()].map(([line, items]) => ({ line, items })));
      if (block.type === 'FB' && instance) {
        const members = sections.filter((s) => s !== 'temp' && s !== 'constant').flatMap((s) => block.interface[s]);
        members.forEach((m, i) => {
          const v = values[lineOperands.length + i];
          iface.setMonitor(m, [{ text: v?.text ?? '', cls: valueClass(v?.text) }]);
        });
      }
    },
  };

  return {
    element,
    icon: blockIcon(block),
    title: () => blockLabel(block),
    crumbs: () => [device.name, t.programBlocks, blockLabel(block)],
    shown: () => {
      if (isLad && !ladder) {
        ladder = new LadderEditor(codeWrap, {
          device, block,
          onChange: () => store.touch(),
          locals: () => allMembers().map((m) => m.name),
          monitorPath: (op) => {
            const c = monitorContext();
            return pathOf(op, c.symbols, c.globals, c.locals);
          },
          createInstance: async (fb) => (await createInstance(fb))?.ref ?? null,
        });
        applyErrors();
      } else if (!isLad && !editor) {
        editor = new SclEditor(codeWrap, block.code, (text) => {
          block.code = text;
          store.touch();
        }, completions);
        applyErrors();
      }
      refreshInstances();
    },
    refresh: () => {
      iface.render();
      editor?.setText(block.code);
      ladder?.render();
      refreshInstances();
    },
    monitor,
    monitorStopped: () => {
      editor?.setMonitor([]);
      ladder?.stopMonitor();
      iface.clearMonitor();
    },
    destroy: () => {
      window.removeEventListener('studio:goto-line', onGoto);
      window.removeEventListener('studio:insert-instruction', onInsert);
      unsubscribe();
      editor?.destroy();
      ladder?.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Data blocks
// ---------------------------------------------------------------------------

/** Absolute address of a DB member (after compilation), e.g. DB3.DBD4 — for HMIs using S7 communication. */
function absoluteAddress(device: Device, block: Block, member: string): string {
  const c = store.compile.get(device.id);
  const db = c?.dbs.find((d) => d.name === block.name);
  const sym = c ? findSymbol(c.symbols, `"${block.name}".${member}`) : null;
  if (!db || !sym) return '';
  const rel = sym.offset - db.offset;
  const p = `DB${db.number}.`;
  if (sym.kind === 'bool') return `${p}DBX${rel}.${sym.bit ?? 0}`;
  if (!sym.children && sym.size === 1) return `${p}DBB${rel}`;
  if (!sym.children && sym.size === 2) return `${p}DBW${rel}`;
  if (!sym.children && sym.size === 4) return `${p}DBD${rel}`;
  return `${p}DBB${rel} (${sym.size} o)`;
}

function dbEditor(device: Device, block: Block): EditorView {
  const instanceRows = (): Member[] => {
    const fb = device.blocks.find((b) => b.type === 'FB' && b.name === block.instanceOf);
    if (fb) return [...fb.interface.input, ...fb.interface.output, ...fb.interface.inout, ...fb.interface.static];
    const lib: Record<string, string[]> = {
      TON: ['IN:Bool', 'PT:Time', 'Q:Bool', 'ET:Time'], TOF: ['IN:Bool', 'PT:Time', 'Q:Bool', 'ET:Time'], TP: ['IN:Bool', 'PT:Time', 'Q:Bool', 'ET:Time'],
      CTU: ['CU:Bool', 'R:Bool', 'PV:Int', 'Q:Bool', 'CV:Int'], CTD: ['CD:Bool', 'LD:Bool', 'PV:Int', 'Q:Bool', 'CV:Int'],
      CTUD: ['CU:Bool', 'CD:Bool', 'R:Bool', 'LD:Bool', 'PV:Int', 'QU:Bool', 'QD:Bool', 'CV:Int'], R_TRIG: ['CLK:Bool', 'Q:Bool'], F_TRIG: ['CLK:Bool', 'Q:Bool'],
    };
    return (lib[(block.instanceOf ?? '').toUpperCase()] ?? []).map((x) => ({ name: x.split(':')[0], dataType: x.split(':')[1] }));
  };
  const isInstance = !!block.instanceOf;
  const rows = () => (isInstance ? instanceRows() : (block.members ??= []));

  const grid = new Grid<Member>({
    numbered: true,
    rowIcon: () => 'tagTable',
    columns: [
      { title: t.name, width: '26%', kind: isInstance ? 'readonly' : 'text', primary: !isInstance, get: (r) => r.name, set: (r, v) => { r.name = v.trim(); } },
      { title: t.dataType, width: '18%', kind: isInstance ? 'readonly' : 'text', get: (r) => r.dataType, set: (r, v) => { r.dataType = v.trim(); }, suggestions: () => typeSuggestions(device) },
      { title: t.startValue, width: '14%', kind: isInstance ? 'readonly' : 'text', mono: true, get: (r) => r.defaultValue ?? '', set: (r, v) => { r.defaultValue = v.trim() || undefined; } },
      { title: 'Décalage', width: '11%', kind: 'readonly', mono: true, get: (r) => absoluteAddress(device, block, r.name) },
      { title: t.monitorValue, width: '14%', kind: 'monitor', get: () => '' },
      { title: t.comment, kind: isInstance ? 'readonly' : 'text', get: (r) => r.comment ?? '', set: (r, v) => { r.comment = v || undefined; } },
      ...(isInstance ? [] : hmiColumns<Member>()),
    ],
    sections: () => [{ title: isInstance ? `${t.instanceDbOf} ${block.instanceOf}` : 'Static', icon: 'folder', rows: rows(), create: isInstance ? undefined : (name: string) => ({ name, dataType: 'Int' }), canAdd: !isInstance }],
    onChange: () => store.touch(),
  });

  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'panel-toolbar' },
      h('button', { className: 'tbtn', title: t.monitorAll, onclick: () => void A.toggleMonitorCmd() }, svg(icons.glasses)),
      h('span', { className: 'muted', style: 'margin-left:8px' }, isInstance ? `DB d'instance : la structure est définie par ${block.instanceOf}.` : 'DB global : définissez les variables et leurs valeurs de départ.')),
    grid.element);

  const leaves = (): Array<{ row: Member; path: string }> => rows().map((r) => ({ row: r, path: `"${block.name}".${r.name}` }));
  const monitorable = (sym: SymbolNode | null) => sym && !sym.children;
  return {
    element,
    icon: 'db',
    title: () => blockLabel(block),
    crumbs: () => [device.name, t.programBlocks, blockLabel(block)],
    refresh: () => grid.render(),
    monitor: {
      deviceId: device.id,
      paths: () => leaves().filter((l) => monitorable(findSymbol(store.symbols(device.id), l.path))).map((l) => l.path),
      apply: (values) => {
        const map = new Map(values.map((v) => [v.path, v]));
        for (const l of leaves()) {
          const v = map.get(l.path);
          grid.setMonitor(l.row, [{ text: v?.text ?? '', cls: valueClass(v?.text) }]);
        }
      },
    },
    monitorStopped: () => grid.clearMonitor(),
  };
}

/** "Options d'appel": single instance (instance DB) or multi-instance (static of the FB). */
function callOptionsDialog(device: Device, block: Block, fb: string, base: string): Promise<{ multi: boolean; name: string } | null> {
  return new Promise((resolve) => {
    let result: { multi: boolean; name: string } | null = null;
    openDialog("Options d'appel", (d) => {
      const multiAllowed = block.type === 'FB';
      let multi = multiAllowed;
      const free = (suffix: string) => {
        let n = 0;
        const taken = (x: string) => device.blocks.some((b) => b.name.toLowerCase() === x.toLowerCase()) || block.interface.static.some((m) => m.name.toLowerCase() === x.toLowerCase());
        while (taken(`${base.replace(/_0$/, '')}_${n}${suffix}`)) n++;
        return `${base.replace(/_0$/, '')}_${n}${suffix}`;
      };
      const name = h('input', { value: free(multi ? '_Instance' : '_DB'), style: 'width:260px' });
      const option = (value: boolean, label: string, text: string) => h('label', { style: `display:grid;grid-template-columns:20px 1fr;gap:4px;padding:10px;border:1px solid var(--border-light);margin-bottom:6px;opacity:${!value || multiAllowed ? 1 : 0.5}` },
        h('input', { type: 'radio', name: 'callopt', checked: multi === value, disabled: value && !multiAllowed, onchange: () => { multi = value; name.value = free(multi ? '_Instance' : '_DB'); } }),
        h('div', null, h('b', null, label), h('div', { className: 'muted' }, text)));
      d.body.append(h('div', { style: 'width:520px' },
        option(false, 'Instance unique', `Le bloc ${fb} enregistre ses données dans son propre DB d'instance.`),
        option(true, 'Multi-instance', `Le bloc ${fb} enregistre ses données dans le DB d'instance du bloc appelant (variable Static).`),
        h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, 'Nom'), name)));
      d.foot.append(button('OK', () => { result = { multi, name: name.value.trim() }; d.close(); }, true), button('Annuler', () => d.close()));
    }, { onClose: () => resolve(result && result.name ? result : null) });
  });
}
