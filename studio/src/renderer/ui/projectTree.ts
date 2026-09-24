// "Arborescence du projet" (project tree) and its details view.
import { blockLabel, DEVICE_TYPES, type Block, type Device } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { icons, type IconName } from '../icons.ts';
import { t } from '../i18n.ts';
import { store, type EditorRef } from '../store.ts';
import { contextMenu, type MenuEntry } from './chrome.ts';
import { inheritanceDialog } from '../editors/method.ts';

const expanded = new Set<string>(['project', 'dev:*', 'blocks:*', 'block:*', 'tags:*', 'watch:*', 'types:*', 'ifcs:*']);
const isExpanded = (key: string) => expanded.has(key) || expanded.has(key.replace(/:.*/, ':*')) && !expanded.has(`!${key}`);
function toggle(key: string) {
  if (isExpanded(key)) {
    expanded.delete(key);
    expanded.add(`!${key}`);
  } else {
    expanded.delete(`!${key}`);
    expanded.add(key);
  }
}

interface NodeSpec {
  key: string;
  label: string;
  icon: IconName;
  depth: number;
  open?: EditorRef;
  children?: () => NodeSpec[];
  onActivate?: () => void;
  menu?: MenuEntry[];
  status?: IconName | null;
  statusTitle?: string;
  className?: string;
  badge?: string;
  select?: { kind: string; id?: string; deviceId?: string };
}

function blockIcon(b: Block): IconName {
  return ({ OB: 'ob', FB: 'fb', FC: 'fc', DB: 'db' } as const)[b.type];
}

function onlineStatus(device: Device): { icon: IconName | null; title?: string } {
  const s = store.onlineOf(device.id);
  if (!s.connected) return { icon: null };
  if (s.state === 'FAULT') return { icon: 'error', title: 'Défaut' };
  const compiled = store.compile.get(device.id)?.programId;
  if (s.programId && compiled && s.programId === compiled) return { icon: 'ok', title: 'Les versions en ligne et hors ligne sont identiques' };
  return { icon: 'differ', title: 'Les versions en ligne et hors ligne sont différentes' };
}

