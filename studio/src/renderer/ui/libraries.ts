// Task card "Bibliothèques": project library, global libraries (.vplclib files shared between
// projects) and the VirtualPLC standard library. An element (block, PLC data type, interface)
// is inserted into the CPU with what it needs; copies keep their version and are updated
// when the library has a newer one.
import {
  addToLibrary, compareVersions, insertFromLibrary, LIBRARY_FORMAT, newLibrary, outdatedCopies, parseLibrary, serializeLibrary, standardLibrary,
  type Device, type Library, type LibraryElement, type LibraryElementKind,
} from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { call, host } from '../host.ts';
import { icons, type IconName } from '../icons.ts';
import { store } from '../store.ts';
import { contextMenu } from './chrome.ts';
import { alertDialog, confirmDialog, promptDialog } from './dialogs.ts';

const GLOBALS_KEY = 'vplc.globalLibraries';

interface OpenGlobal {
  path: string;
  lib: Library;
}

const globals: OpenGlobal[] = [];
let globalsLoaded = false;

function savedPaths(): string[] {
  try {
    return JSON.parse(localStorage.getItem(GLOBALS_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function rememberPaths(): void {
  try {
    localStorage.setItem(GLOBALS_KEY, JSON.stringify(globals.map((g) => g.path)));
  } catch {
    // private window: the list is not kept
  }
}

async function loadGlobals(): Promise<void> {
  if (globalsLoaded) return;
  globalsLoaded = true;
  for (const path of savedPaths()) {
    try {
      globals.push({ path, lib: parseLibrary(await call('libraryRead', path)) });
    } catch {
      // moved or deleted: forgotten
    }
  }
  rememberPaths();
}

async function saveGlobal(g: OpenGlobal): Promise<void> {
  await call('libraryWrite', g.path, serializeLibrary(g.lib));
}

/** The project library as a Library (its elements are saved with the project) */
function projectLibrary(): Library | null {
  const p = store.project;
  if (!p) return null;
  return { format: LIBRARY_FORMAT, id: 'lib-project', name: `Bibliothèque du projet ${p.name}`, elements: (p.library ??= []) };
}

const KIND_ICON: Record<LibraryElementKind, IconName> = { block: 'fb', type: 'dataType', interface: 'iface' };

function elementIcon(e: LibraryElement): IconName {
  if (e.kind !== 'block' || !e.block) return KIND_ICON[e.kind];
  return ({ FB: 'fb', FC: 'fc', OB: 'ob', DB: 'db' } as Record<string, IconName>)[e.block.type] ?? 'fb';
}

/** Selected element of the project tree that can go into a library */
function selectedElement(): { device: Device; kind: LibraryElementKind; name: string } | null {
  const sel = store.selection;
  const device = A.currentDevice();
  if (!sel || !device) return null;
  if (sel.kind === 'block') {
    const b = device.blocks.find((x) => x.id === sel.id);
    return b && b.type !== 'OB' ? { device, kind: 'block', name: b.name } : null;
  }
  if (sel.kind === 'dataType') {
    const t = device.types.find((x) => x.id === sel.id);
    return t ? { device, kind: 'type', name: t.name } : null;
  }
  if (sel.kind === 'interface') {
    const i = device.interfaces?.find((x) => x.id === sel.id);
    return i ? { device, kind: 'interface', name: i.name } : null;
  }
  return null;
}

/** Adds a CPU element to a library (from the tree or the card) */
export async function addElementToLibrary(target: 'project' | string, device: Device, kind: LibraryElementKind, name: string): Promise<void> {
  const lib = target === 'project' ? projectLibrary() : globals.find((g) => g.path === target)?.lib;
  if (!lib) return;
  const existing = lib.elements.find((e) => e.name.toUpperCase() === name.toUpperCase());
  const category = existing?.category ?? (await promptDialog('Bibliothèque', `Catégorie de « ${name} » dans ${lib.name}`, 'Général'));
  if (category === null) return;
  const added = addToLibrary(lib, device, kind, name, { category: category || undefined });
  const main = added.find((e) => e.name === name);
  if (target === 'project') store.touch();
  else await saveGlobal(globals.find((g) => g.path === target)!);
  store.addMessage({
    severity: 'ok', path: lib.name,
    text: `« ${name} » version ${main?.version ?? '?'} ajouté à ${lib.name}${added.length > 1 ? ` avec ${added.filter((e) => e !== main).map((e) => e.name).join(', ')}` : ''}.`,
  });
  window.dispatchEvent(new CustomEvent('studio:libraries-changed'));
}

async function insert(lib: Library, e: LibraryElement): Promise<void> {
  const device = A.currentDevice();
  if (!device) return;
  const clash = [e.name, ...e.dependencies].filter((n) => [...device.blocks, ...device.types, ...(device.interfaces ?? [])].some((x) => x.name.toUpperCase() === n.toUpperCase()));
  if (clash.includes(e.name) && !(await confirmDialog('Bibliothèque', `« ${e.name} » existe déjà dans ${device.name}. Le remplacer par la version ${e.version} de ${lib.name} ?`, 'Remplacer', 'Annuler'))) return;
  const r = insertFromLibrary(device, lib, e.name);
  store.touch();
  store.emit('editors');
  const parts = [r.added.length ? `ajouté : ${r.added.join(', ')}` : '', r.updated.length ? `mis à jour : ${r.updated.join(', ')}` : '', r.unchanged.length ? `déjà présent : ${r.unchanged.join(', ')}` : ''].filter(Boolean);
  store.addMessage({ severity: 'ok', path: device.name, text: `${lib.name} › ${e.name} ${e.version} — ${parts.join(' ; ')}.` });
  const block = device.blocks.find((b) => b.name === e.name);
  if (block) A.openEditor({ kind: 'block', deviceId: device.id, blockId: block.id });
}

async function updateCopies(lib: Library): Promise<void> {
  const device = A.currentDevice();
  if (!device) return;
  const list = outdatedCopies(device, lib);
  if (!list.length) return;
  if (!(await confirmDialog('Mise à jour', `Mettre à jour dans ${device.name} :\n${list.map((x) => `• ${x.name} ${x.have} → ${x.latest}`).join('\n')}`, 'Mettre à jour', 'Annuler'))) return;
  for (const x of list) insertFromLibrary(device, lib, x.name, { replace: false });
  for (const x of list) insertFromLibrary(device, lib, x.name);
  store.touch();
  store.emit('editors');
  store.addMessage({ severity: 'ok', path: device.name, text: `${list.length} élément(s) mis à jour depuis ${lib.name}.` });
}

export function librariesCard(body: HTMLElement, rerender: () => void): void {
  void loadGlobals().then(() => { if (!rendered) rerender(); });
  let rendered = globalsLoaded;
  const filter = h('input', { placeholder: 'Rechercher…', style: 'width:100%;box-sizing:border-box' });
  const lists = h('div');
  filter.oninput = () => renderLists();

  const section = (lib: Library, opts: { global?: OpenGlobal; open?: boolean }) => {
    const device = A.currentDevice();
    const outdated = device ? outdatedCopies(device, lib) : [];
    const q = filter.value.trim().toLowerCase();
    const elements = lib.elements.filter((e) => !q || e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q) || (e.category ?? '').toLowerCase().includes(q));
    const byCategory = new Map<string, LibraryElement[]>();
    for (const e of [...elements].sort((a, b) => a.name.localeCompare(b.name))) {
      const c = e.category ?? 'Général';
      if (!byCategory.has(c)) byCategory.set(c, []);
      byCategory.get(c)!.push(e);
    }
    const head = h('div', { className: 'ps-head lib-head',
      oncontextmenu: (ev: Event) => contextMenu(ev as MouseEvent, [
        ...(opts.global ? [{ label: 'Fermer la bibliothèque', run: () => { globals.splice(globals.indexOf(opts.global!), 1); rememberPaths(); rerender(); } }] : []),
        ...(outdated.length ? [{ label: 'Mettre à jour les copies du projet', run: () => void updateCopies(lib).then(rerender) }] : []),
      ]) },
    svg(icons.folder), h('b', null, lib.name), lib.readOnly ? h('span', { className: 'muted' }, ' (lecture seule)') : '');
    const out = h('div', { className: 'palette-section lib-section' }, head);
    if (outdated.length) {
      out.append(h('div', { className: 'lib-update' }, `${outdated.length} mise(s) à jour disponible(s) pour ${device?.name}`,
        h('button', { className: 'tbtn', onclick: () => void updateCopies(lib).then(rerender) }, 'Mettre à jour')));
    }
    if (!elements.length) {
      out.append(h('div', { className: 'muted', style: 'padding:4px 12px' }, q ? 'Aucun élément trouvé.' : lib.readOnly ? '' : 'Vide : sélectionnez un bloc, un type ou une interface dans l\'arborescence puis « Ajouter ».'));
    }
    for (const [cat, list] of byCategory) {
      out.append(h('div', { className: 'lib-cat' }, cat));
      for (const e of list) {
        const copy = device ? [...device.blocks, ...device.types, ...(device.interfaces ?? [])].find((x) => x.name === e.name && x.library?.library === lib.name) : undefined;
        const status = copy ? (compareVersions(copy.library!.version, e.version) < 0 ? `dans le projet : ${copy.library!.version} (mise à jour ${e.version})` : 'dans le projet') : '';
        out.append(h('div', {
          className: 'palette-item lib-item',
          title: `${e.description ?? ''}${e.dependencies.length ? `\nUtilise : ${e.dependencies.join(', ')}` : ''}\nDouble-clic : insérer dans ${device?.name ?? 'l\'appareil'}`,
          ondblclick: () => void insert(lib, e).then(rerender),
          oncontextmenu: (ev: Event) => contextMenu(ev as MouseEvent, [
            { label: `Insérer dans ${device?.name ?? 'l\'appareil'}`, icon: 'add', run: () => void insert(lib, e).then(rerender) },
            ...(!opts.global && lib.id !== 'lib-project' ? [] : []),
            ...(lib.id !== 'lib-project' ? [{ label: 'Copier dans la bibliothèque du projet', run: () => {
              const p = projectLibrary()!;
              const i = p.elements.findIndex((x) => x.name === e.name);
              if (i >= 0) p.elements[i] = JSON.parse(JSON.stringify(e)); else p.elements.push(JSON.parse(JSON.stringify(e)));
              for (const d of e.dependencies) {
                const dep = lib.elements.find((x) => x.name === d);
                if (dep && !p.elements.some((x) => x.name === d)) p.elements.push(JSON.parse(JSON.stringify(dep)));
              }
              store.touch();
              rerender();
            } }] : []),
            ...globals.filter((g) => g.lib !== lib).map((g) => ({ label: `Copier dans ${g.lib.name}`, run: async () => {
              const i = g.lib.elements.findIndex((x) => x.name === e.name);
              const copyE = JSON.parse(JSON.stringify(e)) as LibraryElement;
              if (i >= 0) g.lib.elements[i] = copyE; else g.lib.elements.push(copyE);
              for (const d of e.dependencies) {
                const dep = lib.elements.find((x) => x.name === d);
                if (dep && !g.lib.elements.some((x) => x.name === d)) g.lib.elements.push(JSON.parse(JSON.stringify(dep)));
              }
              await saveGlobal(g);
              rerender();
            } })),
            ...(!lib.readOnly ? ['sep' as const, { label: 'Supprimer de la bibliothèque', icon: 'del' as const, run: async () => {
              const users = lib.elements.filter((x) => x.dependencies.includes(e.name)).map((x) => x.name);
              if (!(await confirmDialog('Bibliothèque', `Supprimer « ${e.name} » de ${lib.name} ?${users.length ? `\nIl est utilisé par : ${users.join(', ')}.` : ''}`))) return;
              lib.elements.splice(lib.elements.indexOf(e), 1);
              if (opts.global) await saveGlobal(opts.global); else store.touch();
              rerender();
            } }] : []),
          ]),
          draggable: 'true',
          ondragstart: (ev: Event) => (ev as DragEvent).dataTransfer?.setData('text/plain', `"${e.name}"`),
        }, svg(icons[elementIcon(e)]), h('b', null, e.name), h('span', { className: 'lib-ver' }, e.version),
        h('span', { className: 'desc' }, status || e.description || '')));
      }
    }
    return out;
  };

  const renderLists = () => {
    clear(lists);
    const proj = projectLibrary();
    if (proj) lists.append(section(proj, {}));
    for (const g of globals) lists.append(section(g.lib, { global: g }));
    lists.append(section(standardLibrary(), {}));
  };

  const sel = selectedElement();
  const addButton = (label: string, target: 'project' | string) => h('button', {
    className: 'tbtn', disabled: !sel,
    title: sel ? `Ajouter « ${sel.name} » (et ce qu'il utilise)` : 'Sélectionnez un bloc (FB, FC, DB global), un type de données ou une interface dans l\'arborescence',
    onclick: () => { if (sel) void addElementToLibrary(target, sel.device, sel.kind, sel.name).then(rerender); },
  }, svg(icons.add), label);

  body.append(
    h('div', { className: 'lib-toolbar' },
      addButton('Ajouter au projet', 'project'),
      ...globals.map((g) => addButton(`Ajouter à ${g.lib.name}`, g.path))),
    h('div', { className: 'lib-toolbar' },
      h('button', { className: 'tbtn', title: 'Ouvrir une bibliothèque globale (.vplclib)', onclick: async () => {
        const path = await host.pickPath('openLibrary');
        if (!path || globals.some((g) => g.path === path)) return;
        try {
          globals.push({ path, lib: parseLibrary(await call('libraryRead', path)) });
          rememberPaths();
          rerender();
        } catch (e) {
          await alertDialog('Bibliothèque', (e as Error).message, 'error');
        }
      } }, svg(icons.open), 'Ouvrir…'),
      h('button', { className: 'tbtn', title: 'Créer une bibliothèque globale (partagée entre projets)', onclick: async () => {
        const name = await promptDialog('Nouvelle bibliothèque globale', 'Nom de la bibliothèque', 'Bibliothèque_1');
        if (!name) return;
        const path = await host.pickPath('saveLibrary', `${name}.vplclib`);
        if (!path) return;
        const g = { path, lib: newLibrary(name, store.project?.author) };
        try {
          await saveGlobal(g);
          globals.push(g);
          rememberPaths();
          rerender();
        } catch (e) {
          await alertDialog('Bibliothèque', (e as Error).message, 'error');
        }
      } }, svg(icons.add), 'Nouvelle…')),
    h('div', { style: 'padding:4px 8px' }, filter),
    lists);
  renderLists();
  rendered = true;
}
