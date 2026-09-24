// Version management of folder projects with Git (the git command-line tool installed on
// the engineering station). Every command runs in the project folder and is limited to
// it, so a project can also live inside a larger repository.
import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { projectFromFiles, isManagedPath, type ProjectFiles } from '../../../sdk/src/index.ts';

export interface GitChange {
  path: string;
  /** added, modified, deleted, renamed, untracked, conflict */
  status: 'A' | 'M' | 'D' | 'R' | '?' | 'U';
}

export interface GitStatus {
  available: boolean;
  version?: string;
  repo: boolean;
  /** No commit yet */
  empty?: boolean;
  branch?: string;
  upstream?: string;
  /** Remote used by "Synchroniser": the upstream's, else origin, else the only one */
  remote?: string;
  remoteUrl?: string;
  remotes: GitRemote[];
  ahead?: number;
  behind?: number;
  changes: GitChange[];
  /** Files with unresolved merge conflicts */
  conflicts: string[];
  merging?: boolean;
  user?: { name: string; email: string };
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  /** remote branch followed by this branch (origin/main) */
  upstream?: string;
  ahead: number;
  behind: number;
  /** the followed remote branch was deleted */
  gone: boolean;
  date: string;
  author: string;
  subject: string;
}

export interface GitRemoteBranch {
  /** origin/alice/convoyeur */
  ref: string;
  remote: string;
  /** alice/convoyeur */
  name: string;
  /** a local branch follows it */
  tracked: boolean;
  date: string;
  author: string;
  subject: string;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  tags: string[];
  /** branches pointing at this version (local and remote) */
  branches: string[];
  parents: string[];
}

export interface SyncResult {
  received: number;
  sent: number;
  conflicts: string[];
}

export class GitError extends Error {}

const NETWORK_TIMEOUT = 180_000;

function run(cwd: string, args: string[], opts: { timeout?: number; allowFail?: boolean } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, {
      cwd,
      timeout: opts.timeout ?? 60_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        // Never wait for a password on a terminal nobody sees: credential helpers
        // (Git Credential Manager, macOS keychain, SSH agent) are used instead.
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        LANG: 'C',
      },
    }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      if (e && e.code === 'ENOENT') {
        reject(new GitError("Git n'est pas installé sur ce poste (https://git-scm.com)."));
        return;
      }
      if (e?.killed) {
        reject(new GitError(`git ${args[0]} : délai dépassé`));
        return;
      }
      const code = e ? (typeof e.code === 'number' ? e.code : 1) : 0;
      if (code !== 0 && !opts.allowFail) {
        reject(new GitError(explain(args[0], String(stderr || stdout).trim())));
        return;
      }
      resolvePromise({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

/** Turns the usual git errors into messages an automation engineer can act on. */
function explain(command: string, message: string): string {
  if (/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)/i.test(message)) {
    return "Accès au dépôt refusé : configurez vos identifiants Git (Git Credential Manager, clé SSH) puis réessayez.\n\n" + message;
  }
  if (/Could not resolve host|unable to access|Connection (timed out|refused)/i.test(message)) {
    return 'Le serveur Git est injoignable. Vérifiez l\'adresse du dépôt et la connexion réseau.\n\n' + message;
  }
  if (/Please tell me who you are|empty ident/i.test(message)) {
    return 'Indiquez votre nom et votre e-mail (Options > Paramètres de gestion de versions).';
  }
  if (/non-fast-forward|fetch first|rejected/i.test(message)) {
    return 'Le dépôt de l\'équipe contient des versions que vous n\'avez pas encore : synchronisez à nouveau.\n\n' + message;
  }
  return `git ${command} : ${message}`;
}

export async function gitVersion(): Promise<string | null> {
  try {
    const { out } = await run(process.cwd(), ['--version']);
    return out.trim().replace(/^git version /, '');
  } catch {
    return null;
  }
}

async function isRepo(dir: string): Promise<boolean> {
  const { code, out } = await run(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  return code === 0 && out.trim() === 'true';
}

async function config(dir: string, key: string): Promise<string> {
  const { out } = await run(dir, ['config', '--get', key], { allowFail: true });
  return out.trim();
}

function parseStatus(out: string): Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'changes' | 'conflicts' | 'empty'> {
  const entries = out.split('\0');
  const changes: GitChange[] = [];
  const conflicts: string[] = [];
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let empty = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      const head = e.slice(3);
      const noCommits = /^(?:No commits yet|Initial commit) on (\S+)/.exec(head);
      if (noCommits) {
        empty = true;
        branch = noCommits[1];
        continue;
      }
      const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
      if (m) {
        branch = m[1] === 'HEAD (no branch)' ? undefined : m[1];
        upstream = m[2];
        ahead = Number(/ahead (\d+)/.exec(m[3] ?? '')?.[1] ?? 0);
        behind = Number(/behind (\d+)/.exec(m[3] ?? '')?.[1] ?? 0);
      }
      continue;
    }
    const xy = e.slice(0, 2);
    const path = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the original path follows
    if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(xy)) {
      conflicts.push(path);
      changes.push({ path, status: 'U' });
    } else if (xy === '??') changes.push({ path, status: '?' });
    else {
      const c = xy[0] !== ' ' ? xy[0] : xy[1];
      changes.push({ path, status: (c === 'A' || c === 'D' || c === 'R' ? c : 'M') as GitChange['status'] });
    }
  }
  return { branch, upstream, ahead, behind, changes, conflicts, empty };
}

