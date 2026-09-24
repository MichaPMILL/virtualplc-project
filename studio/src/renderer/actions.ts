// Commands of the Studio (menus, toolbar, shortcuts, tree context menus).
import {
  blockLabel, DEVICE_TYPES, emptyInterface, importExternalSource, loadProject, newDevice, newId, newProject, saveProject,
  type Block, type Device,
} from '../../../sdk/src/browser.ts';
import type { CompileSummary, MonitorValue } from '../backend/backend.ts';
import { call, host } from './host.ts';
import { refreshGit } from './versioning.ts';
import { t } from './i18n.ts';
import { sameEditor, store, type EditorRef } from './store.ts';
import {
  addBlockDialog, addDeviceDialog, alertDialog, confirmDialog, connectionDialog, loadPreviewDialog, progressDialog, promptDialog,
} from './ui/dialogs.ts';

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

export function openEditor(ref: EditorRef): void {
  const existing = store.editors.find((e) => sameEditor(e, ref));
  if (!existing) store.editors.push(ref);
  store.active = existing ?? ref;
  store.emit('editors');
}

export function closeEditor(ref: EditorRef): void {
  const i = store.editors.findIndex((e) => sameEditor(e, ref));
  if (i < 0) return;
  store.editors.splice(i, 1);
  if (store.active && sameEditor(store.active, ref)) store.active = store.editors[Math.min(i, store.editors.length - 1)] ?? null;
  store.emit('editors');
}

/** Closes editors whose object no longer exists. */
export function pruneEditors(): void {
  store.editors = store.editors.filter((e) => {
    if (e.kind === 'overview' || e.kind === 'history') return true;
    const d = store.project?.devices.find((x) => x.id === e.deviceId);
    if (!d) return false;
    if (e.kind === 'block') return d.blocks.some((b) => b.id === e.blockId);
    if (e.kind === 'tagTable') return d.tagTables.some((b) => b.id === e.tableId);
    if (e.kind === 'watch') return d.watchTables.some((b) => b.id === e.tableId);
    return true;
  });
  if (store.active && !store.editors.some((e) => sameEditor(e, store.active!))) store.active = store.editors[0] ?? null;
  store.emit('editors');
}

