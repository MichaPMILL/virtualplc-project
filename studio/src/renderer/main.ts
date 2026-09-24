// VirtualPLC Studio — renderer entry point.
import * as A from './actions.ts';
import { h } from './dom.ts';
import { host } from './host.ts';
import { store } from './store.ts';
import { menubar, toolbar } from './ui/chrome.ts';
import { inspector, taskCards } from './ui/panels.ts';
import { projectTree } from './ui/projectTree.ts';
import { editorBar, workarea } from './ui/workspace.ts';

function splitter(className: string, cssVar: string, axis: 'x' | 'y', invert = false, min = 150, max = 700): HTMLElement {
  const el = h('div', { className });
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const root = document.documentElement;
    const initial = parseInt(getComputedStyle(root).getPropertyValue(cssVar), 10) || (axis === 'x' ? 290 : 230);
    const move = (ev: MouseEvent) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      root.style.setProperty(cssVar, `${Math.max(min, Math.min(max, initial + (invert ? -delta : delta)))}px`);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return el;
}

function layout(): HTMLElement {
  const tree = projectTree();
  const tasks = taskCards();
  const insp = inspector();
  const center = h('div', { className: 'center' }, workarea(), splitter('hsplitter', '--insp-h', 'y', true, 80, 600), insp);
  const main = h('div', { className: 'main' }, tree, splitter('splitter', '--tree-w', 'x'), center, splitter('splitter', '--tasks-w', 'x', true), tasks);
  const apply = () => {
    main.classList.toggle('no-tree', !store.layout.tree);
    main.classList.toggle('no-tasks', !store.layout.tasks);
    center.classList.toggle('no-inspector', !store.layout.inspector);
    tree.classList.toggle('hidden', !store.layout.tree);
    tasks.classList.toggle('hidden', !store.layout.tasks);
    insp.classList.toggle('hidden', !store.layout.inspector);
  };
  store.on((topic) => { if (topic === 'layout') apply(); });
  apply();
  return h('div', { id: 'app' }, menubar(), toolbar(), main, editorBar());
}

function shortcuts(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  const map: Record<string, () => unknown> = {
    n: A.newProjectCmd, o: A.openProjectCmd, s: () => A.saveProjectCmd(e.shiftKey), w: A.closeProjectCmd,
    b: () => A.compileCmd(), l: () => A.downloadCmd(), k: () => A.goOnlineCmd(), m: () => A.goOfflineCmd(), t: A.toggleMonitorCmd,
    d: () => { const d = A.currentDevice(); if (d) A.openEditor({ kind: 'online', deviceId: d.id }); },
    '1': () => { store.layout.tree = !store.layout.tree; store.emit('layout'); },
    '3': () => { store.layout.tasks = !store.layout.tasks; store.emit('layout'); },
    '5': () => { store.layout.inspector = !store.layout.inspector; store.emit('layout'); },
  };
  if (e.shiftKey && k === 'e') { e.preventDefault(); void A.startCpuCmd(); return; }
  if (e.shiftKey && k === 'q') { e.preventDefault(); void A.stopCpuCmd(); return; }
  const fn = map[k];
  if (fn && !(e.shiftKey && k !== 's')) {
    e.preventDefault();
    void fn();
  }
}

document.body.append(layout());
document.addEventListener('keydown', shortcuts);
host.onMenu((action) => {
  if (action === 'project.saveAndQuit') void A.saveAndQuit();
});
// Files exported by engineering tools can be dropped on the window
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.(scl|db|udt|xlsx|txt)$/i.test(f.name));
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  const device = A.currentDevice();
  if (!device || !files.length) return;
  void Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))).then((list) => A.importFiles(device, list));
});
window.addEventListener('beforeunload', (e) => {
  if (host.kind === 'web' && store.dirty) e.preventDefault();
});
store.emit('project');
