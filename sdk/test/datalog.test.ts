// Traceability end to end: vplc-cpu writes the data logs to its local SQLite database and
// forwards them to PostgreSQL / MariaDB; the customer checks the hash chain.
// PostgreSQL / MySQL parts run when VPLC_TEST_PG / VPLC_TEST_MYSQL are set, e.g.
//   VPLC_TEST_PG=postgresql://plc:secret@127.0.0.1:5432/trace
//   VPLC_TEST_MYSQL=mysql://plc:secret@127.0.0.1:3306/trace
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, DeviceClient, secretKey, verifyTrace, type DataLog, type TraceKind } from '../src/index.ts';

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

function parseUrl(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) };
}

const PROGRAM = `
VAR_GLOBAL
  count : DInt; temp : Real; even : Bool; lot : String[20] := 'lot-A'; done : Bool;
END_VAR
ORGANIZATION_BLOCK "Main"
BEGIN
  count := count + 1;
  temp := DINT_TO_REAL(count) / 4.0;
  even := (count MOD 2) = 0;
  IF count MOD 10 = 0 THEN
    DATALOG_WRITE('Products');
  END_IF;
  done := (count MOD 7) = 0;
END_ORGANIZATION_BLOCK`;

async function withCpu(logs: DataLog[], fn: (c: DeviceClient, r: ReturnType<typeof compile>, dir: string) => Promise<void>): Promise<void> {
  const r = compile({ sources: [{ file: 'main.scl', text: PROGRAM }], cycleMs: 10, dataLogs: logs });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const dir = mkdtempSync(join(tmpdir(), 'vplc-trace-'));
  const port = await freePort();
  const cpu: ChildProcess = spawn(CPU, ['--data', dir, '--listen', '127.0.0.1', '--port', String(port), '--name', 'Line1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  cpu.stdout!.on('data', (d) => (output += d));
  cpu.stderr!.on('data', (d) => (output += d));
  const client = new DeviceClient('127.0.0.1', port);
  try {
    for (let i = 0; ; i++) {
      try {
        await client.connect();
        break;
      } catch (e) {
        if (i > 50) throw e;
        await sleep(100);
      }
    }
    await fn(client, r, dir);
  } catch (e) {
    throw new Error(`${(e as Error).message}\n--- CPU output ---\n${output}`);
  } finally {
    client.close();
    cpu.kill();
  }
}

test('traceability: local records, triggers, hash chain', { skip }, async () => {
  const logs: DataLog[] = [
    { id: '1', name: 'Products', trigger: { kind: 'program' }, columns: [{ name: 'count', tag: 'count' }, { name: 'temp', tag: 'temp' }, { name: 'even', tag: 'even' }, { name: 'lot', tag: 'lot' }] },
    { id: '2', name: 'Sevens', trigger: { kind: 'edge', tag: 'done' }, columns: [{ name: 'count', tag: 'count' }] },
    { id: '3', name: 'Periodic', trigger: { kind: 'period', ms: 100 }, columns: [{ name: 'count', tag: 'count' }] },
  ];
  await withCpu(logs, async (client, r) => {
    await client.download(r.image!);
    await client.start(true);
    await sleep(1500);
    const products = await client.dataLogRead(0, 50);
    assert.deepEqual(products.columns, ['count', 'temp', 'even', 'lot']);
    assert.ok(products.records! >= 10, `records ${products.records}`);
    const row = products.rows![0];
    assert.equal(Number(row[2]) % 10, 0, 'recorded by DATALOG_WRITE every 10 scans');
    assert.equal(row[3], Number(row[2]) / 4);
    assert.equal(row[4], true);
    assert.equal(row[5], 'lot-A');
    const sevens = await client.dataLogRead(1, 50);
    for (const x of sevens.rows!) assert.equal(Number(x[2]) % 7, 0, 'rising edge of done');
    const periodic = await client.dataLogRead(2, 50);
    assert.ok(periodic.records! >= 10 && periodic.records! <= 17, `periodic ${periodic.records}`);
    assert.equal(products.plc, 'Line1');
  });
});

for (const kind of ['postgresql', 'mysql'] as const) {
  const url = kind === 'postgresql' ? process.env.VPLC_TEST_PG : process.env.VPLC_TEST_MYSQL;
  test(`traceability: forwarding to ${kind}, exactly once, customer-side verification`, { skip: skip || (!url && `set VPLC_TEST_${kind === 'postgresql' ? 'PG' : 'MYSQL'}`) }, async () => {
    const db = parseUrl(url!);
    const table = `trace_${Date.now()}`;
    const destination = { kind, host: db.host, port: db.port, database: db.database, table, user: db.user, tls: 'require' as const };
    const logs: DataLog[] = [{
      id: '1', name: 'Products', trigger: { kind: 'program' }, destination,
      columns: [{ name: 'count', tag: 'count' }, { name: 'temp', tag: 'temp' }, { name: 'even', tag: 'even' }, { name: 'lot', tag: 'lot' }],
    }];
    const sql = (query: string): string[][] => {
      const out = kind === 'postgresql'
        ? execFileSync('psql', ['-h', db.host, '-p', String(db.port), '-U', db.user, '-d', db.database, '-At', '-F', '\t', '-c', query], { env: { ...process.env, PGPASSWORD: db.password } })
        : execFileSync('mysql', ['-h', db.host, '-P', String(db.port), '-u', db.user, `-p${db.password}`, '-N', '-B', db.database, '-e', query]);
      return out.toString().trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
    };
    await withCpu(logs, async (client, r) => {
      await client.download(r.image!);
      await client.start(true);
      await sleep(800);
      let st = await client.dataLogRead(0, 0);
      assert.equal(st.connected, false, 'no password yet');
      assert.ok((st.pending ?? 0) > 0, 'records kept locally while the database is unreachable');
      await client.setSecret(secretKey(destination), db.password);
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        st = await client.dataLogRead(0, 0);
        if (st.connected && (st.forwarded ?? 0) > 0) break;
      }
      assert.equal(st.connected, true, st.error);
      // the CPU stops producing records: everything is forwarded
      await client.stop();
      for (let i = 0; i < 50; i++) {
        await sleep(200);
        st = await client.dataLogRead(0, 0);
        if (st.pending === 0) break;
      }
      assert.equal(st.pending, 0, JSON.stringify(st));
      const q = (c: string) => (kind === 'postgresql' ? `"${c}"` : `\`${c}\``);
      const rows = sql(`SELECT ${q('record_id')}, ${q('ts_ns')}, ${q('count')}, ${q('temp')}, ${q('even')}, ${q('lot')}, ${q('chain')}, ${q('plc')}, ${q('epoch')} FROM ${q(table)} ORDER BY ${q('record_id')}`);
      assert.equal(rows.length, st.records, 'every record forwarded exactly once');
      const kinds: TraceKind[] = ['int', 'real', 'bool', 'text'];
      const records = rows.map((x) => ({ recordId: x[0], tsNs: x[1], values: [x[2], Number(x[3]), x[4] === 't' || x[4] === '1', x[5]], chain: x[6] }));
      const good = await verifyTrace({ plc: rows[0][7], log: 'Products', epoch: rows[0][8], kinds, records });
      assert.deepEqual(good, { ok: true, verified: rows.length });
      // someone changes a value in the database: detected
      const tampered = records.map((x, i) => (i === 2 ? { ...x, values: [x.values[0], 999.5, x.values[2], x.values[3]] } : x));
      const bad = await verifyTrace({ plc: rows[0][7], log: 'Products', epoch: rows[0][8], kinds, records: tampered });
      assert.equal(bad.ok, false);
      assert.equal(bad.brokenAt, records[2].recordId);
      // a record removed: detected
      const missing = await verifyTrace({ plc: rows[0][7], log: 'Products', epoch: rows[0][8], kinds, records: records.filter((_, i) => i !== 1) });
      assert.equal(missing.ok, false);
    });
  });
}

test('traceability: TLS verify refuses an untrusted server certificate', { skip: skip || (!process.env.VPLC_TEST_PG && 'set VPLC_TEST_PG') }, async () => {
  const db = parseUrl(process.env.VPLC_TEST_PG!);
  const destination = { kind: 'postgresql' as const, host: db.host, port: db.port, database: db.database, table: 'trace_verify', user: db.user, tls: 'verify' as const };
  await withCpu([{ id: '1', name: 'Products', trigger: { kind: 'program' }, destination, columns: [{ name: 'count', tag: 'count' }] }], async (client, r) => {
    await client.download(r.image!);
    await client.start(true);
    await client.setSecret(secretKey(destination), db.password);
    let st = await client.dataLogTest(0);
    for (let i = 0; i < 25 && !st.error; i++) {
      await sleep(200);
      st = await client.dataLogRead(0, 0);
    }
    assert.equal(st.connected, false);
    assert.match(st.error ?? '', /certificate/i);
  });
});