export function goto(ref: EditorRef & { line?: number }): void {
  openEditor(ref.kind === 'block' ? { kind: 'block', deviceId: ref.deviceId, blockId: ref.blockId } : ref);
  if (ref.kind === 'block' && ref.line) {
    // The block editor listens to this event to move its cursor
    window.dispatchEvent(new CustomEvent('studio:goto-line', { detail: { blockId: ref.blockId, line: ref.line } }));
  }
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

function updateTitle(): void {
  const name = store.project ? `${store.project.name}${store.dirty ? ' *' : ''}` : '';
  host.setTitle(name ? `${t.appName} - ${store.filePath ?? name}` : t.appName);
  host.setDirty(store.dirty);
}
store.on((topic) => {
  if (topic === 'project') updateTitle();
});

async function confirmDiscard(): Promise<boolean> {
  if (!store.project || !store.dirty) return true;
  return confirmDialog(t.appName, `Le projet « ${store.project.name} » a été modifié.\nVoulez-vous abandonner les modifications ?`, 'Abandonner', t.cancel);
}

function setProject(p: Parameters<typeof saveProject>[0] | null, path: string | null, where: { layout?: 'folder' | 'file' | null; dir?: string | null } = {}): void {
  for (const id of store.online.keys()) void call('disconnect', id).catch(() => undefined);
  store.online.clear();
  store.compile.clear();
  store.monitoring = false;
  store.project = p;
  store.filePath = path;
  store.fileLayout = where.layout ?? null;
  store.projectDir = where.dir ?? null;
  store.git = null;
  store.dirty = false;
  store.editors = p ? [{ kind: 'overview' }] : [];
  store.active = store.editors[0] ?? null;
  store.selection = null;
  store.messages = [];
  document.body.classList.remove('online');
  store.emit('project');
  store.emit('editors');
  store.emit('online');
  store.emit('messages');
  updateTitle();
  if (p) store.addMessage({ severity: 'info', text: `Le projet ${p.name} a été ouvert.` });
  store.emit('git');
  void refreshGit();
}

/** Opens a project from a path on this computer (manifest, single file or folder). */
export async function openProjectPath(path: string): Promise<void> {
  try {
    const r = await call('projectOpen', path);
    const p = loadProject(r.json);
    const legacy = !r.json.includes('"virtualplc-project"');
    if (legacy) p.name = r.path.split(/[/\\]/).pop()!.replace(/\.[^.]+$/, '');
    setProject(p, legacy ? null : r.path, legacy ? {} : { layout: r.layout, dir: r.dir });
    if (legacy) {
      store.dirty = true;
      updateTitle();
      store.addMessage({ severity: 'warning', text: `Projet VirtualPLC 1.x converti : vérifiez les adresses des modules d'E/S dans la configuration des appareils, puis enregistrez le projet.` });
    }
  } catch (e) {
    await alertDialog(t.appName, (e as Error).message, 'error');
  }
}

export async function newProjectCmd(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const name = await promptDialog('Créer un projet', 'Nom du projet', 'Projet1');
  if (!name) return;
  const dev = await addDeviceDialog('PLC_1');
  if (!dev) return;
  const p = newProject(name, dev.type);
  p.devices[0].name = dev.name;
  setProject(p, null);
  store.dirty = true;
  openEditor({ kind: 'device', deviceId: p.devices[0].id });
  updateTitle();
}

export async function openProjectCmd(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const path = await host.pickPath('openProject');
  if (path) await openProjectPath(path);
}

/**
 * Saves the project. New projects (and "Enregistrer sous") use the folder layout: one file
 * per block and table, which Git can compare and merge.
 */
export async function saveProjectCmd(saveAs = false): Promise<boolean> {
  if (!store.project) return false;
  store.project.modified = new Date().toISOString();
  const json = JSON.stringify(store.project);
  try {
    let r;
    if (!saveAs && store.filePath && store.fileLayout) {
      r = await call('projectSave', store.filePath, json, store.fileLayout);
    } else {
      const chosen = await host.pickPath('saveProject', `${store.project.name}.vplcproj`);
      if (!chosen) return false;
      r = await call('projectSaveAs', chosen, json, store.project.name);
    }
    store.filePath = r.path;
    store.fileLayout = r.layout;
    store.projectDir = r.dir;
  } catch (e) {
    await alertDialog(t.saveProject, (e as Error).message, 'error');
    return false;
  }
  store.dirty = false;
  store.emit('project');
  store.addMessage({ severity: 'ok', text: `Le projet ${store.project.name} a été enregistré.` });
  void refreshGit();
  return true;
}

export async function closeProjectCmd(): Promise<void> {
  if (!(await confirmDiscard())) return;
  setProject(null, null);
}

export async function saveAndQuit(): Promise<void> {
  if (await saveProjectCmd()) host.quit();
}

export async function importSourceCmd(): Promise<void> {
  const device = currentDevice();
  if (!device) return;
  const file = await host.openFile('scl');
  if (!file) return;
  try {
    const { blocks, tags } = importExternalSource(device, file.text, file.name);
    let replaced = 0;
    for (const b of blocks) {
      const existing = device.blocks.findIndex((x) => x.name.toLowerCase() === b.name.toLowerCase());
      if (existing >= 0) {
        b.id = device.blocks[existing].id;
        b.number = device.blocks[existing].number;
        device.blocks[existing] = b;
        replaced++;
      } else {
        device.blocks.push(b);
      }
    }
    const table = device.tagTables[0];
    for (const tag of tags) {
      if (!table.tags.some((x) => x.name.toLowerCase() === tag.name.toLowerCase())) table.tags.push(tag);
    }
    store.touch();
    pruneEditors();
    store.addMessage({ severity: 'ok', text: `Source externe « ${file.name} » : ${blocks.length} bloc(s) générés (${replaced} remplacés), ${tags.length} variable(s).` });
  } catch (e) {
    store.addMessage({ severity: 'error', text: `Source externe « ${file.name} » : ${(e as Error).message}`, path: file.name });
    await alertDialog(t.importSource, (e as Error).message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export function currentDevice(): Device | undefined {
  const a = store.active;
  const id = a && 'deviceId' in a ? a.deviceId : store.selection?.deviceId;
  return store.device(id);
}

export async function addDeviceCmd(): Promise<void> {
  if (!store.project) return;
  let n = store.project.devices.length + 1;
  while (store.project.devices.some((d) => d.name === `PLC_${n}`)) n++;
  const spec = await addDeviceDialog(`PLC_${n}`);
  if (!spec) return;
  const dev = newDevice(spec.type, spec.name);
  store.project.devices.push(dev);
  store.touch();
  openEditor({ kind: 'device', deviceId: dev.id });
}

export async function addBlockCmd(device = currentDevice(), preset?: Parameters<typeof addBlockDialog>[1]): Promise<void> {
  if (!device) return;
  const spec = await addBlockDialog(device, preset);
  if (!spec) return;
  if (device.blocks.some((b) => b.name.toLowerCase() === spec.name.toLowerCase())) {
    await alertDialog(t.addBlock, `Le nom « ${spec.name} » est déjà utilisé.`, 'error');
    return;
  }
  if (device.blocks.some((b) => b.type === spec.type && b.number === spec.number)) {
    await alertDialog(t.addBlock, `Le numéro ${spec.type}${spec.number} est déjà utilisé.`, 'error');
    return;
  }
  const block: Block = {
    id: newId('blk'), name: spec.name, type: spec.type, number: spec.number, interface: emptyInterface(), code: '',
    event: spec.type === 'OB' ? spec.event ?? 'ProgramCycle' : undefined,
    returnType: spec.type === 'FC' ? spec.returnType ?? 'Void' : undefined,
    instanceOf: spec.type === 'DB' ? spec.instanceOf : undefined,
    members: spec.type === 'DB' && !spec.instanceOf ? [] : undefined,
  };
  device.blocks.push(block);
  store.touch();
  openEditor({ kind: 'block', deviceId: device.id, blockId: block.id });
}

export async function addTagTableCmd(device = currentDevice()): Promise<void> {
  if (!device) return;
  let n = device.tagTables.length;
  while (device.tagTables.some((x) => x.name === `Table de variables_${n}`)) n++;
  const table = { id: newId('tt'), name: `Table de variables_${n}`, tags: [], constants: [] };
  device.tagTables.push(table);
  store.touch();
  openEditor({ kind: 'tagTable', deviceId: device.id, tableId: table.id });
}

export async function addWatchTableCmd(device = currentDevice()): Promise<void> {
  if (!device) return;
  let n = device.watchTables.length + 1;
  while (device.watchTables.some((x) => x.name === `Table de visualisation_${n}`)) n++;
  const table = { id: newId('wt'), name: `Table de visualisation_${n}`, rows: [] };
  device.watchTables.push(table);
  store.touch();
  openEditor({ kind: 'watch', deviceId: device.id, tableId: table.id });
}

export async function renameCmd(kind: 'block' | 'tagTable' | 'watch' | 'device', deviceId: string, id: string): Promise<void> {
  const d = store.device(deviceId);
  if (!d) return;
  const obj = kind === 'block' ? d.blocks.find((b) => b.id === id)
    : kind === 'tagTable' ? d.tagTables.find((b) => b.id === id)
      : kind === 'watch' ? d.watchTables.find((b) => b.id === id) : d;
  if (!obj) return;
  const name = await promptDialog('Renommer', t.name, obj.name);
  if (!name || name === obj.name) return;
  if (kind === 'block') {
    if (d.blocks.some((b) => b.id !== id && b.name.toLowerCase() === name.toLowerCase())) {
      await alertDialog('Renommer', `Le nom « ${name} » est déjà utilisé.`, 'error');
      return;
    }
    // Keep instance DBs pointing to a renamed FB
    const old = obj.name;
    for (const b of d.blocks) if (b.instanceOf === old) b.instanceOf = name;
  }
  obj.name = name;
  store.touch();
  store.emit('editors');
}

export async function deleteCmd(kind: 'block' | 'tagTable' | 'watch' | 'device', deviceId: string, id: string): Promise<void> {
  const d = store.device(deviceId);
  if (!d || !store.project) return;
  const label = kind === 'block' ? blockLabel(d.blocks.find((b) => b.id === id)!) : kind === 'device' ? d.name
    : (kind === 'tagTable' ? d.tagTables : d.watchTables).find((x) => x.id === id)?.name;
  if (!(await confirmDialog('Supprimer', `Voulez-vous vraiment supprimer « ${label} » ?`))) return;
  if (kind === 'block') d.blocks = d.blocks.filter((b) => b.id !== id);
  else if (kind === 'tagTable') {
    if (d.tagTables.length <= 1) {
      await alertDialog('Supprimer', 'La table de variables standard ne peut pas être supprimée.', 'error');
      return;
    }
    d.tagTables = d.tagTables.filter((b) => b.id !== id);
  } else if (kind === 'watch') d.watchTables = d.watchTables.filter((b) => b.id !== id);
  else store.project.devices = store.project.devices.filter((x) => x.id !== id);
  store.touch();
  pruneEditors();
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

function blockPath(device: Device, blockId?: string): string {
  const b = device.blocks.find((x) => x.id === blockId);
  return b ? `${device.name} > ${t.programBlocks} > ${blockLabel(b)}` : device.name;
}

export async function compileCmd(device = currentDevice(), quiet = false): Promise<CompileSummary | null> {
  if (!store.project || !device) return null;
  let r: CompileSummary;
  try {
    r = await call('compile', saveProject({ ...store.project, modified: store.project.modified }), device.id);
  } catch (e) {
    store.addMessage({ severity: 'error', text: `Compilation impossible : ${(e as Error).message}` });
    return null;
  }
  store.compile.set(device.id, r);
  const errors = r.diagnostics.filter((x) => x.severity === 'error');
  const warnings = r.diagnostics.filter((x) => x.severity === 'warning');
  store.messages = store.messages.filter((m) => !m.path?.startsWith(device.name));
  for (const d of r.diagnostics) {
    const tagTable = device.tagTables.find((x) => x.id === d.tagTableId);
    const path = tagTable ? `${device.name} > ${t.plcTags} > ${tagTable.name}` : blockPath(device, d.blockId);
    const where = d.location === 'interface' ? ' (interface)' : d.codeLine ? ` (ligne ${d.codeLine})` : '';
    store.messages.push({
      severity: d.severity, text: `${d.message}${where}`, path, time: new Date().toLocaleTimeString(),
      goto: d.blockId ? { kind: 'block', deviceId: device.id, blockId: d.blockId, line: d.codeLine }
        : tagTable ? { kind: 'tagTable', deviceId: device.id, tableId: tagTable.id } : undefined,
    });
  }
  store.messages.push({
    severity: errors.length ? 'error' : warnings.length ? 'warning' : 'ok',
    text: errors.length
      ? `Compilation terminée (erreurs : ${errors.length} ; avertissements : ${warnings.length})`
      : `Compilation terminée (erreurs : 0 ; avertissements : ${warnings.length}) — code ${r.stats.code} octets, données ${r.stats.data} octets, %I ${r.stats.inputs} o, %Q ${r.stats.outputs} o, %M ${r.stats.memory} o`,
    path: device.name,
    time: new Date().toLocaleTimeString(),
  });
  store.emit('messages');
  store.emit('compile');
  if (!quiet) window.dispatchEvent(new CustomEvent('studio:show-info', { detail: 'compile' }));
  return r;
}

// ---------------------------------------------------------------------------
// Online
// ---------------------------------------------------------------------------

const passwords = new Map<string, string>();
let pollTimer: number | undefined;
let monitorTimer: number | undefined;

async function ensureConnected(device: Device, title: string, action: string, forceDialog = false): Promise<boolean> {
  if (store.onlineOf(device.id).connected) return true;
  const known = !forceDialog && device.connection.host && passwords.has(device.id);
  let spec = known ? { host: device.connection.host, port: device.connection.port, password: passwords.get(device.id) ?? '' } : null;
  for (;;) {
    if (!spec) spec = await connectionDialog(device, title, action);
    if (!spec) return false;
    try {
      const info = await call('connect', device.id, spec.host, spec.port, spec.password || undefined);
      if (device.connection.host !== spec.host || device.connection.port !== spec.port) {
        device.connection = { host: spec.host, port: spec.port };
        store.touch();
      }
      passwords.set(device.id, spec.password);
      const s = store.onlineOf(device.id);
      s.host = `${spec.host}:${spec.port}`;
      store.addMessage({ severity: 'info', text: `Connecté à ${info.name} (${info.device}, firmware ${info.firmware}) via ${spec.host}.`, path: device.name });
      return true;
    } catch (e) {
      const retry = await confirmDialog(title, `La liaison avec ${spec.host}:${spec.port} n'a pas pu être établie.\n\n${(e as Error).message}\n\nRéessayer avec d'autres paramètres ?`, 'Réessayer', t.cancel);
      if (!retry) return false;
      spec = null;
    }
  }
}

export async function goOnlineCmd(device = currentDevice()): Promise<void> {
  if (!device) return;
  if (!(await ensureConnected(device, t.goOnline, t.connect, !passwords.has(device.id)))) return;
  const s = store.onlineOf(device.id);
  s.connected = true;
  document.body.classList.add('online');
  await refreshOnline(device.id);
  startPolling();
  store.emit('online');
}

export async function goOfflineCmd(device = currentDevice()): Promise<void> {
  if (!device) return;
  await call('disconnect', device.id).catch(() => undefined);
  const s = store.onlineOf(device.id);
  s.connected = false;
  store.monitoring = false;
  if (!store.anyOnline) document.body.classList.remove('online');
  store.addMessage({ severity: 'info', text: `Liaison en ligne avec ${device.name} coupée.`, path: device.name });
  store.emit('online');
  store.emit('monitor');
}

async function refreshOnline(deviceId: string): Promise<void> {
  const s = store.onlineOf(deviceId);
  if (!s.connected) return;
  try {
    const st = await call('state', deviceId);
    const prevState = s.state;
    Object.assign(s, {
      state: st.state, programId: st.programId, offlineProgramId: st.offlineProgramId, scanUs: st.scanUs, maxScanUs: st.maxScanUs,
      cycleMs: st.cycleMs, forces: st.forces, fault: st.fault, io: st.io,
    });
    const last = s.logs[s.logs.length - 1]?.seq ?? 0;
    if (st.logSeq > last) {
      const logs = await call('logs', deviceId, last + 1);
      s.logs.push(...logs);
      if (s.logs.length > 1000) s.logs.splice(0, s.logs.length - 1000);
    }
    if (prevState && prevState !== st.state && st.state === 'FAULT') {
      store.addMessage({ severity: 'error', text: `La CPU est passée en défaut (${st.fault?.code ?? '?'}).`, path: store.device(deviceId)?.name });
    }
    store.emit('online');
  } catch (e) {
    s.connected = false;
    if (!store.anyOnline) document.body.classList.remove('online');
    store.monitoring = false;
    store.addMessage({ severity: 'error', text: `Liaison en ligne interrompue : ${(e as Error).message}`, path: store.device(deviceId)?.name });
    store.emit('online');
    store.emit('monitor');
  }
}

function startPolling(): void {
  if (pollTimer !== undefined) return;
  pollTimer = window.setInterval(() => {
    const ids = [...store.online.entries()].filter(([, s]) => s.connected).map(([id]) => id);
    if (ids.length === 0) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
      return;
    }
    for (const id of ids) void refreshOnline(id);
  }, 1000);
}

export async function downloadCmd(device = currentDevice()): Promise<void> {
  if (!device) return;
  // Always compile before loading
  const compiled = await compileCmd(device, true);
  if (!compiled) return;
  if (!compiled.ok) {
    window.dispatchEvent(new CustomEvent('studio:show-info', { detail: 'compile' }));
    await alertDialog(t.downloadToDevice, 'Le chargement a été annulé : le programme contient des erreurs de compilation.', 'error');
    return;
  }
  const wasOnline = store.onlineOf(device.id).connected;
  if (!(await ensureConnected(device, t.extendedDownload, t.load))) return;
  try {
    const st = await call('state', device.id);
    const preview = await loadPreviewDialog(device, {
      cpuState: st.state,
      willStop: st.state === 'RUN',
      differs: st.programId !== compiled.programId,
      stats: `${compiled.stats.code + compiled.stats.data} octets`,
    });
    if (!preview) return;
    const p = progressDialog(t.downloadToDevice, 'Chargement dans l\'appareil...');
    p.set(0.2);
    try {
      await call('download', device.id, preview.startAfter);
      p.set(1, 'Chargement terminé.');
    } finally {
      setTimeout(() => p.close(), 300);
    }
    store.addMessage({
      severity: 'ok',
      text: `Chargement terminé (erreurs : 0 ; avertissements : 0). ${preview.startAfter ? 'La CPU a été démarrée.' : 'La CPU est à l\'état STOP.'}`,
      path: device.name,
    });
  } catch (e) {
    store.addMessage({ severity: 'error', text: `Chargement : ${(e as Error).message}`, path: device.name });
    await alertDialog(t.downloadToDevice, (e as Error).message, 'error');
  } finally {
    if (!wasOnline) await call('disconnect', device.id).catch(() => undefined);
    else await refreshOnline(device.id);
  }
}

async function cpuControl(device: Device | undefined, what: 'start' | 'stop'): Promise<void> {
  if (!device) return;
  const wasOnline = store.onlineOf(device.id).connected;
  if (!(await ensureConnected(device, what === 'start' ? t.startCpu : t.stopCpu, t.connect))) return;
  try {
    if (what === 'stop') {
      if (!(await confirmDialog(t.stopCpu, `Voulez-vous vraiment mettre la CPU ${device.name} à l'état STOP ?\nToutes les sorties seront désactivées.`, t.ok, t.cancel))) return;
      await call('stop', device.id);
    } else {
      await call('start', device.id, false);
    }
    store.addMessage({ severity: 'info', text: `CPU ${device.name} : ${what === 'start' ? 'RUN' : 'STOP'}.`, path: device.name });
  } catch (e) {
    await alertDialog(what === 'start' ? t.startCpu : t.stopCpu, (e as Error).message, 'error');
  } finally {
    if (!wasOnline) await call('disconnect', device.id).catch(() => undefined);
    else await refreshOnline(device.id);
  }
}

export const startCpuCmd = (d = currentDevice()) => cpuControl(d, 'start');
export const stopCpuCmd = (d = currentDevice()) => cpuControl(d, 'stop');

export async function coldRestartCmd(device = currentDevice()): Promise<void> {
  if (!device || !store.onlineOf(device.id).connected) return;
  if (!(await confirmDialog('Démarrage à froid', 'Les données seront réinitialisées à leurs valeurs de départ. Continuer ?', t.ok, t.cancel))) return;
  await call('start', device.id, true).catch((e) => alertDialog(t.startCpu, (e as Error).message, 'error'));
}

// ---------------------------------------------------------------------------
// Monitoring ("Visualiser tout")
// ---------------------------------------------------------------------------

export interface MonitorSource {
  deviceId: string;
  paths(): string[];
  apply(values: MonitorValue[]): void;
}

let monitorSource: MonitorSource | null = null;

/** The active editor registers what it wants to monitor. */
export function setMonitorSource(src: MonitorSource | null): void {
  monitorSource = src;
}

export async function toggleMonitorCmd(): Promise<void> {
  const device = currentDevice();
  if (!device) return;
  if (store.monitoring) {
    store.monitoring = false;
    store.emit('monitor');
    return;
  }
  if (!store.onlineOf(device.id).connected) {
    await goOnlineCmd(device);
    if (!store.onlineOf(device.id).connected) return;
  }
  const s = store.onlineOf(device.id);
  const compiled = store.compile.get(device.id);
  if (!compiled || !compiled.ok) {
    const r = await compileCmd(device, true);
    if (!r?.ok) {
      await alertDialog(t.monitorAll, 'Le programme doit être compilé sans erreur pour être visualisé.', 'warning');
      return;
    }
  }
  if (s.programId && s.programId !== store.compile.get(device.id)?.programId) {
    store.addMessage({ severity: 'warning', text: 'Les programmes en ligne et hors ligne sont différents : chargez le programme pour une visualisation fiable.', path: device.name });
  }
  store.monitoring = true;
  store.emit('monitor');
  if (monitorTimer === undefined) {
    const tick = async () => {
      monitorTimer = undefined;
      if (!store.monitoring) return;
      const src = monitorSource;
      if (src && store.onlineOf(src.deviceId).connected) {
        const paths = src.paths();
        if (paths.length) {
          try {
            src.apply(await call('read', src.deviceId, paths));
          } catch (e) {
            src.apply(paths.map((path) => ({ path, error: (e as Error).message })));
          }
        }
      }
      monitorTimer = window.setTimeout(tick, 500);
    };
    void tick();
  }
}

export async function modifyValue(deviceId: string, path: string, text: string): Promise<void> {
  try {
    await call('write', deviceId, path, text);
    store.addMessage({ severity: 'info', text: `${path} forcé à ${text}.`, path: store.device(deviceId)?.name });
  } catch (e) {
    store.addMessage({ severity: 'error', text: `Forçage de ${path} : ${(e as Error).message}`, path: store.device(deviceId)?.name });
  }
}

export async function forceValue(deviceId: string, path: string, value: boolean | null): Promise<void> {
  try {
    await call('force', deviceId, path, value);
    store.addMessage({ severity: 'warning', text: value === null ? `Forçage permanent de ${path} supprimé.` : `${path} forcé en permanence à ${value ? 'TRUE' : 'FALSE'}.`, path: store.device(deviceId)?.name });
  } catch (e) {
    store.addMessage({ severity: 'error', text: (e as Error).message, path: store.device(deviceId)?.name });
  }
}

export async function aboutCmd(): Promise<void> {
  await alertDialog(t.about, `${t.appName} 0.1.0\n\nLogiciel d'ingénierie pour CPU VirtualPLC\n(${Object.values(DEVICE_TYPES).map((d) => d.label).join(', ')}).\n\nLangage : SCL (CEI 61131-3).\nLicence BSD 3-Clause.`, 'info');
}

export async function call_unforce(deviceId: string): Promise<void> {
  try {
    await call('unforceAll', deviceId);
    store.addMessage({ severity: 'info', text: 'Tous les forçages permanents ont été arrêtés.', path: store.device(deviceId)?.name });
  } catch (e) {
    store.addMessage({ severity: 'error', text: (e as Error).message });
  }
}
