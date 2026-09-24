// Version management with Git: archive versions, work as a team through a shared
// repository, browse the history, compare, restore and export versions.
// Only folder projects (one file per object) are versioned: they can be merged.
import { blockLabel, loadProject, projectToFiles, type Project } from '../../../sdk/src/browser.ts';
import type { GitCommit, GitStatus } from '../backend/git.ts';
import * as A from './actions.ts';
import { clear, h, svg } from './dom.ts';
import type { EditorView } from './editors/types.ts';
import { call, host } from './host.ts';
import { icons, type IconName } from './icons.ts';
import { t } from './i18n.ts';
import { store, type EditorRef } from './store.ts';
import { contextMenu } from './ui/chrome.ts';
import { alertDialog, button, confirmDialog, openDialog, progressDialog } from './ui/dialogs.ts';

const TITLE = 'Gestion de versions';

const fmtDate = (iso: string, time = true) => new Date(iso).toLocaleString('fr-FR', time
  ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
  : { day: '2-digit', month: '2-digit', year: 'numeric' });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let refreshing: Promise<void> | null = null;

export function refreshGit(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      store.git = store.projectDir && store.fileLayout === 'folder' ? await call('gitStatus', store.projectDir) : null;
    } catch (e) {
      store.git = null;
      store.addMessage({ severity: 'error', text: `${TITLE} : ${(e as Error).message}` });
    }
    store.emit('git');
  })().finally(() => { refreshing = null; });
  return refreshing;
}
window.addEventListener('focus', () => { if (store.projectDir) void refreshGit(); });

export const isRepo = () => !!store.git?.repo;

// ---------------------------------------------------------------------------
// Project files → objects of the project tree
// ---------------------------------------------------------------------------

export interface PathInfo {
  label: string;
  icon: IconName;
  ref?: EditorRef;
}

/** Describes a project file with the names of the project tree ("PLC_1 > Blocs de programme > Main [OB1] (code)"). */
export function describePath(path: string, project: Project | null = store.project): PathInfo {
  if (project) {
    const files = projectToFiles(project);
    if (path in files || /\.(json|scl)$/.test(path)) {
      for (const d of project.devices) {
        const dirOf = Object.keys(files).find((p) => p.endsWith('/device.json') && files[p].includes(`"id": "${d.id}"`));
        const dir = dirOf?.replace(/\/device\.json$/, '');
        if (!dir || !path.startsWith(`${dir}/`)) continue;
        const rest = path.slice(dir.length + 1);
        if (rest === 'device.json') return { label: `${d.name} > ${t.deviceConfig}`, icon: 'cpu', ref: { kind: 'device', deviceId: d.id } };
        const file = files[path];
        const id = file && /"id": "([^"]+)"/.exec(file)?.[1];
        const sibling = !id && path.endsWith('.scl') ? files[path.replace(/\.scl$/, '.json')] : undefined;
        const objId = id ?? (sibling && /"id": "([^"]+)"/.exec(sibling)?.[1]);
        if (rest.startsWith('blocks/')) {
          const b = d.blocks.find((x) => x.id === objId);
          const part = path.endsWith('.scl') ? ' (code)' : ' (interface)';
          if (b) return { label: `${d.name} > ${t.programBlocks} > ${blockLabel(b)}${part}`, icon: b.type === 'OB' ? 'ob' : b.type === 'FB' ? 'fb' : b.type === 'FC' ? 'fc' : 'db', ref: { kind: 'block', deviceId: d.id, blockId: b.id } };
        }
        if (rest.startsWith('tags/')) {
          const tt = d.tagTables.find((x) => x.id === objId);
          if (tt) return { label: `${d.name} > ${t.plcTags} > ${tt.name}`, icon: 'tagTable', ref: { kind: 'tagTable', deviceId: d.id, tableId: tt.id } };
        }
        if (rest.startsWith('watch/')) {
          const w = d.watchTables.find((x) => x.id === objId);
          if (w) return { label: `${d.name} > ${t.watchTables} > ${w.name}`, icon: 'watch', ref: { kind: 'watch', deviceId: d.id, tableId: w.id } };
        }
      }
    }
  }
  // Objects that no longer exist (deleted, renamed) or files outside the project
  const m = /^devices\/([^/]+)\/(?:(device\.json)|(blocks|tags|watch)\/(.+)\.(json|scl))$/.exec(path);
  if (m) {
    if (m[2]) return { label: `${m[1]} > ${t.deviceConfig}`, icon: 'cpu' };
    const folder = { blocks: t.programBlocks, tags: t.plcTags, watch: t.watchTables }[m[3] as 'blocks' | 'tags' | 'watch'];
    return { label: `${m[1]} > ${folder} > ${m[4]}${m[3] === 'blocks' ? (m[5] === 'scl' ? ' (code)' : ' (interface)') : ''}`, icon: m[3] === 'blocks' ? 'source' : m[3] === 'tags' ? 'tagTable' : 'watch' };
  }
  if (path.endsWith('.vplcproj')) return { label: 'Propriétés du projet', icon: 'project' };
  return { label: path, icon: 'source' };
}

