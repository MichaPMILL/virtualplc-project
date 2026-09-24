// Object-oriented programming: method editor (methods of a function block) and interface editor.
import { newMethod, type Block, type BlockMethod, type Device, type InterfaceDef, type Member } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { icons, type IconName } from '../icons.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import { typeSuggestions } from './block.ts';
import { Grid } from './grid.ts';
import { SclEditor, type CompletionSource } from './sclEditor.ts';
import { button, openDialog, promptDialog } from '../ui/dialogs.ts';
import type { EditorView } from './types.ts';

type MethodSection = 'input' | 'output' | 'inout' | 'temp' | 'constant';
const LABELS: Record<MethodSection, string> = { input: t.sInput, output: t.sOutput, inout: t.sInOut, temp: t.sTemp, constant: t.sConstant };
const NAME_RE = /^[A-Za-z_]\w*$/;

export function methodLabel(block: Block, m: BlockMethod): string {
  const ret = m.returnType && !/^void$/i.test(m.returnType.trim()) ? ` : ${m.returnType}` : '';
  return `${block.name}.${m.name}${ret}`;
}

function memberGrid(device: Device, lists: () => Array<{ title: string; rows: Member[] }>): Grid<Member> {
  const all = () => lists().flatMap((l) => l.rows);
  return new Grid<Member>({
    columns: [
      {
        title: t.name, width: '26%', kind: 'text', primary: true, get: (r) => r.name, set: (r, v) => { r.name = v.trim(); },
        validate: (v, r) => (!NAME_RE.test(v.trim()) ? 'Nom invalide (lettres, chiffres et _)'
          : all().some((m) => m !== r && m.name.toLowerCase() === v.trim().toLowerCase()) ? `Le nom « ${v} » existe déjà` : null),
      },
      { title: t.dataType, width: '20%', kind: 'text', get: (r) => r.dataType, set: (r, v) => { r.dataType = v.trim(); }, suggestions: () => [...typeSuggestions(device), ...(device.interfaces ?? []).map((i) => `"${i.name}"`)] },
      { title: t.defaultValue, width: '14%', kind: 'text', mono: true, get: (r) => r.defaultValue ?? '', set: (r, v) => { r.defaultValue = v.trim() || undefined; } },
      { title: t.comment, kind: 'text', get: (r) => r.comment ?? '', set: (r, v) => { r.comment = v || undefined; } },
    ],
    rowIcon: () => 'tagTable',
    sections: () => lists().map((l) => ({
      title: l.title, icon: 'folder' as IconName, rows: l.rows,
      create: (name: string) => {
        let n = 1;
        while (all().some((m) => m.name.toLowerCase() === `var_${n}`)) n++;
        return { name: NAME_RE.test(name) ? name : `Var_${n}`, dataType: 'Bool' };
      },
    })),
    onChange: () => store.touch(),
  });
}

const field = (label: string, input: HTMLElement) => h('span', { style: 'display:flex;align-items:center;gap:4px' }, h('span', { className: 'muted' }, label), input);

