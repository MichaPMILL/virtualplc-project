// Security baseline end to end: user accounts and roles, lockout, audit trail (chained, signed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, DeviceClient, verifyAudit, type AuditRecord } from '../src/index.ts';

const CPU = new URL('../../runtime/build/vplc-cpu', import.meta.url).pathname;
const skip = existsSync(CPU) ? false : 'build runtime/ first';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function addUser(dir: string, name: string, role: string, password: string): void {
  execFileSync(CPU, ['--data', dir, '--name', 'Cell4', '--add-user', name, '--role', role], { input: `${password}\n` });
}

async function login(port: number, user?: string, password?: string): Promise<DeviceClient> {
  const c = new DeviceClient('127.0.0.1', port);
  try {
    await c.connect(password, user);
  } catch (e) {
    c.close();
    throw e;
  }
  return c;
}

test('security: roles, lockout, user management and signed audit trail', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vplc-sec-'));
  assert.throws(() => addUser(dir, 'admin', 'admin', 'short'), /Command failed/);
  addUser(dir, 'admin', 'admin', 'Adm1n-Passw0rd');
  addUser(dir, 'op', 'operator', 'Operat0r-Pass');
  assert.equal(statSync(join(dir, 'users')).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(join(dir, 'users'), 'utf8'), /Adm1n-Passw0rd/);

  const port = await freePort();
  const cpu: ChildProcess = spawn(CPU, ['--data', dir, '--listen', '127.0.0.1', '--port', String(port), '--name', 'Cell4'], { stdio: 'ignore' });
  try {
    let admin: DeviceClient | null = null;
    for (let i = 0; !admin; i++) {
      try {
        admin = await login(port, 'admin', 'Adm1n-Passw0rd');
      } catch (e) {
        if (i > 50) throw e;
        await sleep(100);
      }
    }
    const info = await admin.info();
    assert.equal(info.auth, true);
    assert.equal(info.users, true);

    // Engineer actions with the admin account
    const r = compile({ sources: [{ file: 'main.scl', text: 'VAR_GLOBAL n : DInt; END_VAR\nORGANIZATION_BLOCK "Main"\nBEGIN\n  n := n + 1;\nEND_ORGANIZATION_BLOCK' }] });
    assert.equal(r.ok, true);
    await admin.download(r.image!);
    await admin.start();

    // Without credentials: refused; wrong password: refused
    await assert.rejects(login(port), /user name and a password/);
    await assert.rejects(login(port, 'op', 'wrong'), /wrong user name or password/);

    // Operator: may start / stop and write, may not download nor force nor manage users
    const op = await login(port, 'op', 'Operat0r-Pass');
    await op.stop();
    await op.start();
    await assert.rejects(op.download(r.image!), /access denied: the role 'operator'/);
    await assert.rejects(op.setUser('eve', 'Some-Passw0rd', 'admin'), /only an administrator/);
    assert.deepEqual((await op.users()).users.map((u) => u.name), ['op']);
    await assert.rejects(op.changePassword('bad', 'N3w-Operator-Pass'), /wrong current password/);
    await op.changePassword('Operat0r-Pass', 'N3w-Operator-Pass');
    op.close();

    // Administrator: user management, password policy, last admin protected
    await assert.rejects(admin.setUser('viewer1', 'abcdefghij', 'viewer'), /3 kinds/);
    await admin.setUser('viewer1', 'View-only-123', 'viewer');
    assert.deepEqual((await admin.users()).users.map((u) => `${u.name}:${u.role}`), ['admin:admin', 'op:operator', 'viewer1:viewer']);
    await assert.rejects(admin.deleteUser('admin'), /last administrator/);
    const viewer = await login(port, 'viewer1', 'View-only-123');
    assert.equal((await viewer.state()).state, 'RUN');
    await assert.rejects(viewer.stop(), /access denied/);
    viewer.close();
    await admin.deleteUser('viewer1');

    // Lockout after 5 failures in a row (even with the right password afterwards)
    for (let k = 0; k < 5; k++) await assert.rejects(login(port, 'op', 'nope'), /wrong user name/);
    await assert.rejects(login(port, 'op', 'N3w-Operator-Pass'), /too many failed attempts/);

    // Audit trail: complete, chained, signed by the CPU
    const audit = await admin.auditReadAll();
    assert.ok((await admin.auditRead(3)).records.length === 3);
    const actions = audit.records.map((a) => `${a.user}:${a.action}`);
    for (const a of ['root:user set', 'admin:login', 'admin:download', 'admin:start', 'op:login failed', 'op:stop', 'op:denied', 'op:password changed', 'admin:user set', 'admin:user deleted', 'op:lockout']) {
      assert.ok(actions.includes(a), `${a} missing in ${actions.join(', ')}`);
    }
    assert.match(audit.records.find((a) => a.action === 'login')!.peer, /^127\.0\.0\.1:\d+$/);
    assert.equal(audit.records[0].seq, 1);
    const ok = await verifyAudit({ plc: 'Cell4', records: audit.records, publicKey: audit.key });
    assert.deepEqual(ok, { ok: true, verified: audit.records.length });
    // Tampering is detected (the file on disk: record 3 changed)
    const lines = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as AuditRecord);
    lines[2].user = 'someone-else';
    assert.equal((await verifyAudit({ plc: 'Cell4', records: lines, publicKey: audit.key })).brokenAt, 3);
    const removed = lines.filter((l) => l.seq !== 2);
    assert.match((await verifyAudit({ plc: 'Cell4', records: removed })).reason!, /record 2 is missing/);
    admin.close();
  } finally {
    cpu.kill();
  }
});

test('security: single CPU password keeps working (admin role)', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vplc-sec-'));
  const pw = join(dir, 'pw');
  writeFileSync(pw, 'Legacy-Pass-1\n');
  const port = await freePort();
  const cpu = spawn(CPU, ['--data', dir, '--listen', '127.0.0.1', '--port', String(port), '--password-file', pw], { stdio: 'ignore' });
  try {
    let c: DeviceClient | null = null;
    for (let i = 0; !c; i++) {
      try {
        c = await login(port, undefined, 'Legacy-Pass-1');
      } catch (e) {
        if (i > 50) throw e;
        await sleep(100);
      }
    }
    const info = await c.info();
    assert.equal(info.users, false);
    await c.stop();
    const audit = await c.auditRead();
    assert.ok(audit.records.some((a) => a.user === 'admin' && a.action === 'stop'));
    c.close();
  } finally {
    cpu.kill();
  }
});
