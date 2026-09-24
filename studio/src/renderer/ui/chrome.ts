// Menu bar and main toolbar.
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { host } from '../host.ts';
import { icons, type IconName } from '../icons.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import * as V from '../versioning.ts';

interface Item {
  label: string;
  run?: () => void;
  icon?: IconName;
  shortcut?: string;
  enabled?: () => boolean;
  checked?: () => boolean;
}
type Entry = Item | 'sep';

const mod = host.platform === 'darwin' ? '⌘' : 'Ctrl+';
const hasProject = () => store.project !== null;
const isOnline = () => {
  const d = A.currentDevice();
  return !!d && store.onlineOf(d.id).connected;
};

function toggleLayout(key: 'tree' | 'tasks' | 'inspector') {
  store.layout[key] = !store.layout[key];
  store.emit('layout');
}

const MENUS: Array<[string, Entry[]]> = [
  [t.menuProject, [
    { label: t.newProject, icon: 'newFile', run: A.newProjectCmd, shortcut: `${mod}N` },
    { label: t.openProject, icon: 'open', run: A.openProjectCmd, shortcut: `${mod}O` },
    { label: "Récupérer depuis un dépôt d'équipe...", icon: 'branch', run: () => void V.cloneCmd() },
    { label: t.closeProject, run: A.closeProjectCmd, enabled: hasProject, shortcut: `${mod}W` },
    'sep',
    { label: t.saveProject, icon: 'save', run: () => void A.saveProjectCmd(), enabled: hasProject, shortcut: `${mod}S` },
    { label: t.saveAs, run: () => void A.saveProjectCmd(true), enabled: hasProject, shortcut: `${mod}Shift+S` },
    'sep',
    { label: 'Archiver une version...', icon: 'archive', run: () => void V.archiveCmd(), enabled: hasProject },
    { label: "Synchroniser avec l'équipe", icon: 'sync', run: () => void V.syncCmd(), enabled: hasProject },
    { label: 'Historique des versions', icon: 'history', run: V.openHistoryCmd, enabled: hasProject },
    { label: "Dépôt de l'équipe...", run: () => void V.remoteCmd(), enabled: () => hasProject() && V.isRepo() },
    { label: 'Activer la gestion de versions...', run: () => void V.enableVersioningCmd(), enabled: () => hasProject() && !V.isRepo() },
    'sep',
    { label: t.importSource, icon: 'source', run: A.importSourceCmd, enabled: hasProject },
    ...(host.kind === 'electron' ? ['sep' as const, { label: t.exit, run: () => window.close() }] : []),
  ]],
  [t.menuEdit, [
    { label: t.undo, icon: 'undo', run: () => document.execCommand('undo'), shortcut: `${mod}Z` },
    { label: t.redo, icon: 'redo', run: () => document.execCommand('redo'), shortcut: `${mod}Y` },
    'sep',
    { label: t.cut, icon: 'cut', run: () => document.execCommand('cut'), shortcut: `${mod}X` },
    { label: t.copy, icon: 'copy', run: () => document.execCommand('copy'), shortcut: `${mod}C` },
    { label: t.paste, icon: 'paste', run: () => document.execCommand('paste'), shortcut: `${mod}V` },
    'sep',
    { label: t.compile, icon: 'compile', run: () => void A.compileCmd(), enabled: hasProject, shortcut: `${mod}B` },
  ]],
  [t.menuView, [
    { label: t.showTree, run: () => toggleLayout('tree'), checked: () => store.layout.tree, shortcut: `${mod}1` },
    { label: t.showTasks, run: () => toggleLayout('tasks'), checked: () => store.layout.tasks, shortcut: `${mod}3` },
    { label: t.showInspector, run: () => toggleLayout('inspector'), checked: () => store.layout.inspector, shortcut: `${mod}5` },
  ]],
  [t.menuInsert, [
    { label: t.addDevice, icon: 'cpu', run: A.addDeviceCmd, enabled: hasProject },
    { label: t.addBlock, icon: 'add', run: () => void A.addBlockCmd(), enabled: hasProject },
    { label: t.addTagTable, icon: 'tagTable', run: () => void A.addTagTableCmd(), enabled: hasProject },
    { label: t.addWatchTable, icon: 'watch', run: () => void A.addWatchTableCmd(), enabled: hasProject },
  ]],
  [t.menuOnline, [
    { label: t.goOnline, icon: 'online', run: () => void A.goOnlineCmd(), enabled: () => hasProject() && !isOnline(), shortcut: `${mod}K` },
    { label: t.goOffline, icon: 'offline', run: () => void A.goOfflineCmd(), enabled: isOnline, shortcut: `${mod}M` },
    'sep',
    { label: t.downloadToDevice, icon: 'download', run: () => void A.downloadCmd(), enabled: hasProject, shortcut: `${mod}L` },
    'sep',
    { label: t.startCpu, icon: 'run', run: () => void A.startCpuCmd(), enabled: hasProject, shortcut: `${mod}Shift+E` },
    { label: t.stopCpu, icon: 'stop', run: () => void A.stopCpuCmd(), enabled: hasProject, shortcut: `${mod}Shift+Q` },
    'sep',
    { label: t.monitorAll, icon: 'glasses', run: () => void A.toggleMonitorCmd(), enabled: hasProject, checked: () => store.monitoring, shortcut: `${mod}T` },
    { label: t.onlineDiag, icon: 'diag', run: () => { const d = A.currentDevice(); if (d) A.openEditor({ kind: 'online', deviceId: d.id }); }, enabled: hasProject, shortcut: `${mod}D` },
  ]],
  [t.menuOptions, [
    { label: 'Identité pour la gestion de versions...', run: () => void V.identityDialog(store.git?.user).then(() => V.refreshGit()), enabled: V.isRepo },
    { label: t.settings, run: () => void A.aboutCmd() },
  ]],
  [t.menuHelp, [
    { label: t.about, icon: 'info', run: A.aboutCmd },
  ]],
];

