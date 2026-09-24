// Branches: one branch per engineer or per topic ("alice/convoyeur"), switching,
// merging, publishing and deleting — the "Branches" editor and its commands.
import type { GitBranch, GitRemoteBranch } from '../backend/git.ts';
import * as A from './actions.ts';
import { clear, h, svg } from './dom.ts';
import type { EditorView } from './editors/types.ts';
import { call } from './host.ts';
import { icons, type IconName } from './icons.ts';
import { t } from './i18n.ts';
import { store } from './store.ts';
import { contextMenu } from './ui/chrome.ts';
import { alertDialog, button, confirmDialog, openDialog } from './ui/dialogs.ts';
import {
  archiveCmd, compareCmd, fmtDate, readyRepo, refreshGit, reloadFromDisk, resolveConflictsCmd, saveIfDirty, syncCmd,
} from './versioning.ts';

const TITLE = 'Branches';

/** "Alice Martin" -> "alice-martin" (prefix of personal branches). */
export function userSlug(name: string | undefined): string {
  return (name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Branch operations need a saved and archived project. */
async function ensureClean(action: string): Promise<boolean> {
  if (!(await readyRepo())) return false;
  if (!(await saveIfDirty())) return false;
  await refreshGit();
  if (!store.git?.changes.length) return true;
  const ok = await confirmDialog(TITLE, `Des modifications ne sont pas archivées.\nArchivez-les dans une version avant de ${action}.`, 'Archiver...', t.cancel);
  if (!ok || !(await archiveCmd())) return false;
  await refreshGit();
  return !store.git?.changes.length;
}

async function afterCheckout(message: string): Promise<void> {
  await reloadFromDisk();
  await refreshGit();
  store.addMessage({ severity: 'ok', text: message });
}

export async function switchBranchCmd(name: string): Promise<void> {
  if (!(await ensureClean('changer de branche'))) return;
  try {
    await call('gitSwitch', store.projectDir!, name);
    await afterCheckout(`Branche actuelle : ${store.git?.branch ?? name}. Le projet a été rechargé.`);
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

/** New branch (personal = prefixed with the engineer's name). */
export async function newBranchCmd(from?: string, personal = false): Promise<void> {
  if (!(await readyRepo())) return;
  const dir = store.projectDir!;
  const { local, remote } = await call('gitBranches', dir);
  const prefix = personal || !from ? `${userSlug(store.git?.user?.name)}/` : '';
  const spec = await new Promise<{ name: string; from: string; switchTo: boolean; publish: boolean } | null>((resolve) => {
    let result: { name: string; from: string; switchTo: boolean; publish: boolean } | null = null;
    openDialog('Nouvelle branche', (d) => {
      const name = h('input', { value: prefix === '/' ? '' : prefix, placeholder: 'prenom-nom/sujet', style: 'width:100%' });
      const base = h('select', { style: 'width:100%' },
        ...local.map((b) => h('option', { value: b.name }, `${b.name}${b.current ? ' (actuelle)' : ''}`)),
        ...remote.filter((b) => !b.tracked).map((b) => h('option', { value: b.ref }, `${b.ref} (dépôt ${b.remote})`)));
      base.value = from ?? store.git?.branch ?? local[0]?.name ?? '';
      const sw = h('input', { type: 'checkbox', checked: true });
      const pub = h('input', { type: 'checkbox', checked: !!store.git?.remotes.length, disabled: !store.git?.remotes.length });
      d.body.append(h('div', { style: 'width:560px;display:flex;flex-direction:column;gap:8px;line-height:1.45' },
        h('div', { className: 'muted' }, 'Une branche permet de travailler sur une évolution sans gêner les autres : '
          + 'une branche par ingénieur (ex. alice-martin/convoyeur) ou par sujet, fusionnée ensuite dans la branche principale.'),
        h('div', { style: 'display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center' },
          h('label', null, t.name), name, h('label', null, 'À partir de'), base),
        h('label', { style: 'display:flex;gap:6px;align-items:center' }, sw, 'Basculer sur la nouvelle branche'),
        h('label', { style: 'display:flex;gap:6px;align-items:center' }, pub, "Publier la branche sur le dépôt de l'équipe")));
      const ok = () => {
        const v = name.value.trim();
        if (!v || /\s|\.\.|[~^:?*[\\]|\/$|^\/|\.lock$/.test(v)) {
          name.classList.add('invalid');
          name.title = "Pas d'espace ni de caractères spéciaux (ex. alice-martin/convoyeur)";
          return;
        }
        result = { name: v, from: base.value, switchTo: sw.checked, publish: pub.checked && sw.checked };
        d.close();
      };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      d.foot.append(button('Créer', ok, true), button(t.cancel, () => d.close()));
      setTimeout(() => { name.focus(); name.setSelectionRange(name.value.length, name.value.length); }, 0);
    }, { onClose: () => resolve(result) });
  });
  if (!spec) return;
  if (spec.switchTo && !(await ensureClean('changer de branche'))) return;
  try {
    await call('gitCreateBranch', dir, spec.name, spec.from, spec.switchTo);
    if (spec.switchTo) await afterCheckout(`Branche « ${spec.name} » créée à partir de ${spec.from} : c'est maintenant la branche actuelle.`);
    else {
      await refreshGit();
      store.addMessage({ severity: 'ok', text: `Branche « ${spec.name} » créée à partir de ${spec.from}.` });
    }
    if (spec.publish) await syncCmd();
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

async function merge(ref: string): Promise<boolean> {
  const r = await call('gitMergeBranch', store.projectDir!, ref);
  if (r.conflicts.length) {
    await refreshGit();
    await resolveConflictsCmd(false);
    return true;
  }
  await afterCheckout(r.merged
    ? `${r.merged} version(s) de « ${ref} » fusionnée(s) dans « ${store.git?.branch ?? ''} ». Synchronisez pour les partager.`
    : `« ${store.git?.branch ?? ''} » contient déjà toutes les versions de « ${ref} ».`);
  return true;
}

/** Brings the versions of another branch into the current one (e.g. update my branch from main). */
export async function mergeIntoCurrentCmd(ref: string): Promise<void> {
  if (!(await ensureClean('fusionner'))) return;
  if (!(await confirmDialog(TITLE, `Fusionner « ${ref} » dans la branche actuelle « ${store.git?.branch ?? ''} » ?`, 'Fusionner', t.cancel))) return;
  try {
    await merge(ref);
  } catch (e) {
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

/** Delivers the current branch into another one (e.g. my branch into main): switch, then merge. */
export async function integrateIntoCmd(target: string): Promise<void> {
  const source = store.git?.branch;
  if (!source || target === source) return;
  if (!(await ensureClean('intégrer la branche'))) return;
  if (!(await confirmDialog(TITLE, `Intégrer la branche « ${source} » dans « ${target} » ?\n\n« ${target} » devient la branche actuelle, puis les versions de « ${source} » y sont fusionnées.`, 'Intégrer', t.cancel))) return;
  try {
    await call('gitSwitch', store.projectDir!, target);
    await refreshGit();
    await merge(source);
  } catch (e) {
    await refreshGit();
    await alertDialog(TITLE, (e as Error).message, 'error');
  }
}

export async function deleteBranchCmd(b: { name: string; remoteRef?: string; hasRemote: boolean; local: boolean }): Promise<void> {
  const dir = store.projectDir!;
  const withRemote = await new Promise<boolean | null>((resolve) => {
    let result: boolean | null = null;
    openDialog('Supprimer la branche', (d) => {
      const cb = h('input', { type: 'checkbox', checked: !b.local });
      d.body.append(h('div', { style: 'width:480px;display:flex;flex-direction:column;gap:10px' },
        h('div', null, `Supprimer la branche « ${b.name} » ?`),
        b.hasRemote ? h('label', { style: 'display:flex;gap:6px;align-items:center' }, cb, `Supprimer aussi sur le dépôt distant (${b.remoteRef})`) : null));
      d.foot.append(button(t.delete, () => { result = b.hasRemote && cb.checked; d.close(); }, true), button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
  if (withRemote === null) return;
  try {
    await call('gitDeleteBranch', dir, b.local ? b.name : b.remoteRef!, false, withRemote);
  } catch (e) {
    const msg = (e as Error).message;
    if (!/fusionnées nulle part/.test(msg) || !(await confirmDialog(TITLE, `${msg}\n\nSupprimer quand même ? Ces versions seront perdues.`, t.delete, t.cancel))) {
      if (!/fusionnées nulle part/.test(msg)) await alertDialog(TITLE, msg, 'error');
      return;
    }
    try {
      await call('gitDeleteBranch', dir, b.name, true, withRemote);
    } catch (e2) {
      await alertDialog(TITLE, (e2 as Error).message, 'error');
      return;
    }
  }
  await refreshGit();
  store.addMessage({ severity: 'ok', text: `Branche « ${b.name} » supprimée${withRemote ? ' (aussi sur le dépôt distant)' : ''}.` });
}

// ---------------------------------------------------------------------------
// "Branches" editor
// ---------------------------------------------------------------------------

type Row = { kind: 'local'; b: GitBranch } | { kind: 'remote'; b: GitRemoteBranch };

export function branchesEditor(): EditorView {
  let local: GitBranch[] = [];
  let remote: GitRemoteBranch[] = [];
  let selected: string | null = null;
  const toolbar = h('div', { className: 'panel-toolbar' });
  const list = h('div', { className: 'grid-wrap', style: 'flex:1' });
  const element = h('div', { className: 'editor-host', style: 'display:flex;flex-direction:column' }, toolbar, list);

  const keyOf = (r: Row) => (r.kind === 'local' ? `L:${r.b.name}` : `R:${r.b.ref}`);
  const refOf = (r: Row) => (r.kind === 'local' ? r.b.name : r.b.ref);
  const reload = () => void load();

  const actions = (r: Row) => {
    const current = store.git?.branch;
    const isCurrent = r.kind === 'local' && r.b.current;
    const ref = refOf(r);
    const name = r.b.name;
    const upstream = r.kind === 'local' ? r.b.upstream : r.b.ref;
    return [
      { label: 'Basculer sur cette branche', icon: 'branch' as IconName, run: () => void switchBranchCmd(ref).then(reload), enabled: () => !isCurrent },
      { label: `Fusionner dans la branche actuelle (${current ?? ''})`, icon: 'sync' as IconName, run: () => void mergeIntoCurrentCmd(ref).then(reload), enabled: () => !isCurrent },
      { label: `Intégrer ${current ?? ''} dans cette branche`, icon: 'download' as IconName, run: () => void integrateIntoCmd(ref).then(reload), enabled: () => !isCurrent && r.kind === 'local' },
      { label: 'Comparer avec la branche actuelle', icon: 'differ' as IconName, run: () => void compareCmd('HEAD', ref, `Différences : ${current ?? ''} → ${ref}`), enabled: () => !isCurrent },
      'sep' as const,
      { label: 'Nouvelle branche à partir de celle-ci...', icon: 'add' as IconName, run: () => void newBranchCmd(ref).then(reload) },
      { label: 'Publier / synchroniser', icon: 'sync' as IconName, run: () => void syncCmd().then(reload), enabled: () => isCurrent },
      { label: t.delete, icon: 'del' as IconName, run: () => void deleteBranchCmd({ name, local: r.kind === 'local', remoteRef: upstream, hasRemote: !!upstream && remote.some((x) => x.ref === upstream) }).then(reload), enabled: () => !isCurrent },
    ];
  };

  const render = () => {
    clear(list);
    if (!store.git?.repo) {
      list.append(h('div', { className: 'empty-state' }, "Le projet n'est pas sous gestion de versions."));
      return;
    }
    const table = h('table', { className: 'grid' },
      h('tr', null, h('th', { style: 'width:26px' }), h('th', { style: 'width:24%' }, 'Branche'), h('th', { style: 'width:16%' }, 'Suit'),
        h('th', { style: 'width:90px' }, '↑ / ↓'), h('th', null, 'Dernière version'), h('th', { style: 'width:130px' }, 'Auteur'), h('th', { style: 'width:130px' }, 'Date')));
    const row = (r: Row) => {
      const b = r.b;
      const k = keyOf(r);
      const isCurrent = r.kind === 'local' && r.b.current;
      table.append(h('tr', {
        className: `${selected === k ? 'selected' : ''}${isCurrent ? ' vc-current' : ''}`,
        onmousedown: () => { selected = k; render(); },
        ondblclick: () => { if (!isCurrent) void switchBranchCmd(refOf(r)).then(reload); },
        oncontextmenu: (e: Event) => { selected = k; render(); contextMenu(e as MouseEvent, actions(r)); },
      },
      h('td', null, svg(icons[isCurrent ? 'ok' : 'branch'])),
      h('td', { title: refOf(r) }, r.kind === 'local' ? b.name : h('span', { className: 'muted' }, r.b.ref)),
      h('td', null, r.kind === 'local' ? (r.b.gone ? h('span', { className: 'error-text' }, 'supprimée du dépôt') : r.b.upstream ?? h('span', { className: 'muted' }, 'non publiée')) : `dépôt ${r.b.remote}`),
      h('td', null, r.kind === 'local' && r.b.upstream ? `${r.b.ahead} / ${r.b.behind}` : ''),
      h('td', { title: b.subject }, b.subject), h('td', null, b.author), h('td', null, b.date ? fmtDate(b.date) : '')));
    };
    table.append(h('tr', { className: 'section' }, h('td', { colSpan: '7' }, svg(icons.folder), 'Branches de ce poste')));
    local.forEach((b) => row({ kind: 'local', b }));
    const others = remote.filter((b) => !b.tracked);
    table.append(h('tr', { className: 'section' }, h('td', { colSpan: '7' }, svg(icons.folder), 'Branches des dépôts distants (pas encore sur ce poste)')));
    if (!others.length) table.append(h('tr', null, h('td', { colSpan: '7', className: 'muted', style: 'padding:6px 10px' }, store.git.remotes.length ? 'Aucune — « Récupérer » pour actualiser.' : 'Aucun dépôt distant configuré.')));
    others.forEach((b) => row({ kind: 'remote', b }));
    list.append(table);
    const sel = [...local.map((b): Row => ({ kind: 'local', b })), ...others.map((b): Row => ({ kind: 'remote', b }))].find((r) => keyOf(r) === selected);
    renderToolbar(sel ?? null);
  };

  const renderToolbar = (sel: Row | null) => {
    clear(toolbar);
    const tb = (icon: IconName, label: string, run: () => void, enabled = true) =>
      h('button', { className: 'button', style: 'margin-right:6px;white-space:nowrap;flex:none', disabled: !enabled, onclick: run }, svg(icons[icon]), label);
    const g = store.git;
    toolbar.append(
      tb('add', 'Ma branche de travail...', () => void newBranchCmd(undefined, true).then(reload), !!g?.repo),
      tb('branch', 'Nouvelle branche...', () => void newBranchCmd(sel ? refOf(sel) : undefined).then(reload), !!g?.repo),
      tb('sync', 'Synchroniser', () => void syncCmd().then(reload), !!g?.repo),
      tb('download', 'Récupérer', () => void (async () => {
        try {
          await call('gitFetch', store.projectDir!);
          store.addMessage({ severity: 'ok', text: 'Branches des dépôts distants récupérées.' });
        } catch (e) {
          await alertDialog(TITLE, (e as Error).message, 'error');
        }
        await refreshGit();
        await load();
      })(), !!g?.remotes.length),
      h('span', { className: 'muted', style: 'margin-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' },
        sel ? 'Clic droit sur une branche pour basculer, fusionner, comparer ou supprimer.' : `Branche actuelle : ${g?.branch ?? '—'}`));
    if (sel && !(sel.kind === 'local' && sel.b.current)) {
      toolbar.append(h('span', { style: 'margin-left:auto;display:flex;flex:none' },
        tb('branch', 'Basculer', () => void switchBranchCmd(refOf(sel)).then(reload)),
        tb('sync', 'Fusionner dans l\'actuelle', () => void mergeIntoCurrentCmd(refOf(sel)).then(reload))));
    }
  };

  const load = async () => {
    if (store.git?.repo && store.projectDir) {
      try {
        ({ local, remote } = await call('gitBranches', store.projectDir));
      } catch {
        local = [];
        remote = [];
      }
    }
    render();
  };
  const off = store.on((topic) => { if (topic === 'git') void load(); });
  void load();
  return { element, icon: 'branch', title: () => TITLE, crumbs: () => ['Gestion de versions', TITLE], destroy: off, refresh: reload };
}

/** Opens the "Branches" editor. */
export function openBranchesCmd(): void {
  if (store.project) A.openEditor({ kind: 'branches' });
}