export function methodEditor(device: Device, block: Block, method: BlockMethod): EditorView {
  const sections: MethodSection[] = ['input', 'output', 'inout', 'temp', 'constant'];
  const grid = memberGrid(device, () => sections.map((s) => ({ title: LABELS[s], rows: method.interface[s] })));

  const ret = h('input', { value: method.returnType ?? 'Void', style: 'width:110px;height:22px', title: 'Type de la valeur de retour (Void = aucune)' });
  ret.onchange = () => { method.returnType = ret.value.trim() || 'Void'; store.touch(); store.emit('editors'); };
  const access = h('select', { style: 'height:22px' }, ...['PUBLIC', 'PROTECTED', 'PRIVATE', 'INTERNAL'].map((a) => h('option', { value: a }, a)));
  access.value = method.access ?? 'PUBLIC';
  access.onchange = () => { method.access = access.value === 'PUBLIC' ? undefined : access.value as BlockMethod['access']; store.touch(); };
  const flag = (key: 'abstract' | 'final' | 'override', label: string, title: string) => {
    const box = h('input', { type: 'checkbox', checked: !!method[key] });
    box.onchange = () => {
      if (box.checked) method[key] = true;
      else delete method[key];
      if (key === 'abstract') codeBox.classList.toggle('hidden', box.checked);
      store.touch();
    };
    return h('label', { style: 'display:flex;align-items:center;gap:3px', title }, box, label);
  };
  const comment = h('input', { value: method.comment ?? '', placeholder: 'Commentaire de la méthode', style: 'flex:1;height:22px' });
  comment.onchange = () => { method.comment = comment.value || undefined; store.touch(); };

  const codeWrap = h('div', { className: 'cm-wrap' });
  const codeBox = h('div', { className: 'block-code' },
    h('div', { className: 'panel-subheader', style: 'gap:6px' }, svg(icons.method), methodLabel(block, method)), codeWrap);
  if (method.abstract) codeBox.classList.add('hidden');
  const fbMembers = () => [...block.interface.input, ...block.interface.output, ...block.interface.inout, ...block.interface.static];
  const completions: CompletionSource = {
    globals: () => [
      ...device.tagTables.flatMap((tt) => tt.tags.map((x) => ({ name: x.name, type: x.dataType }))),
      ...device.blocks.filter((b) => b.type === 'DB').map((b) => ({ name: b.name, type: b.instanceOf ?? 'DB' })),
      ...device.blocks.filter((b) => b.type === 'FC').map((b) => ({ name: b.name, type: 'FC' })),
    ],
    locals: () => [
      ...sections.flatMap((s) => method.interface[s]).map((m) => ({ name: m.name, type: m.dataType })),
      ...fbMembers().map((m) => ({ name: m.name, type: m.dataType })),
      ...(block.methods ?? []).filter((m) => m !== method).map((m) => ({ name: m.name, type: 'METHOD' })),
    ],
    members: () => [],
  };
  let editor: SclEditor | null = null;
  const applyErrors = () => {
    const diags = store.diagnosticsFor(block.id).filter((d) => d.methodId === method.id && d.location === 'code' && d.codeLine);
    editor?.setErrors(diags.map((d) => ({ line: d.codeLine!, message: d.message, severity: d.severity })));
  };
  const onGoto = (e: Event) => {
    const { methodId, line } = (e as CustomEvent).detail as { methodId?: string; line?: number };
    if (methodId === method.id && line) setTimeout(() => editor?.gotoLine(line), 30);
  };
  window.addEventListener('studio:goto-line', onGoto);
  const unsubscribe = store.on((topic) => { if (topic === 'compile') applyErrors(); });

  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'panel-toolbar', style: 'gap:10px' },
      h('button', { className: 'tbtn', title: t.compile, onclick: () => void A.compileCmd(device) }, svg(icons.compile)),
      h('span', { className: 'sep' }),
      field('Retour', ret), field('Accès', access),
      flag('abstract', 'ABSTRACT', 'Méthode sans code, à implémenter par les blocs dérivés (le FB doit être ABSTRACT)'),
      flag('final', 'FINAL', 'Ne peut pas être redéfinie par les blocs dérivés'),
      flag('override', 'OVERRIDE', 'Redéfinit la méthode du bloc de base'),
      comment),
    h('div', { className: 'block-editor', style: 'flex:1;min-height:0' },
      h('div', { className: 'block-interface', style: '--iface-h:190px' },
        h('div', { className: 'panel-subheader' }, ' Interface de la méthode'), h('div', { style: 'flex:1;display:flex;min-height:0' }, grid.element)),
      codeBox));

  return {
    element, icon: 'method',
    title: () => `${block.name}.${method.name}`,
    crumbs: () => [device.name, t.programBlocks, block.name, method.name],
    shown: () => {
      if (!editor) {
        editor = new SclEditor(codeWrap, method.code, (text) => { method.code = text; store.touch(); }, completions);
        applyErrors();
      }
    },
    refresh: () => {
      grid.render();
      editor?.setText(method.code);
    },
    destroy: () => {
      window.removeEventListener('studio:goto-line', onGoto);
      unsubscribe();
      editor?.destroy();
    },
  };
}