let openMenu: HTMLElement | null = null;

function closeMenus(): void {
  openMenu?.classList.remove('open');
  openMenu?.querySelector('.dropdown')?.remove();
  openMenu = null;
}
document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenus();
});

export function dropdown(entries: Entry[], onDone: () => void): HTMLElement {
  const dd = h('div', { className: 'dropdown', role: 'menu' });
  for (const e of entries) {
    if (e === 'sep') {
      dd.append(h('div', { className: 'sep' }));
      continue;
    }
    const enabled = e.enabled ? e.enabled() : true;
    const check = e.checked?.();
    const iconEl = e.icon ? svg(icons[e.icon]) : check ? svg(icons.ok) : h('span', { className: 'icon blank' });
    dd.append(h('div', {
      className: `item${enabled ? '' : ' disabled'}`,
      role: 'menuitem',
      onmousedown: (ev: Event) => ev.preventDefault(),
      onclick: () => {
        if (!enabled) return;
        onDone();
        e.run?.();
      },
    }, iconEl, h('span', null, e.label + (check && e.icon ? '  ✓' : '')), e.shortcut ? h('span', { className: 'shortcut' }, e.shortcut) : null));
  }
  return dd;
}

export function menubar(): HTMLElement {
  const bar = h('div', { className: 'menubar', role: 'menubar' });
  for (const [label, entries] of MENUS) {
    const menu: HTMLElement = h('div', {
      className: 'menu',
      onmousedown: (e: Event) => {
        if ((e.target as HTMLElement).closest('.dropdown')) return;
        if (openMenu === menu) closeMenus();
        else show();
      },
      onmouseenter: () => { if (openMenu && openMenu !== menu) show(); },
    }, label);
    const show = () => {
      closeMenus();
      openMenu = menu;
      menu.classList.add('open');
      menu.append(dropdown(entries, closeMenus));
    };
    bar.append(menu);
  }
  return bar;
}