const STATUS_TEXT: Record<string, string> = { A: 'Ajouté', M: 'Modifié', D: 'Supprimé', R: 'Renommé', '?': 'Nouveau', U: 'Conflit' };

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

/** Version management needs a saved folder project. */
async function ensureFolderProject(): Promise<boolean> {
  if (!store.project) return false;
  if (store.fileLayout === 'folder' && store.projectDir) return true;
  const ok = await confirmDialog(TITLE,
    'La gestion de versions nécessite un projet enregistré au format dossier (un fichier par bloc et par table), '
    + 'que Git peut comparer et fusionner.\n\nEnregistrer le projet dans un dossier maintenant ?', 'Enregistrer', t.cancel);
  return ok && (await A.saveProjectCmd(true)) && store.fileLayout === 'folder';
}

async function ensureGit(): Promise<GitStatus | null> {
  await refreshGit();
  const g = store.git;
  if (!g) return null;
  if (!g.available) {
    await alertDialog(TITLE, "Git n'est pas installé sur ce poste.\nInstallez-le depuis https://git-scm.com puis redémarrez VirtualPLC Studio.", 'error');
    return null;
  }
  return g;
}

async function saveIfDirty(): Promise<boolean> {
  return !store.dirty || A.saveProjectCmd();
}

/** Name and e-mail recorded with each archived version. */
export function identityDialog(current?: { name: string; email: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    openDialog('Identité pour la gestion de versions', (d) => {
      const name = h('input', { value: current?.name ?? '', placeholder: 'Prénom Nom', style: 'width:100%' });
      const email = h('input', { value: current?.email ?? '', placeholder: 'prenom.nom@societe.fr', style: 'width:100%' });
      d.body.append(
        h('div', { className: 'muted', style: 'max-width:460px;margin-bottom:10px;line-height:1.45' }, 'Ces informations sont enregistrées avec chaque version archivée, pour savoir qui a modifié quoi.'),
        h('div', { className: 'field', style: 'grid-template-columns:90px 1fr' }, h('label', null, t.name), name),
        h('div', { className: 'field', style: 'grid-template-columns:90px 1fr' }, h('label', null, 'E-mail'), email));
      d.foot.append(button(t.ok, async () => {
        if (!name.value.trim() || !/^\S+@\S+$/.test(email.value.trim())) {
          name.classList.toggle('invalid', !name.value.trim());
          email.classList.toggle('invalid', !/^\S+@\S+$/.test(email.value.trim()));
          return;
        }
        try {
          await call('gitSetUser', store.projectDir!, name.value.trim(), email.value.trim());
          done = true;
          d.close();
        } catch (e) {
          await alertDialog(TITLE, (e as Error).message, 'error');
        }
      }, true), button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(done) });
  });
}