function deviceNodes(d: Device): NodeSpec[] {
  const status = onlineStatus(d);
  const hasErrors = (blockId: string) => store.diagnosticsFor(blockId).some((x) => x.severity === 'error');
  const blocks = [...d.blocks].sort((a, b) => ['OB', 'FB', 'FC', 'DB'].indexOf(a.type) - ['OB', 'FB', 'FC', 'DB'].indexOf(b.type) || a.number - b.number);
  return [
    { key: `cfg:${d.id}`, label: t.deviceConfig, icon: 'device', depth: 2, open: { kind: 'device', deviceId: d.id }, select: { kind: 'device', deviceId: d.id } },
    { key: `diag:${d.id}`, label: t.onlineDiag, icon: 'diag', depth: 2, open: { kind: 'online', deviceId: d.id }, select: { kind: 'online', deviceId: d.id } },
    {
      key: `blocks:${d.id}`, label: t.programBlocks, icon: 'folder', depth: 2, select: { kind: 'blocks', deviceId: d.id },
      menu: [{ label: t.addBlock, icon: 'add', run: () => void A.addBlockCmd(d) }, 'sep', { label: t.compile, icon: 'compile', run: () => void A.compileCmd(d) }],
      children: () => [
        { key: `addblock:${d.id}`, label: t.addBlock, icon: 'add', depth: 3, className: 'add', onActivate: () => void A.addBlockCmd(d) },
        ...blocks.map((b): NodeSpec => ({
          key: `block:${b.id}`, label: blockLabel(b) + (b.extends ? ` ◁ ${b.extends}` : ''), icon: blockIcon(b), depth: 3,
          children: b.type === 'FB' && b.methods?.length ? () => (b.methods ?? []).map((m): NodeSpec => ({
            key: `method:${m.id}`, label: m.name + (m.returnType && !/^void$/i.test(m.returnType) ? ` : ${m.returnType}` : ''), icon: 'method', depth: 4,
            open: { kind: 'method', deviceId: d.id, blockId: b.id, methodId: m.id },
            className: store.diagnosticsFor(b.id).some((x) => x.methodId === m.id && x.severity === 'error') ? 'error' : undefined,
            menu: [
              { label: 'Ouvrir', run: () => A.openEditor({ kind: 'method', deviceId: d.id, blockId: b.id, methodId: m.id }) },
              { label: 'Renommer', run: () => void A.renameMethodCmd(d, b, m.id) },
              { label: t.delete, icon: 'del', run: () => void A.deleteMethodCmd(d, b, m.id) },
            ],
          })) : undefined,
          open: { kind: 'block', deviceId: d.id, blockId: b.id }, select: { kind: 'block', id: b.id, deviceId: d.id },
          className: hasErrors(b.id) ? 'error' : undefined,
          status: status.icon, statusTitle: status.title,
          menu: [
            { label: 'Ouvrir', run: () => A.openEditor({ kind: 'block', deviceId: d.id, blockId: b.id }) },
            'sep',
            { label: 'Renommer', run: () => void A.renameCmd('block', d.id, b.id), shortcut: 'F2' },
            { label: t.delete, icon: 'del', run: () => void A.deleteCmd('block', d.id, b.id), shortcut: 'Suppr' },
            'sep',
            { label: t.compile, icon: 'compile', run: () => void A.compileCmd(d) },
            { label: t.downloadToDevice, icon: 'download', run: () => void A.downloadCmd(d) },
            ...(b.type === 'FB' ? [
              'sep' as const, { label: `Créer un DB d'instance`, icon: 'db' as IconName, run: () => void A.addBlockCmd(d, { type: 'DB', name: `${b.name}_DB`, instanceOf: b.name }) },
              { label: 'Ajouter une méthode', icon: 'method' as IconName, run: () => void A.addMethodCmd(d, b) },
              { label: 'Héritage et interfaces...', icon: 'iface' as IconName, run: () => inheritanceDialog(d, b) },
            ] : []),
          ],
        })),
      ],
    },
    { key: `techno:${d.id}`, label: t.technologyObjects, icon: 'folder', depth: 2, children: () => [] },
    {
      key: `sources:${d.id}`, label: t.externalSources, icon: 'folder', depth: 2,
      menu: [{ label: t.importFiles, icon: 'source', run: () => void A.importSourceCmd(d) }],
      children: () => [{ key: `addsrc:${d.id}`, label: 'Ajouter nouvelle source externe', icon: 'add', depth: 3, className: 'add', onActivate: () => void A.importSourceCmd(d) }],
    },
    {
      key: `tags:${d.id}`, label: t.plcTags, icon: 'folder', depth: 2, select: { kind: 'tags', deviceId: d.id },
      menu: [{ label: t.addTagTable, icon: 'tagTable', run: () => void A.addTagTableCmd(d) }, { label: 'Importer une table de variables (.xlsx)...', icon: 'source', run: () => void A.importSourceCmd(d) }],
      children: () => [
        { key: `alltags:${d.id}`, label: t.showAllTags, icon: 'tags', depth: 3, open: { kind: 'allTags', deviceId: d.id } },
        { key: `addtt:${d.id}`, label: t.addTagTable, icon: 'add', depth: 3, className: 'add', onActivate: () => void A.addTagTableCmd(d) },
        ...d.tagTables.map((tt, i): NodeSpec => ({
          key: `tt:${tt.id}`, label: `${tt.name} [${tt.tags.length}]`, icon: 'tagTable', depth: 3,
          open: { kind: 'tagTable', deviceId: d.id, tableId: tt.id }, select: { kind: 'tagTable', id: tt.id, deviceId: d.id },
          menu: [
            { label: 'Ouvrir', run: () => A.openEditor({ kind: 'tagTable', deviceId: d.id, tableId: tt.id }) },
            { label: 'Renommer', run: () => void A.renameCmd('tagTable', d.id, tt.id), enabled: () => i > 0 },
            { label: t.delete, icon: 'del', run: () => void A.deleteCmd('tagTable', d.id, tt.id), enabled: () => i > 0 },
          ],
        })),
      ],
    },
    {
      key: `types:${d.id}`, label: t.dataTypes, icon: 'folder', depth: 2,
      menu: [{ label: 'Ajouter nouveau type de données', icon: 'dataType', run: () => void A.addDataTypeCmd(d) }, { label: t.importFiles, icon: 'source', run: () => void A.importSourceCmd(d) }],
      children: () => [
        { key: `addudt:${d.id}`, label: 'Ajouter nouveau type de données', icon: 'add', depth: 3, className: 'add', onActivate: () => void A.addDataTypeCmd(d) },
        ...[...d.types].sort((a, b) => a.name.localeCompare(b.name)).map((ut): NodeSpec => ({
          key: `udt:${ut.id}`, label: ut.name, icon: 'dataType', depth: 3,
          open: { kind: 'dataType', deviceId: d.id, typeId: ut.id }, select: { kind: 'dataType', id: ut.id, deviceId: d.id },
          className: store.compile.get(d.id)?.diagnostics.some((x) => x.typeId === ut.id && x.severity === 'error') ? 'error' : undefined,
          menu: [
            { label: 'Ouvrir', run: () => A.openEditor({ kind: 'dataType', deviceId: d.id, typeId: ut.id }) },
            { label: 'Renommer', run: () => void A.renameCmd('dataType', d.id, ut.id) },
            { label: t.delete, icon: 'del', run: () => void A.deleteCmd('dataType', d.id, ut.id) },
          ],
        })),
      ],
    },
    {
      key: `trace:${d.id}`, label: `Traçabilité (journaux SQL)${d.dataLogs?.length ? ` [${d.dataLogs.length}]` : ''}`, icon: 'trace', depth: 2,
      open: { kind: 'datalogs', deviceId: d.id },
      className: store.compile.get(d.id)?.diagnostics.some((x) => x.location === 'datalog' && x.severity === 'error') ? 'error' : undefined,
    },
    {
      key: `ifcs:${d.id}`, label: 'Interfaces', icon: 'folder', depth: 2,
      menu: [{ label: 'Ajouter nouvelle interface', icon: 'iface', run: () => void A.addInterfaceCmd(d) }],
      children: () => [
        { key: `addifc:${d.id}`, label: 'Ajouter nouvelle interface', icon: 'add', depth: 3, className: 'add', onActivate: () => void A.addInterfaceCmd(d) },
        ...[...(d.interfaces ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((i): NodeSpec => ({
          key: `ifc:${i.id}`, label: i.name, icon: 'iface', depth: 3,
          open: { kind: 'interface', deviceId: d.id, interfaceId: i.id },
          className: store.compile.get(d.id)?.diagnostics.some((x) => x.interfaceId === i.id && x.severity === 'error') ? 'error' : undefined,
          menu: [
            { label: 'Ouvrir', run: () => A.openEditor({ kind: 'interface', deviceId: d.id, interfaceId: i.id }) },
            { label: 'Renommer', run: () => void A.renameCmd('interface', d.id, i.id) },
            { label: t.delete, icon: 'del', run: () => void A.deleteCmd('interface', d.id, i.id) },
          ],
        })),
      ],
    },
    {
      key: `watch:${d.id}`, label: t.watchTables, icon: 'folder', depth: 2,
      menu: [{ label: t.addWatchTable, icon: 'watch', run: () => void A.addWatchTableCmd(d) }],
      children: () => [
        { key: `addwt:${d.id}`, label: t.addWatchTable, icon: 'add', depth: 3, className: 'add', onActivate: () => void A.addWatchTableCmd(d) },
        ...d.watchTables.map((w): NodeSpec => ({
          key: `wt:${w.id}`, label: w.name, icon: 'watch', depth: 3, open: { kind: 'watch', deviceId: d.id, tableId: w.id },
          menu: [
            { label: 'Ouvrir', run: () => A.openEditor({ kind: 'watch', deviceId: d.id, tableId: w.id }) },
            { label: 'Renommer', run: () => void A.renameCmd('watch', d.id, w.id) },
            { label: t.delete, icon: 'del', run: () => void A.deleteCmd('watch', d.id, w.id) },
          ],
        })),
      ],
    },
    { key: `backups:${d.id}`, label: t.onlineBackups, icon: 'folder', depth: 2, children: () => [] },
  ];
}

function projectNodes(): NodeSpec[] {
  const p = store.project;
  if (!p) return [];
  return [{
    key: 'project', label: p.name, icon: 'project', depth: 0, select: { kind: 'project' },
    menu: [{ label: t.addDevice, icon: 'cpu', run: () => void A.addDeviceCmd() }, { label: t.saveProject, icon: 'save', run: () => void A.saveProjectCmd() }],
    children: () => [
      { key: 'adddev', label: t.addDevice, icon: 'add', depth: 1, className: 'add', onActivate: () => void A.addDeviceCmd() },
      { key: 'devnet', label: t.devicesNetworks, icon: 'network', depth: 1, open: { kind: 'network' } },
      ...p.devices.map((d): NodeSpec => {
        const s = store.onlineOf(d.id);
        const stateIcon: IconName | null = s.connected ? (s.state === 'RUN' ? 'run' : s.state === 'FAULT' ? 'error' : 'stop') : null;
        return {
          key: `dev:${d.id}`, label: `${d.name} [${DEVICE_TYPES[d.type].label}]`, icon: 'cpu', depth: 1,
          select: { kind: 'device', deviceId: d.id }, status: stateIcon, statusTitle: s.state,
          menu: [
            { label: t.goOnline, icon: 'online', run: () => void A.goOnlineCmd(d), enabled: () => !store.onlineOf(d.id).connected },
            { label: t.goOffline, icon: 'offline', run: () => void A.goOfflineCmd(d), enabled: () => store.onlineOf(d.id).connected },
            { label: t.downloadToDevice, icon: 'download', run: () => void A.downloadCmd(d) },
            'sep',
            { label: t.compile, icon: 'compile', run: () => void A.compileCmd(d) },
            'sep',
            { label: 'Renommer', run: () => void A.renameCmd('device', d.id, d.id) },
            { label: t.delete, icon: 'del', run: () => void A.deleteCmd('device', d.id, d.id), enabled: () => p.devices.length > 1 },
          ],
          children: () => deviceNodes(d),
        };
      }),
      { key: 'history', label: 'Historique des versions', icon: 'history', depth: 1, open: { kind: 'history' } },
      { key: 'branches', label: store.git?.branch ? `Branches [${store.git.branch}]` : 'Branches', icon: 'branch', depth: 1, open: { kind: 'branches' } },
    ],
  }];
}

export function projectTree(): HTMLElement {
  const body = h('div', { className: 'panel-body tree', tabindex: '0', role: 'tree' });
  const detailsBody = h('div', { className: 'panel-body' });
  const panel = h('div', { className: 'panel project-tree' },
    h('div', { className: 'panel-header onlineable' }, t.projectTree,
      h('span', { className: 'spacer' }),
      h('button', { className: 'tbtn', title: 'Réduire', onclick: () => { store.layout.tree = false; store.emit('layout'); } }, '◂')),
    h('div', { className: 'panel-subheader' }, t.devices),
    body,
    h('div', { className: 'details' }, h('div', { className: 'panel-header' }, t.detailsView), detailsBody),
  );

  const render = () => {
    const scroll = body.scrollTop;
    clear(body);
    if (!store.project) {
      body.append(h('div', { className: 'muted', style: 'padding:10px' }, t.noProject));
    }
    const walk = (nodes: NodeSpec[]) => {
      for (const n of nodes) {
        const hasChildren = !!n.children;
        const open = hasChildren && isExpanded(n.key);
        const selected = store.selection && n.select && JSON.stringify(store.selection) === JSON.stringify(n.select);
        const el = h('div', {
          className: `node${selected ? ' selected' : ''}${n.className ? ` ${n.className}` : ''}`,
          style: `padding-left:${n.depth * 16 + 2}px`,
          role: 'treeitem',
          'aria-expanded': hasChildren ? String(open) : undefined,
          onclick: (e: Event) => {
            if ((e.target as HTMLElement).closest('.twisty') && hasChildren) {
              toggle(n.key);
              render();
              return;
            }
            if (n.select) {
              store.selection = n.select;
              render();
              renderDetails();
            }
            if (n.onActivate && !n.open) n.onActivate();
          },
          ondblclick: () => {
            if (n.open) A.openEditor(n.open);
            else if (hasChildren) {
              toggle(n.key);
              render();
            }
          },
          oncontextmenu: (e: Event) => { if (n.menu) contextMenu(e as MouseEvent, n.menu); },
        },
        h('span', { className: 'twisty' }, hasChildren ? svg(open ? icons.collapse : icons.expand) : ''),
        svg(icons[open && n.icon === 'folder' ? 'folderOpen' : n.icon]),
        h('span', { className: 'label' }, n.label),
        n.status ? h('span', { className: 'status', title: n.statusTitle ?? '' }, svg(icons[n.status])) : null);
        body.append(el);
        if (open) walk(n.children!());
      }
    };
    walk(projectNodes());
    body.scrollTop = scroll;
  };

  const renderDetails = () => {
    clear(detailsBody);
    const sel = store.selection;
    const d = store.device(sel?.deviceId);
    if (!sel || !d) return;
    const table = h('table', { className: 'grid' });
    if (sel.kind === 'blocks' || sel.kind === 'device') {
      table.append(h('tr', null, h('th', null, t.name), h('th', { style: 'width:70px' }, t.number), h('th', { style: 'width:60px' }, t.type)));
      for (const b of d.blocks) table.append(h('tr', { ondblclick: () => A.openEditor({ kind: 'block', deviceId: d.id, blockId: b.id }) }, h('td', null, svg(icons[blockIcon(b)]), ' ', b.name), h('td', null, String(b.number)), h('td', null, b.type)));
    } else if (sel.kind === 'block') {
      const b = d.blocks.find((x) => x.id === sel.id);
      table.append(h('tr', null, h('th', null, t.name), h('th', null, t.dataType), h('th', null, 'Section')));
      for (const [sec, members] of Object.entries(b?.interface ?? {})) {
        for (const m of members as Array<{ name: string; dataType: string }>) table.append(h('tr', null, h('td', null, m.name), h('td', null, m.dataType), h('td', null, sec)));
      }
      for (const m of b?.members ?? []) table.append(h('tr', null, h('td', null, m.name), h('td', null, m.dataType), h('td', null, 'Static')));
    } else if (sel.kind === 'tagTable' || sel.kind === 'tags') {
      const tables = sel.kind === 'tags' ? d.tagTables : d.tagTables.filter((x) => x.id === sel.id);
      table.append(h('tr', null, h('th', null, t.name), h('th', null, t.dataType), h('th', null, t.address)));
      for (const tt of tables) for (const tag of tt.tags) table.append(h('tr', null, h('td', null, tag.name), h('td', null, tag.dataType), h('td', { className: 'mono' }, tag.address)));
    }
    detailsBody.append(table);
  };

  body.addEventListener('keydown', (e) => {
    const sel = store.selection;
    if (!sel?.deviceId || sel.kind !== 'block' || !sel.id) return;
    if (e.key === 'F2') void A.renameCmd('block', sel.deviceId, sel.id);
    if (e.key === 'Delete') void A.deleteCmd('block', sel.deviceId, sel.id);
    if (e.key === 'Enter') A.openEditor({ kind: 'block', deviceId: sel.deviceId, blockId: sel.id });
  });

  store.on((topic) => {
    if (['project', 'online', 'compile', 'selection', 'git'].includes(topic)) {
      render();
      if (topic !== 'online') renderDetails();
    }
  });
  render();
  return panel;
}