function tbtn(icon: IconName, title: string, run: () => void, enabled: () => boolean = hasProject, extra = ''): HTMLButtonElement {
  const b = h('button', { className: `tbtn ${extra}`, title, onclick: () => run() }, svg(icons[icon]));
  (b as HTMLButtonElement & { _enabled?: () => boolean })._enabled = enabled;
  return b;
}

export function toolbar(): HTMLElement {
  const bar = h('div', { className: 'toolbar', role: 'toolbar' });
  const onlineBtn = tbtn('online', `${t.goOnline} (${mod}K)`, () => void A.goOnlineCmd(), () => hasProject() && !isOnline(), 'online-btn');
  const offlineBtn = tbtn('offline', `${t.goOffline} (${mod}M)`, () => void A.goOfflineCmd(), isOnline);
  const monitor = tbtn('glasses', `${t.monitorAll} (${mod}T)`, () => void A.toggleMonitorCmd());
  bar.append(
    tbtn('newFile', t.newProject, A.newProjectCmd, () => true),
    tbtn('open', t.openProject, A.openProjectCmd, () => true),
    tbtn('save', `${t.saveProject} (${mod}S)`, () => void A.saveProjectCmd()),
    tbtn('archive', 'Archiver une version', () => void V.archiveCmd()),
    tbtn('sync', "Synchroniser avec l'équipe", () => void V.syncCmd()),
    h('span', { className: 'sep' }),
    tbtn('cut', t.cut, () => document.execCommand('cut'), () => true),
    tbtn('copy', t.copy, () => document.execCommand('copy'), () => true),
    tbtn('paste', t.paste, () => document.execCommand('paste'), () => true),
    tbtn('del', t.delete, () => document.execCommand('delete'), () => true),
    h('span', { className: 'sep' }),
    tbtn('undo', t.undo, () => document.execCommand('undo'), () => true),
    tbtn('redo', t.redo, () => document.execCommand('redo'), () => true),
    h('span', { className: 'sep' }),
    tbtn('compile', `${t.compile} (${mod}B)`, () => void A.compileCmd()),
    tbtn('download', `${t.downloadToDevice} (${mod}L)`, () => void A.downloadCmd()),
    h('span', { className: 'sep' }),
    onlineBtn,
    offlineBtn,
    tbtn('diag', t.onlineDiag, () => { const d = A.currentDevice(); if (d) A.openEditor({ kind: 'online', deviceId: d.id }); }),
    tbtn('run', t.startCpu, () => void A.startCpuCmd()),
    tbtn('stop', t.stopCpu, () => void A.stopCpuCmd()),
    h('span', { className: 'sep' }),
    monitor,
    h('div', { className: 'brand' }, h('b', null, 'VirtualPLC'), h('span', null, 'Studio d\'automatisation')),
  );
  const refresh = () => {
    for (const b of bar.querySelectorAll<HTMLButtonElement & { _enabled?: () => boolean }>('.tbtn')) b.disabled = b._enabled ? !b._enabled() : false;
    onlineBtn.classList.toggle('active', isOnline());
    monitor.classList.toggle('pressed', store.monitoring);
  };
  store.on(refresh);
  refresh();
  return bar;
}

/** Context menu at the mouse position. */
export function contextMenu(ev: MouseEvent, entries: Entry[]): void {
  ev.preventDefault();
  closeMenus();
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const wrap = h('div', { className: 'ctx-menu', style: `left:${ev.clientX}px;top:${ev.clientY}px` });
  const close = () => wrap.remove();
  wrap.append(dropdown(entries, close));
  (wrap.firstChild as HTMLElement).style.position = 'static';
  document.body.append(wrap);
  const r = wrap.getBoundingClientRect();
  if (r.bottom > window.innerHeight) wrap.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  if (r.right > window.innerWidth) wrap.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!wrap.contains(e.target as Node)) {
      close();
      document.removeEventListener('mousedown', off);
    }
  }), 0);
}

export type { Entry as MenuEntry };
export { clear };
