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
  remoteUrl?: string;
  ahead?: number;
  behind?: number;
  changes: GitChange[];
  /** Files with unresolved merge conflicts */
  conflicts: string[];
  merging?: boolean;
  user?: { name: string; email: string };
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

export async function gitStatus(dir: string): Promise<GitStatus> {
  const version = await gitVersion();
  if (!version) return { available: false, repo: false, changes: [], conflicts: [] };
  if (!(await isRepo(dir))) return { available: true, version, repo: false, changes: [], conflicts: [] };
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
  const remote = s.upstream?.split('/')[0] ?? 'origin';
  return {
    available: true, version, repo: true, ...s, merging,
    remoteUrl: (await config(dir, `remote.${remote}.url`)) || undefined,
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

export async function gitLog(dir: string, limit = 200): Promise<GitCommit[]> {
  const s = await gitStatus(dir);
  if (!s.repo || s.empty) return [];
  // Whole history (every engineer's versions, merges included), limited to the project folder when it is a sub-folder
  const prefix = (await run(dir, ['rev-parse', '--show-prefix'])).out.trim();
  const { out } = await run(dir, ['log', `--max-count=${limit}`, '--date=iso-strict', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%b%x1f%D%x1f%P%x1e',
    ...(prefix ? ['--full-history', '--', '.'] : [])]);
  return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, short, author, email, date, subject, body, refs, parents] = r.split('\x1f');
    const tags = (refs ?? '').split(', ').filter((x) => x.startsWith('tag: ')).map((x) => x.slice(5).trim());
    return { hash, short, author, email, date, subject, body: (body ?? '').trim(), tags, parents: (parents ?? '').trim().split(' ').filter(Boolean) };
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

export async function gitSetRemote(dir: string, url: string): Promise<void> {
  if (url.startsWith('-')) throw new GitError('Adresse de dépôt invalide');
  const has = (await run(dir, ['remote'], { allowFail: true })).out.split('\n').includes('origin');
  await run(dir, has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
}

/**
 * Synchronises with the team repository: receives the versions of the others (merge),
 * then sends the local versions. Stops on merge conflicts, which the user resolves file
 * by file (gitResolve) before calling gitSync again.
 */
export async function gitSync(dir: string): Promise<SyncResult> {
  const s = await gitStatus(dir);
  if (!s.repo) throw new GitError("Le projet n'est pas sous gestion de versions.");
  if (!s.remoteUrl) throw new GitError("Aucun dépôt d'équipe n'est configuré (adresse du dépôt).");
  if (s.merging || s.conflicts.length) throw new GitError('Une fusion est en cours : résolvez les conflits ou annulez la synchronisation.');
  if (s.empty) throw new GitError('Archivez une première version avant de synchroniser.');
  if (s.changes.length) throw new GitError('Archivez vos modifications avant de synchroniser.');
  const branch = s.branch ?? 'main';
  await run(dir, ['fetch', '--prune', 'origin'], { timeout: NETWORK_TIMEOUT });
  const remoteRef = `refs/remotes/origin/${branch}`;
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
  const sent = Number((await run(dir, ['rev-list', '--count', hasRemoteBranch ? `${remoteRef}..HEAD` : 'HEAD'])).out.trim());
  if (sent > 0) await run(dir, ['push', '--follow-tags', '-u', 'origin', branch], { timeout: NETWORK_TIMEOUT });
  else if (!s.upstream) await run(dir, ['branch', '--set-upstream-to', `origin/${branch}`], { allowFail: true });
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