/** Interface: method prototypes (parameters and return type, no code) */
export function interfaceEditor(device: Device, ifc: InterfaceDef): EditorView {
  let current: BlockMethod | undefined = ifc.methods[0];
  const list = h('div', { className: 'ifc-methods' });
  const grid = memberGrid(device, () => current
    ? (['input', 'output', 'inout'] as const).map((s) => ({ title: LABELS[s], rows: current!.interface[s] }))
    : []);
  const ret = h('input', { style: 'width:120px;height:22px' });
  ret.onchange = () => {
    if (!current) return;
    current.returnType = ret.value.trim() || 'Void';
    store.touch();
    renderList();
  };
  const ext = h('input', { value: (ifc.extends ?? []).join(', '), placeholder: 'Interfaces de base (séparées par des virgules)', style: 'width:260px;height:22px' });
  ext.onchange = () => {
    const names = ext.value.split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
    if (names.length) ifc.extends = names;
    else delete ifc.extends;
    store.touch();
  };
  const comment = h('input', { value: ifc.comment ?? '', placeholder: 'Commentaire', style: 'flex:1;height:22px' });
  comment.onchange = () => { ifc.comment = comment.value || undefined; store.touch(); };

  const renderList = () => {
    clear(list);
    for (const m of ifc.methods) {
      const r = m.returnType && !/^void$/i.test(m.returnType) ? ` : ${m.returnType}` : '';
      list.append(h('div', { className: `ifc-method${m === current ? ' selected' : ''}`, onclick: () => select(m) }, svg(icons.method), ` ${m.name}${r}`));
    }
    ret.disabled = !current;
    ret.value = current?.returnType ?? '';
  };
  const select = (m: BlockMethod | undefined) => {
    current = m;
    renderList();
    grid.render();
  };
  const add = async () => {
    const name = await promptDialog('Ajouter une méthode', t.name, `Method_${ifc.methods.length + 1}`);
    if (!name) return;
    if (ifc.methods.some((m) => m.name.toLowerCase() === name.toLowerCase())) return;
    const m = newMethod(name);
    ifc.methods.push(m);
    store.touch();
    select(m);
  };
  const rename = async () => {
    if (!current) return;
    const name = await promptDialog('Renommer la méthode', t.name, current.name);
    if (!name) return;
    current.name = name;
    store.touch();
    renderList();
  };
  const remove = () => {
    if (!current) return;
    ifc.methods = ifc.methods.filter((m) => m !== current);
    store.touch();
    select(ifc.methods[0]);
  };
  const implementers = () => device.blocks.filter((b) => b.implements?.some((n) => n.toLowerCase() === ifc.name.toLowerCase())).map((b) => b.name);

  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'panel-toolbar', style: 'gap:8px' },
      h('button', { className: 'tbtn', title: 'Ajouter une méthode', onclick: () => void add() }, svg(icons.add)),
      h('button', { className: 'tbtn', title: 'Renommer la méthode', onclick: () => void rename() }, 'Renommer'),
      h('button', { className: 'tbtn', title: 'Supprimer la méthode', onclick: () => remove() }, svg(icons.del)),
      h('span', { className: 'sep' }),
      field('Retour', ret), field('EXTENDS', ext), comment),
    h('div', { className: 'muted', style: 'padding:4px 10px' },
      `Interface : méthodes (sans code) que les FB doivent implémenter (FUNCTION_BLOCK … IMPLEMENTS "${ifc.name}"). `
      + `Une variable de type "${ifc.name}" référence n'importe quelle instance qui l'implémente ; l'appel ref.Methode() exécute la méthode du bloc de l'instance.`),
    h('div', { style: 'flex:1;display:flex;min-height:0' },
      h('div', { style: 'width:220px;border-right:1px solid var(--border);overflow:auto' }, list),
      h('div', { style: 'flex:1;display:flex;min-height:0' }, grid.element)));
  renderList();
  return {
    element, icon: 'iface', title: () => ifc.name, crumbs: () => [device.name, 'Interfaces', ifc.name],
    refresh: () => {
      if (current && !ifc.methods.includes(current)) current = ifc.methods[0];
      renderList();
      grid.render();
      element.title = implementers().length ? `Implémentée par : ${implementers().join(', ')}` : '';
    },
  };
}

/** Inheritance of a function block: EXTENDS, IMPLEMENTS, ABSTRACT, FINAL */
export function inheritanceDialog(device: Device, block: Block): void {
  openDialog(`Héritage et interfaces — ${block.name}`, (d) => {
    const base = h('select', { style: 'width:100%' }, h('option', { value: '' }, '— aucun —'),
      ...device.blocks.filter((b) => b.type === 'FB' && b !== block && !b.final).map((b) => h('option', { value: b.name }, b.name)));
    base.value = block.extends ?? '';
    const boxes = (device.interfaces ?? []).map((i) => {
      const box = h('input', { type: 'checkbox', checked: !!block.implements?.some((n) => n.toLowerCase() === i.name.toLowerCase()) });
      return { name: i.name, box, el: h('label', { style: 'display:flex;gap:4px;align-items:center' }, box, svg(icons.iface), i.name) };
    });
    const abstract = h('input', { type: 'checkbox', checked: !!block.abstract });
    const final = h('input', { type: 'checkbox', checked: !!block.final });
    d.body.append(h('div', { className: 'form', style: 'display:flex;flex-direction:column;gap:8px;min-width:380px' },
      h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, 'EXTENDS'), base),
      h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, 'IMPLEMENTS'),
        boxes.length ? h('div', null, ...boxes.map((b) => b.el)) : h('span', { className: 'muted' }, 'Aucune interface dans le projet')),
      h('label', { style: 'display:flex;gap:4px;align-items:center' }, abstract, 'ABSTRACT (pas d\'instance ; méthodes abstraites autorisées)'),
      h('label', { style: 'display:flex;gap:4px;align-items:center' }, final, 'FINAL (ne peut pas être étendu)'),
      h('div', { className: 'desc' }, 'Un FB dérivé hérite des variables et des méthodes de son bloc de base ; il peut redéfinir les méthodes, '
        + 'appeler celles du bloc de base avec SUPER.Methode() et le code du bloc de base avec SUPER().')));
    d.foot.append(button(t.ok, () => {
      if (base.value) block.extends = base.value;
      else delete block.extends;
      const impl = boxes.filter((b) => b.box.checked).map((b) => b.name);
      if (impl.length) block.implements = impl;
      else delete block.implements;
      if (abstract.checked) block.abstract = true;
      else delete block.abstract;
      if (final.checked) block.final = true;
      else delete block.final;
      store.touch();
      d.close();
    }, true), button(t.cancel, () => d.close()));
  });
}