export async function gitRemotes(dir: string): Promise<GitRemote[]> {
  const { out } = await run(dir, ['remote', '-v'], { allowFail: true });
  const remotes = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(.+?) \(fetch\)$/.exec(line.trim());
    if (m) remotes.set(m[1], m[2]);
  }
  return [...remotes].map(([name, url]) => ({ name, url }));
}

function syncRemote(upstream: string | undefined, remotes: GitRemote[]): GitRemote | undefined {
  const byName = (n?: string) => remotes.find((r) => r.name === n);
  return byName(upstream?.split('/')[0]) ?? byName('origin') ?? (remotes.length === 1 ? remotes[0] : undefined);
}

export async function gitStatus(dir: string): Promise<GitStatus> {
  const version = await gitVersion();
  if (!version) return { available: false, repo: false, changes: [], conflicts: [], remotes: [] };
  if (!(await isRepo(dir))) return { available: true, version, repo: false, changes: [], conflicts: [], remotes: [] };
  const { out } = await run(dir, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--', '.']);
  const s = parseStatus(out);
  // porcelain paths are relative to the repository root: make them relative to the project folder
  const prefix = (await run(dir, ['rev-parse', '--show-prefix'])).out.trim();
  const strip = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  s.changes = s.changes.map((c) => ({ ...c, path: strip(c.path) }));
  s.conflicts = s.conflicts.map(strip);
  const gitDir = (await run(dir, ['rev-parse', '--git-dir'])).out.trim();
  let merging = false;
  try {
    await stat(resolve(dir, gitDir, 'MERGE_HEAD'));
    merging = true;
  } catch {
    // no merge in progress
  }
  const remotes = await gitRemotes(dir);
  const remote = syncRemote(s.upstream, remotes);
  return {
    available: true, version, repo: true, ...s, merging, remotes,
    remote: remote?.name, remoteUrl: remote?.url,
    user: { name: await config(dir, 'user.name'), email: await config(dir, 'user.email') },
  };
}

export async function gitInit(dir: string): Promise<void> {
  if (await isRepo(dir)) return;
  await run(dir, ['init']);
  await run(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
}

/** Author of the versions archived from this project (stored in the repository). */
export async function gitSetUser(dir: string, name: string, email: string): Promise<void> {
  await run(dir, ['config', 'user.name', name]);
  await run(dir, ['config', 'user.email', email]);
}

/** Archives the current state of the project folder as a new version. Returns the commit, or null when nothing changed. */
export async function gitCommit(dir: string, message: string): Promise<string | null> {
  if (!message.trim()) throw new GitError('Saisissez un commentaire pour cette version.');
  await run(dir, ['add', '-A', '--', '.']);
  const staged = await run(dir, ['diff', '--cached', '--quiet', '--', '.'], { allowFail: true });
  const merging = (await gitStatus(dir)).merging;
  if (staged.code === 0 && !merging) return null;
  await run(dir, merging ? ['commit', '--no-edit', '-m', message] : ['commit', '-m', message, '--', '.']);
  return (await run(dir, ['rev-parse', 'HEAD'])).out.trim();
}

/** History of the current branch, or of every branch (all = true). */
export async function gitLog(dir: string, limit = 200, all = false): Promise<GitCommit[]> {
  const s = await gitStatus(dir);
  if (!s.repo || s.empty) return [];
  // Whole history (every engineer's versions, merges included), limited to the project folder when it is a sub-folder
  const prefix = (await run(dir, ['rev-parse', '--show-prefix'])).out.trim();
  const { out } = await run(dir, ['log', `--max-count=${limit}`, '--date=iso-strict', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1f%D%x1f%P%x1e',
    ...(all ? ['--branches', '--remotes', '--tags', '--date-order'] : []), ...(prefix ? ['--full-history', '--', '.'] : [])]);
  return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, short, author, email, date, subject, body, refs, parents] = r.split('\x1f');
    const list = (refs ?? '').split(', ').map((x) => x.trim()).filter(Boolean);
    const tags = list.filter((x) => x.startsWith('tag: ')).map((x) => x.slice(5));
    const branches = list.filter((x) => !x.startsWith('tag: ') && x !== 'HEAD' && !x.endsWith('/HEAD')).map((x) => x.replace(/^HEAD -> /, ''));
    return { hash, short, author, email, date, subject, body: (body ?? '').trim(), tags, branches, parents: (parents ?? '').trim().split(' ').filter(Boolean) };
  });
}

