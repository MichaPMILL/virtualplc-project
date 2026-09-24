// Team work scenario with Git: two engineers share a project through a team repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../src/backend/api.ts';
import { loadProject, newProject, type Project } from '../../sdk/src/index.ts';

const api = createApi();
const root = mkdtempSync(join(tmpdir(), 'vplc-git-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

const load = (json: string) => loadProject(json);
const edit = (p: Project, fn: (p: Project) => void) => {
  fn(p);
  return JSON.stringify(p);
};

test('two engineers work on the same project through a team repository', async () => {
  const remote = join(root, 'team.git');
  execFileSync('git', ['init', '--bare', '-q', remote]);

  // Alice creates the project, puts it under version control and shares it
  const created = newProject('Station');
  created.devices[0].blocks[0].code = '"Lamp" := "Start";';
  created.devices[0].tagTables[0].tags.push({ name: 'Start', dataType: 'Bool', address: '%I0.0' }, { name: 'Lamp', dataType: 'Bool', address: '%Q0.0' });
  const alice = await api.projectSaveAs(join(root, 'alice', 'Station.vplcproj'), JSON.stringify(created), 'Station');
  const aliceDir = alice.dir!;
  assert.ok(existsSync(join(aliceDir, 'devices/PLC_1/blocks/Main.scl')));
  await api.gitInit(aliceDir);
  await api.gitSetUser(aliceDir, 'Alice', 'alice@example.com');
  assert.equal((await api.gitStatus(aliceDir)).empty, true);
  assert.ok(await api.gitCommit(aliceDir, 'Première version'));
  assert.equal(await api.gitCommit(aliceDir, 'Rien'), null, 'nothing to archive');
  await api.gitSetRemote(aliceDir, remote);
  assert.deepEqual(await api.gitSync(aliceDir), { received: 0, sent: 1, conflicts: [] });
  await api.gitTag(aliceDir, 'V1.0', 'Mise en service');

  // Bob retrieves it
  const bob = await api.gitClone(remote, join(root, 'bob'));
  const bobDir = bob.dir!;
  await api.gitSetUser(bobDir, 'Bob', 'bob@example.com');
  assert.equal(load(bob.json).devices[0].blocks[0].code, '"Lamp" := "Start";');

  // Both change different objects: Git merges them automatically
  let pa = load((await api.projectOpen(alice.path)).json);
  await api.projectSave(alice.path, edit(pa, (p) => p.devices[0].tagTables[0].tags.push({ name: 'Stop', dataType: 'Bool', address: '%I0.1' })), 'folder');
  await api.gitCommit(aliceDir, 'Ajout du bouton Stop');
  await api.gitSync(aliceDir);

  let pb = load(bob.json);
  await api.projectSave(bob.path, edit(pb, (p) => { p.devices[0].blocks[0].code = '"Lamp" := "Start" AND NOT "Stop";'; }), 'folder');
  assert.deepEqual((await api.gitStatus(bobDir)).changes, [{ path: 'devices/PLC_1/blocks/Main.scl', status: 'M' }]);
  await api.gitCommit(bobDir, 'Arrêt prioritaire');
  const sync = await api.gitSync(bobDir);
  assert.deepEqual(sync, { received: 1, sent: 2, conflicts: [] }, 'received Alice\'s version, sent his own and the merge');
  pb = load((await api.projectOpen(bob.path)).json);
  assert.equal(pb.devices[0].tagTables[0].tags.length, 3);
  assert.equal(pb.devices[0].blocks[0].code, '"Lamp" := "Start" AND NOT "Stop";');

  // History, old versions and archives
  const log = await api.gitLog(bobDir);
  assert.deepEqual(log.map((c) => c.author).slice(1), ['Bob', 'Alice', 'Alice']);
  const first = log[log.length - 1];
  assert.deepEqual(first.tags, ['V1.0']);
  assert.equal(load(await api.gitProjectAt(bobDir, 'V1.0')).devices[0].tagTables[0].tags.length, 2);
  assert.match(await api.gitDiff(bobDir, 'V1.0', 'HEAD'), /\+"Lamp" := "Start" AND NOT "Stop";/);
  const zip = join(root, 'v1.zip');
  await api.gitArchive(bobDir, 'V1.0', zip);
  assert.equal(readFileSync(zip).subarray(0, 2).toString(), 'PK');

  // Both change the same block: conflict, resolved file by file
  await api.gitSync(aliceDir);
  pa = load((await api.projectOpen(alice.path)).json);
  await api.projectSave(alice.path, edit(pa, (p) => { p.devices[0].blocks[0].code = '"Lamp" := TRUE;'; }), 'folder');
  await api.gitCommit(aliceDir, 'Test lampe');
  await api.gitSync(aliceDir);
  pb = load((await api.projectOpen(bob.path)).json);
  await api.projectSave(bob.path, edit(pb, (p) => { p.devices[0].blocks[0].code = '"Lamp" := FALSE;'; }), 'folder');
  await api.gitCommit(bobDir, 'Lampe éteinte');
  const conflict = await api.gitSync(bobDir);
  assert.deepEqual(conflict.conflicts, ['devices/PLC_1/blocks/Main.scl']);
  await assert.rejects(api.projectOpen(bob.path), /Main\.scl: unresolved merge conflict/);
  await api.gitResolve(bobDir, 'devices/PLC_1/blocks/Main.scl', 'theirs');
  await api.gitFinishMerge(bobDir);
  assert.deepEqual(await api.gitSync(bobDir), { received: 0, sent: 2, conflicts: [] });
  assert.equal(load((await api.projectOpen(bob.path)).json).devices[0].blocks[0].code, '"Lamp" := TRUE;');
});

test('renaming and deleting objects removes their old files', async () => {
  const p = newProject('Renames');
  const saved = await api.projectSaveAs(join(root, 'ren', 'Renames.vplcproj'), JSON.stringify(p), 'Renames');
  p.devices[0].blocks[0].name = 'Principal';
  p.devices[0].watchTables = [];
  await api.projectSave(saved.path, JSON.stringify(p), 'folder');
  const dir = saved.dir!;
  assert.ok(existsSync(join(dir, 'devices/PLC_1/blocks/Principal.scl')));
  assert.ok(!existsSync(join(dir, 'devices/PLC_1/blocks/Main.scl')));
  assert.ok(!existsSync(join(dir, 'devices/PLC_1/watch')));
});

test('status tells when git is not a repository', async () => {
  const p = newProject('Plain');
  const saved = await api.projectSaveAs(join(root, 'plain', 'x.vplcproj'), JSON.stringify(p), 'Plain');
  const s = await api.gitStatus(saved.dir!);
  assert.equal(s.available, true);
  assert.equal(s.repo, false);
});
