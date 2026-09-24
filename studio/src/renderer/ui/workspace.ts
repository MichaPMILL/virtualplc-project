// Work area (editors), editor bar at the bottom, portal view.
import { DEVICE_TYPES, blockLabel } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { t } from '../i18n.ts';
import { sameEditor, store, type EditorRef } from '../store.ts';
import { blockEditor } from '../editors/block.ts';
import { deviceEditor, onlineEditor } from '../editors/device.ts';
import { tagTableEditor } from '../editors/tagTable.ts';
import type { EditorView } from '../editors/types.ts';
import { watchTableEditor } from '../editors/watchTable.ts';
import * as V from '../versioning.ts';
import { historyEditor } from '../versioning.ts';

const views = new Map<string, EditorView>();
const keyOf = (ref: EditorRef) => JSON.stringify(ref);

function overviewEditor(): EditorView {
  const body = h('div', { style: 'flex:1;overflow:auto' });
  const render = () => {
    clear(body);
    const p = store.project;
    if (!p) return;
    const field = (label: string, value: string, set?: (v: string) => void) => {
      const input = h('input', { value, disabled: !set });
      if (set) input.onchange = () => { set(input.value); store.touch(); };
      return h('div', { className: 'field' }, h('label', null, label), input, h('span'));
    };
    body.append(
      h('div', { className: 'props-form' },
        h('h3', null, `Projet « ${p.name} »`),
        field('Nom', p.name, (v) => { if (v.trim()) p.name = v.trim(); }),
        field('Auteur', p.author ?? '', (v) => { p.author = v; }),
        field('Commentaire', p.comment ?? '', (v) => { p.comment = v; }),
        field('Date de création', new Date(p.created).toLocaleString()),
        field('Dernière modification', new Date(p.modified).toLocaleString()),
        field('Chemin', store.filePath ?? '(non enregistré)'),
        field('Format', store.fileLayout === 'folder' ? 'Dossier (un fichier par objet, versionnable)' : store.fileLayout === 'file' ? 'Fichier unique' : '—'),
        field('Gestion de versions', store.git?.repo ? `Git — branche ${store.git.branch ?? '?'}${store.git.remoteUrl ? ` — ${store.git.remoteUrl}` : ''}` : 'Non activée')),
      h('div', { className: 'panel-subheader' }, t.devicesNetworks),
      h('table', { className: 'grid' },
        h('tr', null, h('th', null, 'Appareil'), h('th', null, "Type d'appareil"), h('th', null, 'Adresse'), h('th', null, 'Blocs'), h('th', null, 'Modules E/S')),
        ...p.devices.map((d) => h('tr', { ondblclick: () => A.openEditor({ kind: 'device', deviceId: d.id }) },
          h('td', null, svg(icons.cpu), ' ', d.name), h('td', null, DEVICE_TYPES[d.type].label), 
          h('td', { className: 'mono' }, `${d.connection.host}:${d.connection.port}`), h('td', null, String(d.blocks.length)), h('td', null, String(d.io.length))))),
    );
  };
  render();
  return { element: h('div', { className: 'editor-host' }, body), icon: 'project', title: () => t.overview, crumbs: () => [store.project?.name ?? '', t.overview], refresh: render };
}

function createView(ref: EditorRef): EditorView | null {
  if (ref.kind === 'overview') return overviewEditor();
  if (ref.kind === 'history') return historyEditor();
  const device = store.device(ref.deviceId);
  if (!device || device.id !== ref.deviceId) return null;
  switch (ref.kind) {
    case 'device': return deviceEditor(device);
    case 'online': return onlineEditor(device);
    case 'tagTable': {
      const table = device.tagTables.find((x) => x.id === ref.tableId);
      return table ? tagTableEditor(device, table) : null;
    }
    case 'allTags': return tagTableEditor(device, null);
    case 'block': {
      const b = device.blocks.find((x) => x.id === ref.blockId);
      return b ? blockEditor(device, b) : null;
    }
    case 'watch': {
      const w = device.watchTables.find((x) => x.id === ref.tableId);
      return w ? watchTableEditor(device, w) : null;
    }
  }
}