async function ensureIdentity(): Promise<boolean> {
  const u = store.git?.user;
  if (u?.name && u.email) return true;
  const ok = await identityDialog(u);
  await refreshGit();
  return ok;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function enableVersioningCmd(): Promise<void> {
  if (!(await ensureFolderProject())) return;
  const g = await ensureGit();
  if (!g) return;
  if (g.repo) {
    await alertDialog(TITLE, 'Le projet est déjà sous gestion de versions.');
    return;
  }
  try {
    await call('gitInit', store.projectDir!);
    await refreshGit();
    if (!(await ensureIdentity())) return;
    await saveIfDirty();
    const hash = await call('gitCommit', store.projectDir!, `Création du projet ${store.project!.name}`);
    await refreshGit();
    store.addMessage({ severity: 'ok', text: `Gestion de versions activée : première version archivée (${hash?.slice(0, 7) ?? ''}).` });
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

async function readyRepo(): Promise<boolean> {
  if (!store.project) return false;
  if (!(await ensureFolderProject())) return false;
  const g = await ensureGit();
  if (!g) return false;
  if (!g.repo) {
    if (await confirmDialog(TITLE, "Le projet n'est pas encore sous gestion de versions. L'activer maintenant ?", 'Activer', t.cancel)) await enableVersioningCmd();
    return false;
  }
  if (g.merging || g.conflicts.length) {
    await resolveConflictsCmd();
    return false;
  }
  return ensureIdentity();
}

/** "Archiver une version": saves the project and records its state with a comment. */
export async function archiveCmd(message?: string, thenSync?: boolean): Promise<boolean> {
  if (!(await readyRepo())) return false;
  if (!(await saveIfDirty())) return false;
  await refreshGit();
  const changes = store.git?.changes ?? [];
  if (!changes.length) {
    store.addMessage({ severity: 'info', text: 'Aucune modification depuis la dernière version archivée.' });
    if (message === undefined) await alertDialog(TITLE, 'Aucune modification depuis la dernière version archivée.');
    return false;
  }
  let spec: { message: string; sync: boolean } | null = message !== undefined ? { message, sync: !!thenSync } : null;
  if (!spec) spec = await archiveDialog(changes);
  if (!spec) return false;
  try {
    const hash = await call('gitCommit', store.projectDir!, spec.message);
    await refreshGit();
    store.addMessage({ severity: 'ok', text: `Version archivée ${hash?.slice(0, 7) ?? ''} : ${spec.message.split('\n')[0]}` });
    store.emit('git');
    if (spec.sync) await syncCmd();
    return true;
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
    return false;
  }
}

function changeTable(changes: Array<{ path: string; status: string }>, onOpen?: (ref: EditorRef) => void): HTMLElement {
  const table = h('table', { className: 'grid' }, h('tr', null, h('th', { style: 'width:26px' }), h('th', null, 'Objet'), h('th', { style: 'width:90px' }, 'État')));
  for (const c of changes) {
    const info = describePath(c.path);
    table.append(h('tr', { title: c.path, className: info.ref ? 'goto' : '', ondblclick: () => { if (info.ref) onOpen?.(info.ref); } },
      h('td', null, svg(icons[info.icon])), h('td', null, info.label), h('td', { className: c.status === 'U' ? 'error-text' : '' }, STATUS_TEXT[c.status] ?? c.status)));
  }
  return h('div', { className: 'grid-wrap', style: 'max-height:240px;border:1px solid var(--border-light)' }, table);
}

function archiveDialog(changes: Array<{ path: string; status: string }>): Promise<{ message: string; sync: boolean } | null> {
  return new Promise((resolve) => {
    let result: { message: string; sync: boolean } | null = null;
    openDialog('Archiver une version', (d) => {
      const msg = h('textarea', { placeholder: 'Ex. : Ajout de la temporisation de démarrage du convoyeur', style: 'width:100%;height:70px;resize:vertical' });
      const sync = h('input', { type: 'checkbox', checked: !!store.git?.remoteUrl, disabled: !store.git?.remoteUrl });
      d.body.append(
        h('div', { style: 'width:640px;display:flex;flex-direction:column;gap:10px' },
          h('div', null, `${changes.length} objet(s) modifié(s) depuis la dernière version :`),
          changeTable(changes, (ref) => { d.close(); A.openEditor(ref); }),
          h('label', { style: 'font-weight:600' }, 'Commentaire de la version'), msg,
          h('label', { style: 'display:flex;align-items:center;gap:6px' }, sync,
            store.git?.remoteUrl ? `Synchroniser ensuite avec le dépôt de l'équipe (${store.git.remoteUrl})` : "Pas de dépôt d'équipe configuré (version archivée sur ce poste uniquement)")));
      const ok = () => {
        if (!msg.value.trim()) {
          msg.classList.add('invalid');
          msg.focus();
          return;
        }
        result = { message: msg.value.trim(), sync: sync.checked };
        d.close();
      };
      d.foot.append(button('Archiver', ok, true), button(t.cancel, () => d.close()));
      setTimeout(() => msg.focus(), 0);
    }, { onClose: () => resolve(result) });
  });
}

/** Reloads the project from its folder (after a synchronisation or a conflict resolution). */
async function reloadFromDisk(): Promise<void> {
  if (!store.filePath) return;
  const r = await call('projectOpen', store.filePath);
  const editors = store.editors;
  const active = store.active;
  store.project = loadProject(r.json);
  store.dirty = false;
  // rebuild the editors on the new objects
  store.editors = [];
  store.active = null;
  store.emit('editors');
  store.editors = editors;
  store.active = active;
  A.pruneEditors();
  store.compile.clear();
  store.emit('project');
  store.emit('compile');
}

/** "Synchroniser avec l'équipe": receives the versions of the others, then sends the local ones. */
export async function syncCmd(): Promise<void> {
  if (!(await readyRepo())) return;
  if (!store.git?.remoteUrl) {
    if (await confirmDialog(TITLE, "Aucun dépôt d'équipe n'est configuré. Le configurer maintenant ?", 'Configurer', t.cancel)) await remoteCmd();
    if (!store.git?.remoteUrl) return;
  }
  if (!(await saveIfDirty())) return;
  await refreshGit();
  if (store.git?.changes.length) {
    const archive = await confirmDialog(TITLE, 'Des modifications ne sont pas encore archivées.\nArchivez-les dans une version avant de synchroniser.', 'Archiver...', t.cancel);
    if (!archive || !(await archiveCmd())) return;
    await refreshGit();
  }
  const progress = progressDialog('Synchroniser avec l\'équipe', `Échange avec ${store.git?.remoteUrl ?? ''}...`);
  progress.set(0.3);
  try {
    const r = await call('gitSync', store.projectDir!);
    progress.close();
    if (r.conflicts.length) {
      await refreshGit();
      await resolveConflictsCmd();
      return;
    }
    if (r.received) await reloadFromDisk();
    await refreshGit();
    const text = r.received || r.sent
      ? `Synchronisation terminée : ${r.received} version(s) reçue(s), ${r.sent} envoyée(s).`
      : 'Le projet est à jour avec le dépôt de l\'équipe.';
    store.addMessage({ severity: 'ok', text });
  } catch (e) {
    progress.close();
    await refreshGit();
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

/** Conflicts: the same object was changed by two engineers. The user picks one version per object. */
export async function resolveConflictsCmd(): Promise<void> {
  await refreshGit();
  const conflicts = store.git?.conflicts ?? [];
  const dir = store.projectDir;
  if (!dir) return;
  const choice = await new Promise<{ sides: Map<string, 'mine' | 'theirs'> } | 'abort' | null>((resolve) => {
    let result: { sides: Map<string, 'mine' | 'theirs'> } | 'abort' | null = null;
    openDialog('Conflits de fusion', (d) => {
      const sides = new Map<string, 'mine' | 'theirs'>(conflicts.map((c) => [c, 'theirs']));
      const table = h('table', { className: 'grid' }, h('tr', null, h('th', { style: 'width:26px' }), h('th', null, 'Objet modifié des deux côtés'), h('th', { style: 'width:130px' }, 'Ma version'), h('th', { style: 'width:150px' }, "Version de l'équipe")));
      for (const c of conflicts) {
        const info = describePath(c);
        const radio = (side: 'mine' | 'theirs') => {
          const r = h('input', { type: 'radio', name: `side-${c}`, checked: side === 'theirs' });
          r.onchange = () => sides.set(c, side);
          return h('td', { style: 'text-align:center' }, r);
        };
        table.append(h('tr', { title: c }, h('td', null, svg(icons[info.icon])), h('td', null, info.label), radio('mine'), radio('theirs')));
      }
      d.body.append(h('div', { style: 'width:680px;display:flex;flex-direction:column;gap:10px' },
        h('div', { style: 'display:flex;gap:10px;line-height:1.45' }, svg(icons.warning),
          h('div', null, `${conflicts.length} objet(s) ont été modifiés à la fois sur ce poste et par un autre membre de l'équipe. `
            + 'Choisissez, pour chacun, la version à conserver. L\'autre version reste consultable dans l\'historique des versions.')),
        h('div', { className: 'grid-wrap', style: 'max-height:300px;border:1px solid var(--border-light)' }, table)));
      d.foot.append(
        h('div', { className: 'left' }, button('Annuler la synchronisation', () => { result = 'abort'; d.close(); })),
        button('Terminer la fusion', () => { result = { sides }; d.close(); }, true),
        button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
  if (!choice) return;
  try {
    if (choice === 'abort') {
      await call('gitAbortMerge', dir);
      store.addMessage({ severity: 'info', text: 'Synchronisation annulée : le projet est revenu à votre dernière version.' });
    } else {
      for (const [path, side] of choice.sides) await call('gitResolve', dir, path, side);
      await call('gitFinishMerge', dir);
      store.addMessage({ severity: 'ok', text: `Fusion terminée (${choice.sides.size} conflit(s) résolu(s)).` });
    }
    await reloadFromDisk();
    await refreshGit();
    if (choice !== 'abort') await syncCmd();
  } catch (e) {
    await refreshGit();
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

/** "Dépôt de l'équipe": address of the shared repository (server, GitHub/GitLab, network share). */
export async function remoteCmd(): Promise<void> {
  if (!(await readyRepo())) return;
  const url = await new Promise<string | null>((resolve) => {
    let result: string | null = null;
    openDialog("Dépôt de l'équipe", (d) => {
      const input = h('input', { value: store.git?.remoteUrl ?? '', placeholder: 'https://serveur/equipe/projet.git', style: 'width:100%' });
      d.body.append(h('div', { style: 'width:560px;display:flex;flex-direction:column;gap:8px;line-height:1.45' },
        h('div', { className: 'muted' }, "Adresse du dépôt Git partagé par l'équipe : serveur d'entreprise (GitLab, Gitea, Azure DevOps…), GitHub, "
          + 'ou dossier partagé du réseau (ex. \\\\serveur\\projets\\station.git). Les identifiants sont ceux configurés pour Git sur ce poste.'),
        h('div', { className: 'field', style: 'grid-template-columns:70px 1fr' }, h('label', null, 'Adresse'), input)));
      const ok = () => { result = input.value.trim(); d.close(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      d.foot.append(button(t.ok, ok, true), button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
  if (!url) return;
  try {
    await call('gitSetRemote', store.projectDir!, url);
    await refreshGit();
    store.addMessage({ severity: 'ok', text: `Dépôt de l'équipe : ${url}` });
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

/** "Récupérer un projet depuis un dépôt": first copy of a team project on this computer. */
export async function cloneCmd(): Promise<void> {
  const spec = await new Promise<{ url: string; parent: string } | null>((resolve) => {
    let result: { url: string; parent: string } | null = null;
    openDialog('Récupérer un projet depuis un dépôt', (d) => {
      const url = h('input', { placeholder: 'https://serveur/equipe/projet.git', style: 'width:100%' });
      const parent = h('input', { placeholder: 'Dossier des projets sur ce poste', style: 'width:100%' });
      const browse = button('Parcourir...', async () => {
        const p = await host.pickPath('folder', parent.value || undefined);
        if (p) parent.value = p;
      });
      d.body.append(h('div', { style: 'width:600px;display:grid;grid-template-columns:120px 1fr auto;gap:8px;align-items:center' },
        h('label', null, 'Dépôt'), url, h('span'),
        h('label', null, 'Enregistrer dans'), parent, browse));
      d.foot.append(button('Récupérer', () => {
        if (!url.value.trim() || !parent.value.trim()) return;
        result = { url: url.value.trim(), parent: parent.value.trim() };
        d.close();
      }, true), button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
  if (!spec) return;
  if (store.project && store.dirty && !(await confirmDialog(t.appName, 'Le projet ouvert a été modifié. Abandonner les modifications ?', 'Abandonner', t.cancel))) return;
  const progress = progressDialog('Récupérer un projet', `Copie de ${spec.url}...`);
  progress.set(0.3);
  try {
    const r = await call('gitClone', spec.url, spec.parent);
    progress.close();
    store.dirty = false;
    await A.openProjectPath(r.path);
    store.addMessage({ severity: 'ok', text: `Projet récupéré depuis ${spec.url} dans ${r.dir}.` });
  } catch (e) {
    progress.close();
    await alertDialog('Récupérer un projet', (e as Error).message, 'error');
  }
}

export function openHistoryCmd(): void {
  if (!store.project) return;
  A.openEditor({ kind: 'history' });
}

// ---------------------------------------------------------------------------
// Compare, restore, tag, export
// ---------------------------------------------------------------------------

function diffDialog(title: string, text: string): void {
  openDialog(title, (d) => {
    const pre = h('div', { className: 'diff' });
    if (!text.trim()) pre.append(h('div', { className: 'muted', style: 'padding:10px' }, 'Aucune différence.'));
    for (const line of text.split('\n')) {
      const file = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (file) {
        const info = describePath(file[2]);
        pre.append(h('div', { className: 'diff-file' }, svg(icons[info.icon]), info.label));
        continue;
      }
      if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) continue;
      const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
      pre.append(h('div', { className: `diff-line ${cls}` }, line.startsWith('@@') ? line.replace(/^@@ (.*?) @@.*$/, '@@ $1') : line || ' '));
    }
    d.body.append(h('div', { style: 'width:min(1000px, 86vw);height:min(640px, 70vh);display:flex;flex-direction:column' }, pre));
    d.foot.append(button(t.close, () => d.close(), true));
  });
}

async function compareCmd(from: string, to: string | undefined, label: string): Promise<void> {
  try {
    if (!to && store.dirty) await A.saveProjectCmd();
    diffDialog(label, await call('gitDiff', store.projectDir!, from, to));
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

async function restoreCmd(c: GitCommit): Promise<void> {
  const ok = await confirmDialog('Restaurer une version',
    `Remplacer le contenu du projet par la version du ${fmtDate(c.date)} (« ${c.subject} ») ?\n\n`
    + "Rien n'est perdu : la version actuelle reste dans l'historique, et la version restaurée devra être archivée comme une nouvelle version.",
    'Restaurer', t.cancel);
  if (!ok) return;
  try {
    const p = loadProject(await call('gitProjectAt', store.projectDir!, c.hash));
    const editors = store.editors;
    store.project = p;
    store.editors = [];
    store.emit('editors');
    store.editors = editors;
    A.pruneEditors();
    store.compile.clear();
    store.touch();
    await A.saveProjectCmd();
    store.addMessage({ severity: 'warning', text: `Version ${c.short} restaurée. Archivez-la pour l'enregistrer comme nouvelle version.` });
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

async function tagCmd(c: GitCommit): Promise<void> {
  const spec = await new Promise<{ name: string; message: string } | null>((resolve) => {
    let result: { name: string; message: string } | null = null;
    openDialog('Marquer la version', (d) => {
      const name = h('input', { placeholder: 'V1.0', style: 'width:100%' });
      const msg = h('input', { placeholder: 'Ex. : Mise en service sur site', style: 'width:100%' });
      d.body.append(h('div', { style: 'width:480px' },
        h('div', { className: 'muted', style: 'margin-bottom:10px;line-height:1.45' }, `Version du ${fmtDate(c.date)} — ${c.subject}. Un repère identifie une version livrée, mise en service ou réceptionnée.`),
        h('div', { className: 'field', style: 'grid-template-columns:110px 1fr' }, h('label', null, 'Repère'), name),
        h('div', { className: 'field', style: 'grid-template-columns:110px 1fr' }, h('label', null, t.comment), msg)));
      d.foot.append(button(t.ok, () => {
        if (!/^[\w.-]+$/.test(name.value.trim())) {
          name.classList.add('invalid');
          return;
        }
        result = { name: name.value.trim(), message: msg.value.trim() };
        d.close();
      }, true), button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
  if (!spec) return;
  try {
    await call('gitTag', store.projectDir!, spec.name, spec.message, c.hash);
    store.addMessage({ severity: 'ok', text: `Version ${c.short} marquée « ${spec.name} ». Elle sera transmise à l'équipe à la prochaine synchronisation.` });
    store.emit('git');
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

async function exportCmd(c: GitCommit): Promise<void> {
  const name = `${store.project?.name ?? 'projet'}_${c.tags[0] ?? c.short}.zip`;
  const out = await host.pickPath('zip', name);
  if (!out) return;
  try {
    await call('gitArchive', store.projectDir!, c.hash, out);
    store.addMessage({ severity: 'ok', text: `Archive de la version ${c.tags[0] ?? c.short} : ${out}` });
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

// ---------------------------------------------------------------------------
// History editor ("Historique des versions")
// ---------------------------------------------------------------------------

export function historyEditor(): EditorView {
  let commits: GitCommit[] = [];
  let selected: GitCommit | null = null;
  const toolbar = h('div', { className: 'panel-toolbar' });
  const list = h('div', { className: 'grid-wrap', style: 'flex:1' });
  const detail = h('div', { className: 'vc-detail' });
  const element = h('div', { className: 'editor-host', style: 'display:flex;flex-direction:column' }, toolbar, list, detail);

  const actions = (c: GitCommit) => {
    const previous = c.parents[0];
    return [
      { label: 'Comparer avec le projet actuel', icon: 'differ' as IconName, run: () => void compareCmd(c.hash, undefined, `Différences : version ${c.short} → projet actuel`) },
      { label: 'Comparer avec la version précédente', icon: 'differ' as IconName, run: () => void compareCmd(previous!, c.hash, `Modifications de la version ${c.short}`), enabled: () => !!previous },
      'sep' as const,
      { label: 'Restaurer cette version...', icon: 'undo' as IconName, run: () => void restoreCmd(c) },
      { label: 'Marquer la version (repère)...', icon: 'tag' as IconName, run: () => void tagCmd(c).then(load) },
      { label: 'Exporter en archive .zip...', icon: 'archive' as IconName, run: () => void exportCmd(c) },
    ];
  };

  const renderDetail = () => {
    clear(detail);
    if (!selected) {
      detail.append(h('span', { className: 'muted' }, 'Sélectionnez une version.'));
      return;
    }
    const c = selected;
    detail.append(
      h('div', { className: 'kv', style: 'padding:0' },
        h('span', null, 'Version'), h('span', { className: 'mono' }, c.hash),
        h('span', null, 'Date'), h('span', null, fmtDate(c.date)),
        h('span', null, 'Auteur'), h('span', null, `${c.author} <${c.email}>`),
        h('span', null, t.comment), h('span', { style: 'white-space:pre-wrap' }, c.body ? `${c.subject}\n\n${c.body}` : c.subject)),
      h('div', { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' },
        ...actions(c).filter((a) => a !== 'sep').map((a) => {
          const item = a as { label: string; icon: IconName; run: () => void; enabled?: () => boolean };
          return h('button', { className: 'button', disabled: item.enabled ? !item.enabled() : false, onclick: item.run }, svg(icons[item.icon]), item.label.replace(/\.\.\.$/, ''));
        })));
  };

  const renderList = () => {
    clear(list);
    const g = store.git;
    if (!g?.repo) {
      list.append(h('div', { className: 'empty-state' },
        h('div', null, store.fileLayout === 'folder' ? "Le projet n'est pas sous gestion de versions." : 'La gestion de versions nécessite un projet enregistré au format dossier.'),
        h('button', { className: 'button primary', onclick: () => void enableVersioningCmd() }, svg(icons.history), 'Activer la gestion de versions')));
      return;
    }
    const table = h('table', { className: 'grid' },
      h('tr', null, h('th', { style: 'width:26px' }), h('th', { style: 'width:110px' }, 'Repère'), h('th', { style: 'width:150px' }, 'Date'),
        h('th', { style: 'width:160px' }, 'Auteur'), h('th', null, 'Commentaire'), h('th', { style: 'width:80px' }, 'Version')));
    for (const c of commits) {
      const tr = h('tr', {
        className: selected?.hash === c.hash ? 'selected' : '',
        onmousedown: () => { selected = c; renderList(); renderDetail(); },
        ondblclick: () => void compareCmd(c.hash, undefined, `Différences : version ${c.short} → projet actuel`),
        oncontextmenu: (e: Event) => { selected = c; renderList(); renderDetail(); contextMenu(e as MouseEvent, actions(c)); },
      },
      h('td', null, svg(icons[c.tags.length ? 'tag' : 'history'])),
      h('td', null, ...c.tags.map((x) => h('span', { className: 'pill run', style: 'margin-right:3px' }, x))),
      h('td', null, fmtDate(c.date)), h('td', null, c.author), h('td', { title: c.body || c.subject }, c.subject),
      h('td', { className: 'mono' }, c.short));
      if (c.parents.length > 1) tr.classList.add('vc-merge');
      table.append(tr);
    }
    if (!commits.length) table.append(h('tr', null, h('td', { colSpan: '6', className: 'muted', style: 'padding:8px' }, 'Aucune version archivée.')));
    list.append(table);
  };

  const renderToolbar = () => {
    clear(toolbar);
    const g = store.git;
    const tb = (icon: IconName, label: string, run: () => void, enabled = true) =>
      h('button', { className: 'button', style: 'margin-right:6px;white-space:nowrap;flex:none', disabled: !enabled, onclick: run }, svg(icons[icon]), label);
    toolbar.append(
      tb('archive', 'Archiver une version', () => void archiveCmd().then(load), !!g?.repo),
      tb('sync', "Synchroniser avec l'équipe", () => void syncCmd().then(load), !!g?.repo),
      tb('refresh', 'Actualiser', () => void refreshGit().then(load)),
      h('span', { className: 'muted', style: 'margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' }, g?.repo
        ? `Branche ${g.branch ?? '?'} — ${g.remoteUrl ? `dépôt de l'équipe : ${g.remoteUrl}` : "pas de dépôt d'équipe"}${g.changes.length ? ` — ${g.changes.length} modification(s) non archivée(s)` : ''}`
        : ''));
  };

  const load = async () => {
    renderToolbar();
    commits = store.git?.repo && store.projectDir ? await call('gitLog', store.projectDir, 500).catch(() => []) : [];
    selected = commits.find((c) => c.hash === selected?.hash) ?? commits[0] ?? null;
    renderList();
    renderDetail();
  };
  const off = store.on((topic) => { if (topic === 'git') void load(); });
  void load();
  return {
    element, icon: 'history', title: () => 'Historique des versions', crumbs: () => [TITLE, 'Historique des versions'],
    destroy: off,
  };
}

// ---------------------------------------------------------------------------
// Task card "Versions"
// ---------------------------------------------------------------------------

export function versionsCard(body: HTMLElement): void {
  const g = store.git;
  const p = store.project;
  if (!p) {
    body.append(h('div', { className: 'operator' }, h('div', { className: 'op-title' }, TITLE),
      h('div', { style: 'padding:10px;display:flex;flex-direction:column;gap:6px' },
        h('span', { className: 'muted' }, "Récupérez un projet partagé par l'équipe :"),
        h('button', { className: 'button', onclick: () => void cloneCmd() }, svg(icons.branch), 'Récupérer depuis un dépôt...'))));
    return;
  }
  if (!g?.repo) {
    body.append(h('div', { className: 'operator' }, h('div', { className: 'op-title' }, TITLE),
      h('div', { style: 'padding:10px;display:flex;flex-direction:column;gap:8px;line-height:1.45' },
        h('span', { className: 'muted' }, g && !g.available ? "Git n'est pas installé sur ce poste (https://git-scm.com)."
          : 'Archivez des versions du projet, consultez l\'historique et travaillez en équipe grâce à un dépôt Git partagé.'),
        h('button', { className: 'button primary', disabled: !!g && !g.available, onclick: () => void enableVersioningCmd() }, svg(icons.history), 'Activer la gestion de versions'))));
    return;
  }
  if (g.merging || g.conflicts.length) {
    body.append(h('div', { className: 'operator vc-conflict' }, h('div', { className: 'op-title' }, 'Fusion en cours'),
      h('div', { style: 'padding:10px;display:flex;flex-direction:column;gap:8px' },
        h('span', null, `${g.conflicts.length} conflit(s) à résoudre.`),
        h('button', { className: 'button primary', onclick: () => void resolveConflictsCmd() }, svg(icons.warning), 'Résoudre les conflits...'))));
  }
  const pending = g.changes.length;
  body.append(h('div', { className: 'operator' },
    h('div', { className: 'op-title' }, 'État'),
    h('div', { className: 'kv' },
      h('span', null, 'Branche'), h('span', null, g.branch ?? '—'),
      h('span', null, 'Dépôt équipe'), h('span', { title: g.remoteUrl ?? '' , style: 'overflow:hidden;text-overflow:ellipsis' }, g.remoteUrl ? g.remoteUrl.replace(/^.*[/\\]/, '') : h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); void remoteCmd(); } }, 'Configurer...')),
      h('span', null, 'À envoyer'), h('span', null, g.remoteUrl ? `${g.ahead ?? 0} version(s)` : '—'),
      h('span', null, 'Auteur'), h('span', null, g.user?.name ? g.user.name : h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); void identityDialog(g.user).then(() => refreshGit()); } }, 'Définir...')))));

  const changes = h('div', { className: 'vc-changes' });
  if (store.dirty) changes.append(h('div', { className: 'vc-change muted' }, svg(icons.save), 'Modifications non enregistrées'));
  for (const c of g.changes.slice(0, 14)) {
    const info = describePath(c.path);
    changes.append(h('div', { className: 'vc-change', title: `${STATUS_TEXT[c.status]} — ${c.path}`, ondblclick: () => { if (info.ref) A.openEditor(info.ref); } },
      h('span', { className: `vc-status s${c.status === '?' ? 'N' : c.status}` }, c.status === '?' ? 'N' : c.status), svg(icons[info.icon]), h('span', { className: 'label' }, info.label.replace(/^[^>]+> /, ''))));
  }
  if (g.changes.length > 14) changes.append(h('div', { className: 'muted', style: 'padding:2px 8px' }, `… et ${g.changes.length - 14} autre(s)`));
  if (!pending && !store.dirty) changes.append(h('div', { className: 'muted', style: 'padding:4px 8px' }, 'Aucune modification depuis la dernière version.'));

  const msg = h('textarea', { placeholder: 'Commentaire de la version', style: 'width:100%;height:54px;resize:vertical' });
  const archive = h('button', { className: 'button primary', disabled: !pending && !store.dirty, onclick: () => {
    if (!msg.value.trim()) {
      void archiveCmd();
      return;
    }
    void archiveCmd(msg.value.trim(), false);
  } }, svg(icons.archive), 'Archiver');
  body.append(h('div', { className: 'operator' },
    h('div', { className: 'op-title' }, `Modifications (${pending})`), changes,
    h('div', { style: 'padding:8px;display:flex;flex-direction:column;gap:6px' }, msg,
      h('div', { style: 'display:flex;gap:6px' }, archive,
        h('button', { className: 'button', onclick: () => void syncCmd() }, svg(icons.sync), 'Synchroniser')))));

  const recent = h('div', { className: 'vc-changes' }, h('div', { className: 'muted', style: 'padding:4px 8px' }, '…'));
  body.append(h('div', { className: 'operator' },
    h('div', { className: 'op-title' }, 'Dernières versions'), recent,
    h('div', { style: 'padding:0 8px 8px' }, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); openHistoryCmd(); } }, 'Historique complet...'))));
  void call('gitLog', store.projectDir!, 6).then((log) => {
    clear(recent);
    if (!log.length) recent.append(h('div', { className: 'muted', style: 'padding:4px 8px' }, 'Aucune version.'));
    for (const c of log) {
      recent.append(h('div', { className: 'vc-change', title: `${c.author} — ${fmtDate(c.date)}`, ondblclick: openHistoryCmd },
        svg(icons[c.tags.length ? 'tag' : 'history']),
        h('span', { className: 'label' }, c.tags.length ? `[${c.tags.join(', ')}] ${c.subject}` : c.subject),
        h('span', { className: 'muted', style: 'margin-left:auto;padding-left:6px' }, fmtDate(c.date, false))));
    }
  }).catch(() => undefined);
}

/** Short status for the status bar. */
export function statusText(): string {
  const g = store.git;
  if (!g?.repo) return '';
  const parts = [`${g.branch ?? '?'}`];
  if (g.merging) parts.push('fusion en cours');
  if (g.changes.length) parts.push(`${g.changes.length} modif. non archivée(s)`);
  if (g.remoteUrl && g.ahead) parts.push(`${g.ahead} à envoyer`);
  return parts.join(' · ');
}