/** Marks a version (e.g. "V1.2 — mise en service site") with an annotated tag. */
export async function gitTag(dir: string, name: string, message: string, rev = 'HEAD'): Promise<void> {
  if (!/^[\w.-]+$/.test(name) || name.startsWith('-')) throw new GitError('Nom de version invalide (lettres, chiffres, . _ -).');
  await run(dir, ['tag', '-a', name, '-m', message || name, rev]);
}

/** Project as it was in a given version (read from Git, without touching the working folder). */
export async function gitProjectAt(dir: string, rev: string): Promise<string> {
  if (rev.startsWith('-')) throw new GitError('Version invalide');
  const { out } = await run(dir, ['ls-tree', '-r', '-z', '--name-only', rev, '--', '.']);
  const files: ProjectFiles = {};
  const paths = out.split('\0').filter((p) => p && isManagedPath(p));
  await Promise.all(paths.map(async (p) => {
    files[p] = (await run(dir, ['show', `${rev}:./${p}`])).out;
  }));
  return JSON.stringify(projectFromFiles(files));
}

/** Text differences of the project folder: working folder vs a version, or between two versions. */
export async function gitDiff(dir: string, from = 'HEAD', to?: string): Promise<string> {
  for (const r of [from, to]) if (r?.startsWith('-')) throw new GitError('Version invalide');
  await run(dir, ['add', '-A', '--intent-to-add', '--', '.'], { allowFail: true });
  const { out } = await run(dir, ['diff', '--no-color', '--find-renames', from, ...(to ? [to] : []), '--', '.']);
  return out;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkRemote(name: string, url?: string): void {
  if (!REMOTE_NAME.test(name)) throw new GitError(`Nom de dépôt invalide « ${name} » (lettres, chiffres, . _ -).`);
  if (url !== undefined && (!url.trim() || url.startsWith('-'))) throw new GitError('Adresse de dépôt invalide');
}

/** Sets the address of a remote, creating it if needed (default: origin). */
export async function gitSetRemote(dir: string, url: string, name = 'origin'): Promise<void> {
  checkRemote(name, url);
  const has = (await gitRemotes(dir)).some((r) => r.name === name);
  await run(dir, has ? ['remote', 'set-url', name, url.trim()] : ['remote', 'add', name, url.trim()]);
}

export async function gitAddRemote(dir: string, name: string, url: string): Promise<void> {
  checkRemote(name, url);
  if ((await gitRemotes(dir)).some((r) => r.name === name)) throw new GitError(`Le dépôt « ${name} » existe déjà.`);
  await run(dir, ['remote', 'add', name, url.trim()]);
}

export async function gitEditRemote(dir: string, name: string, newName: string, url: string): Promise<void> {
  checkRemote(newName, url);
  if (newName !== name) await run(dir, ['remote', 'rename', name, newName]);
  await run(dir, ['remote', 'set-url', newName, url.trim()]);
}

export async function gitRemoveRemote(dir: string, name: string): Promise<void> {
  checkRemote(name);
  await run(dir, ['remote', 'remove', name]);
}

/** Creates an empty shared repository (e.g. on a network share) that the team can use as remote. */
export async function gitCreateSharedRepo(path: string): Promise<string> {
  const target = resolve(path);
  try {
    if ((await readdir(target)).length) throw new GitError(`Le dossier ${target} existe déjà et n'est pas vide.`);
  } catch (e) {
    if (e instanceof GitError) throw e;
  }
  await mkdir(target, { recursive: true });
  await run(target, ['init', '--bare', '--shared=group']);
  await run(target, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return target;
}

/** Receives the branches and versions of every remote, without changing the project. */
export async function gitFetch(dir: string): Promise<void> {
  await run(dir, ['fetch', '--all', '--prune', '--tags'], { timeout: NETWORK_TIMEOUT });
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function gitBranches(dir: string): Promise<{ local: GitBranch[]; remote: GitRemoteBranch[] }> {
  const F = '%1f';
  const { out: lo } = await run(dir, ['for-each-ref', `--format=%(HEAD)${F}%(refname:short)${F}%(upstream:short)${F}%(upstream:track,nobracket)${F}%(committerdate:iso-strict)${F}%(authorname)${F}%(subject)`, 'refs/heads']);
  const local = lo.split('\n').filter(Boolean).map((line): GitBranch => {
    const [head, name, upstream, track, date, author, subject] = line.split('\x1f');
    return {
      name, current: head === '*', upstream: upstream || undefined,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0), gone: track === 'gone',
      date, author, subject,
    };
  });
  const tracked = new Set(local.map((b) => b.upstream).filter(Boolean));
  const remotes = (await gitRemotes(dir)).map((r) => r.name);
  const { out: ro } = await run(dir, ['for-each-ref', `--format=%(refname:short)${F}%(symref)${F}%(committerdate:iso-strict)${F}%(authorname)${F}%(subject)`, 'refs/remotes']);
  const remote = ro.split('\n').filter(Boolean).map((line) => line.split('\x1f')).filter(([ref, symref]) => !symref && !ref.endsWith('/HEAD')).map(([ref, , date, author, subject]): GitRemoteBranch => {
    const r = remotes.find((x) => ref.startsWith(`${x}/`)) ?? ref.split('/')[0];
    return { ref, remote: r, name: ref.slice(r.length + 1), tracked: tracked.has(ref), date, author, subject };
  });
  return { local, remote };
}

async function checkBranchName(dir: string, name: string): Promise<void> {
  if (!name.trim() || name.startsWith('-') || (await run(dir, ['check-ref-format', '--branch', name], { allowFail: true })).code !== 0) {
    throw new GitError(`Nom de branche invalide « ${name} » (pas d'espace ni de caractères spéciaux ; ex. alice/convoyeur).`);
  }
}

async function requireClean(dir: string, action: string): Promise<GitStatus> {
  const s = await gitStatus(dir);
  if (!s.repo) throw new GitError("Le projet n'est pas sous gestion de versions.");
  if (s.merging || s.conflicts.length) throw new GitError('Une fusion est en cours : résolvez les conflits ou annulez-la.');
  if (s.changes.length) throw new GitError(`Archivez vos modifications avant de ${action}.`);
  return s;
}

/** Creates a branch (from the current version or from `from`) and switches to it. */
export async function gitCreateBranch(dir: string, name: string, from?: string, switchTo = true): Promise<void> {
  await checkBranchName(dir, name);
  if (from?.startsWith('-')) throw new GitError('Version invalide');
  const s = await gitStatus(dir);
  if (s.empty) throw new GitError('Archivez une première version avant de créer une branche.');
  if (switchTo) {
    await requireClean(dir, 'changer de branche');
    await run(dir, ['switch', '--no-track', '-c', name, ...(from ? [from] : [])]);
  } else {
    await run(dir, ['branch', '--no-track', name, ...(from ? [from] : [])]);
  }
}

/** Switches to a local branch, or to a remote branch (a local branch following it is created). */
export async function gitSwitch(dir: string, name: string): Promise<void> {
  if (name.startsWith('-')) throw new GitError('Branche invalide');
  await requireClean(dir, 'changer de branche');
  const { local, remote } = await gitBranches(dir);
  if (local.some((b) => b.name === name)) {
    await run(dir, ['switch', name]);
    return;
  }
  const r = remote.find((b) => b.ref === name);
  if (!r) throw new GitError(`Branche inconnue « ${name} ».`);
  const existing = local.find((b) => b.upstream === r.ref || b.name === r.name);
  if (existing) await run(dir, ['switch', existing.name]);
  else await run(dir, ['switch', '-c', r.name, '--track', r.ref]);
}

/** Merges a branch (local or remote) into the current branch. */
export async function gitMergeBranch(dir: string, ref: string): Promise<{ merged: number; conflicts: string[] }> {
  if (ref.startsWith('-')) throw new GitError('Branche invalide');
  const s = await requireClean(dir, 'fusionner');
  const merged = Number((await run(dir, ['rev-list', '--count', `HEAD..${ref}`])).out.trim());
  if (!merged) return { merged: 0, conflicts: [] };
  const r = await run(dir, ['merge', '--no-edit', '-m', `Fusion de la branche ${ref} dans ${s.branch ?? 'HEAD'}`, ref], { allowFail: true });
  if (r.code !== 0) {
    const after = await gitStatus(dir);
    if (after.conflicts.length) return { merged, conflicts: after.conflicts };
    throw new GitError(explain('merge', (r.err || r.out).trim()));
  }
  return { merged, conflicts: [] };
}

/** Deletes a local branch; with `remote`, also deletes the branch it follows on the server. */
export async function gitDeleteBranch(dir: string, name: string, force = false, remote = false): Promise<void> {
  if (name.startsWith('-')) throw new GitError('Branche invalide');
  const { local, remote: remotes } = await gitBranches(dir);
  const b = local.find((x) => x.name === name);
  const r = b?.upstream ? remotes.find((x) => x.ref === b.upstream) : remotes.find((x) => x.ref === name);
  if (b) {
    if (b.current) throw new GitError('Impossible de supprimer la branche actuelle : basculez d\'abord sur une autre branche.');
    const res = await run(dir, ['branch', force ? '-D' : '-d', name], { allowFail: true });
    if (res.code !== 0) {
      if (/not fully merged/.test(res.err)) throw new GitError(`La branche « ${name} » contient des versions qui n'ont été fusionnées nulle part.`);
      throw new GitError(explain('branch', res.err.trim()));
    }
  }
  if (remote && r) await run(dir, ['push', r.remote, '--delete', r.name], { timeout: NETWORK_TIMEOUT });
  if (!b && !r) throw new GitError(`Branche inconnue « ${name} ».`);
}

/**
 * Synchronises with the team repository: receives the versions of the others (merge),
 * then sends the local versions. Stops on merge conflicts, which the user resolves file
 * by file (gitResolve) before calling gitSync again.
 */
export async function gitSync(dir: string, remoteName?: string): Promise<SyncResult> {
  const s = await gitStatus(dir);
  if (!s.repo) throw new GitError("Le projet n'est pas sous gestion de versions.");
  const remote = remoteName ?? s.remote;
  if (!remote || !s.remotes.some((r) => r.name === remote)) {
    throw new GitError(s.remotes.length ? 'Choisissez le dépôt distant avec lequel synchroniser cette branche.' : "Aucun dépôt d'équipe n'est configuré (adresse du dépôt).");
  }
  if (s.merging || s.conflicts.length) throw new GitError('Une fusion est en cours : résolvez les conflits ou annulez la synchronisation.');
  if (s.empty) throw new GitError('Archivez une première version avant de synchroniser.');
  if (s.changes.length) throw new GitError('Archivez vos modifications avant de synchroniser.');
  const branch = s.branch ?? 'main';
  await run(dir, ['fetch', '--prune', remote], { timeout: NETWORK_TIMEOUT });
  // the followed branch, or the branch of the same name on the remote
  const remoteRef = s.upstream && s.upstream.startsWith(`${remote}/`) ? `refs/remotes/${s.upstream}` : `refs/remotes/${remote}/${branch}`;
  const hasRemoteBranch = (await run(dir, ['rev-parse', '--verify', '--quiet', remoteRef], { allowFail: true })).code === 0;
  let received = 0;
  if (hasRemoteBranch) {
    received = Number((await run(dir, ['rev-list', '--count', `HEAD..${remoteRef}`])).out.trim());
    if (received > 0) {
      const merge = await run(dir, ['merge', '--no-edit', '-m', `Fusion des modifications de l'équipe (${branch})`, remoteRef], { allowFail: true });
      if (merge.code !== 0) {
        const after = await gitStatus(dir);
        if (after.conflicts.length) return { received, sent: 0, conflicts: after.conflicts };
        throw new GitError(explain('merge', (merge.err || merge.out).trim()));
      }
    }
  }
  // versions the remote does not have yet (a new branch only sends what is not on any of its branches)
  const sent = Number((await run(dir, ['rev-list', '--count', ...(hasRemoteBranch ? [`${remoteRef}..HEAD`] : ['HEAD', '--not', `--remotes=${remote}`])])).out.trim());
  const publish = sent > 0 || !hasRemoteBranch;
  const target = remoteRef.slice(`refs/remotes/${remote}/`.length);
  if (publish) await run(dir, ['push', '--follow-tags', '-u', remote, `HEAD:refs/heads/${target}`], { timeout: NETWORK_TIMEOUT });
  else if (!s.upstream && hasRemoteBranch) await run(dir, ['branch', '--set-upstream-to', `${remote}/${target}`], { allowFail: true });
  return { received, sent, conflicts: [] };
}

/** Resolves a conflicting file by keeping one side: 'mine' (local version) or 'theirs' (team version). */
export async function gitResolve(dir: string, path: string, side: 'mine' | 'theirs'): Promise<void> {
  if (path.startsWith('-')) throw new GitError('Chemin invalide');
  const stages = (await run(dir, ['ls-files', '-u', '--', path])).out;
  const stage = side === 'mine' ? 2 : 3;
  if (new RegExp(`^\\d+ [0-9a-f]+ ${stage}\\t`, 'm').test(stages)) {
    await run(dir, ['checkout', side === 'mine' ? '--ours' : '--theirs', '--', path]);
    await run(dir, ['add', '--', path]);
  } else {
    // this side deleted the file
    await run(dir, ['rm', '--quiet', '--', path]);
  }
}

/** Finishes a merge once every conflict is resolved. */
export async function gitFinishMerge(dir: string): Promise<void> {
  const s = await gitStatus(dir);
  if (s.conflicts.length) throw new GitError(`Conflits non résolus : ${s.conflicts.join(', ')}`);
  if (s.merging) await run(dir, ['commit', '-m', "Fusion des modifications de l'équipe (conflits résolus)"]);
}

export async function gitAbortMerge(dir: string): Promise<void> {
  await run(dir, ['merge', '--abort']);
}

/** Retrieves a project from a team repository into <parent>/<repository name>. Returns the folder. */
export async function gitClone(url: string, parent: string): Promise<string> {
  if (url.startsWith('-')) throw new GitError('Adresse de dépôt invalide');
  const name = basename(url.replace(/[/\\]+$/, '')).replace(/\.git$/, '') || 'projet';
  const target = join(resolve(parent), name);
  try {
    if ((await readdir(target)).length) throw new GitError(`Le dossier ${target} existe déjà et n'est pas vide.`);
  } catch (e) {
    if (e instanceof GitError) throw e;
  }
  await mkdir(parent, { recursive: true });
  await run(resolve(parent), ['clone', '--', url, target], { timeout: NETWORK_TIMEOUT });
  // The default branch of the server may not exist (e.g. a new bare repository): take main or the first branch
  if ((await run(target, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).code !== 0) {
    const branches = (await run(target, ['branch', '-r', '--format=%(refname:short)'])).out.split('\n').map((b) => b.trim()).filter((b) => b && !b.endsWith('/HEAD'));
    const pick = branches.find((b) => b === 'origin/main') ?? branches.find((b) => b === 'origin/master') ?? branches[0];
    if (pick) await run(target, ['checkout', '-B', pick.replace(/^origin\//, ''), '--track', pick]);
  }
  return target;
}

/** Writes a .zip archive of the project as it was in a version. */
export async function gitArchive(dir: string, rev: string, output: string): Promise<void> {
  if (rev.startsWith('-')) throw new GitError('Version invalide');
  const prefix = (await run(dir, ['rev-parse', '--show-prefix'])).out.trim();
  await run(dir, ['archive', '--format=zip', `--output=${resolve(output)}`, `${rev}:${prefix}`]);
}