export function workarea(): HTMLElement {
  const title = h('div', { className: 'workarea-title' });
  const body = h('div', { className: 'workarea-body' });
  const root = h('div', { className: 'workarea' }, title, body);
  let shown: EditorView | null = null;

  const render = () => {
    // drop views of closed editors
    for (const [k, v] of views) {
      if (!store.editors.some((e) => keyOf(e) === k)) {
        v.destroy?.();
        views.delete(k);
      }
    }
    clear(title);
    const ref = store.active;
    let view: EditorView | null = null;
    if (ref) {
      view = views.get(keyOf(ref)) ?? null;
      if (!view) {
        view = createView(ref);
        if (view) views.set(keyOf(ref), view);
      }
    }
    const online = ref && 'deviceId' in ref && store.onlineOf(ref.deviceId).connected;
    title.classList.toggle('is-online', !!online);
    if (view) {
      const crumbs = [store.project?.name ?? '', ...view.crumbs()];
      crumbs.forEach((c, i) => {
        if (i) title.append(h('span', { className: 'arrow' }, '▸'));
        title.append(h('span', { className: `crumb${i === crumbs.length - 1 ? ' last' : ''}` }, c));
      });
      if (online) title.append(h('span', { style: 'margin-left:auto;font-weight:600;color:#5a3b00' }, `● ${t.online}`));
    }
    const emptyKind = view ? '' : store.project ? `project:${store.project.name}` : 'portal';
    if (shown !== view || (!view && body.dataset.empty !== emptyKind)) {
      if (shown) {
        shown.element.remove();
        if (store.monitoring) shown.monitorStopped?.();
      }
      clear(body);
      body.dataset.empty = emptyKind;
      if (view) {
        body.append(view.element);
        view.shown?.();
      } else if (!store.project) {
        body.append(portalContent());
      } else {
        body.append(h('div', { className: 'empty-state' }, h('div', { className: 'big' }, store.project.name), h('div', null, 'Double-cliquez sur un objet de l\'arborescence du projet pour l\'ouvrir.')));
      }
      shown = view;
    }
    A.setMonitorSource(view?.monitor ?? null);
  };

  store.on((topic) => {
    if (topic === 'editors' || topic === 'online') render();
    if (topic === 'project') {
      for (const [k, v] of views) {
        if (v !== shown) {
          v.destroy?.();
          views.delete(k);
        }
      }
      render();
    }
    if (topic === 'monitor' && !store.monitoring) for (const v of views.values()) v.monitorStopped?.();
  });
  render();
  return root;
}

/** Start page shown when no project is open (portal view). */
function portalContent(): HTMLElement {
  const action = (icon: keyof typeof icons, label: string, run: () => void) =>
    h('button', { className: 'button', style: 'height:36px;justify-content:flex-start;width:280px', onclick: run }, svg(icons[icon]), label);
  return h('div', { className: 'empty-state', style: 'align-items:stretch;justify-content:flex-start;padding:40px 60px;gap:20px' },
    h('div', { style: 'display:flex;align-items:baseline;gap:12px' },
      h('div', { className: 'big', style: 'font-size:28px' }, 'VirtualPLC Studio'),
      h('div', { className: 'muted' }, 'Portail d\'automatisation')),
    h('div', { style: 'display:grid;grid-template-columns:auto 1fr;gap:40px' },
      h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
        h('div', { className: 'panel-subheader', style: 'background:none;padding:0' }, 'Démarrer'),
        action('open', 'Ouvrir le projet existant', A.openProjectCmd),
        action('newFile', 'Créer un projet', A.newProjectCmd),
        action('branch', "Récupérer un projet depuis un dépôt d'équipe", () => void V.cloneCmd())),
      h('div', { style: 'max-width:520px;line-height:1.6;color:var(--muted)' },
        h('div', { className: 'panel-subheader', style: 'background:none;padding:0' }, 'Premiers pas'),
        h('ol', { style: 'padding-left:18px;margin:4px 0' },
          h('li', null, 'Créer un projet et choisir la CPU (Linux / Raspberry Pi, ESP32, Arduino).'),
          h('li', null, 'Configurer les modules d\'E/S dans la configuration des appareils.'),
          h('li', null, 'Déclarer les variables API (%I, %Q, %M) et écrire le programme SCL dans « Main [OB1] ».'),
          h('li', null, 'Compiler, puis « Charger dans l\'appareil ».'),
          h('li', null, 'Passer en ligne et visualiser (lunettes) ou forcer les variables.'),
          h('li', null, "Archiver des versions et synchroniser avec l'équipe (carte des tâches « Versions »).")))));
}

export function editorBar(): HTMLElement {
  const tabs = h('div', { className: 'etabs' });
  const status = h('div', { className: 'status conn' });
  const bar = h('div', { className: 'editorbar' },
    h('div', { className: 'portal', title: t.portalView, onclick: () => { store.active = null; store.emit('editors'); } }, svg(icons.portal), `◂ ${t.portalView}`),
    h('div', { className: 'portal', style: 'color:var(--text);font-weight:400', onclick: () => { if (store.project) A.openEditor({ kind: 'overview' }); } }, svg(icons.project), t.overview),
    tabs, status);
  const render = () => {
    clear(tabs);
    for (const ref of store.editors) {
      if (ref.kind === 'overview') continue;
      const view = views.get(keyOf(ref));
      const label = view?.title() ?? labelOf(ref);
      const active = store.active && sameEditor(store.active, ref);
      tabs.append(h('div', {
        className: `etab${active ? ' active' : ''}`,
        title: label,
        onclick: () => A.openEditor(ref),
        onauxclick: (e: Event) => { if ((e as MouseEvent).button === 1) A.closeEditor(ref); },
      }, svg(icons[view?.icon ?? 'source']), h('span', { className: 'label' }, label),
      h('span', { className: 'x', onclick: (e: Event) => { e.stopPropagation(); A.closeEditor(ref); } }, svg(icons.close))));
    }
    clear(status);
    const online = [...store.online.entries()].filter(([, s]) => s.connected);
    if (online.length) {
      for (const [id, s] of online) status.append(svg(icons.online), `${t.online} : ${store.device(id)?.name ?? ''} via ${s.host ?? ''} — ${s.state ?? ''}`);
    } else {
      status.append(store.project ? `Projet ${store.project.name}${store.dirty ? ' (modifié)' : ''}` : t.noProject);
    }
    const vc = V.statusText();
    if (vc) status.append(h('span', { className: 'vc-status-bar', title: 'Gestion de versions', onclick: () => V.openHistoryCmd() }, svg(icons.branch), vc));
  };
  store.on((topic) => { if (['editors', 'online', 'project', 'git'].includes(topic)) render(); });
  render();
  return bar;
}

function labelOf(ref: EditorRef): string {
  if (ref.kind === 'overview') return t.overview;
  if (ref.kind === 'history') return 'Historique des versions';
  const d = store.device(ref.deviceId);
  switch (ref.kind) {
    case 'block': {
      const b = d?.blocks.find((x) => x.id === ref.blockId);
      return b ? blockLabel(b) : '?';
    }
    case 'tagTable': return d?.tagTables.find((x) => x.id === ref.tableId)?.name ?? '?';
    case 'watch': return d?.watchTables.find((x) => x.id === ref.tableId)?.name ?? '?';
    case 'device': return d?.name ?? '?';
    case 'online': return t.onlineDiag;
    case 'allTags': return t.showAllTags;
  }
}
