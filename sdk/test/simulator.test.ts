// Simulated CPU (WebAssembly build of the CPU core) driven through the device protocol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { compile } from '../src/compiler.ts';
import { DeviceClient } from '../src/device.ts';
import { findSymbol } from '../src/symbols.ts';

const wasm = new URL('../wasm/vplc-sim.wasm', import.meta.url);
const skip = existsSync(wasm) ? false : 'build runtime/wasm first (runtime/wasm/build.sh)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('simulated CPU: download, run in real time, simulated inputs, monitoring', { skip }, async () => {
  const dir = new URL('../../examples/traffic-lights/', import.meta.url);
  const text = readdirSync(dir).filter((f) => f.endsWith('.scl')).sort().map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  // short timings: flash 5 s -> 300 ms, all red 2 s -> 200 ms
  const fast = text.replace('StartupFlash : Time := T#5S', 'StartupFlash : Time := T#300MS').replace('AllRed : Time := T#2S', 'AllRed : Time := T#200MS');
  const r = compile({ sources: [{ file: 'traffic.scl', text: fast }], cycleMs: 10 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const sym = (p: string) => findSymbol(r.symbols, p)!;

  const client = new DeviceClient('simulation');
  const info = await client.connect();
  assert.equal(info.device, 'simulator');
  await client.download(r.image!);
  await client.start(true);
  let s = await client.state();
  assert.equal(s.state, 'RUN');
  assert.equal(s.programId, r.programId);

  const bit = async (area: 'I' | 'Q', name: string) => {
    const x = sym(name);
    const [b] = await client.read([{ area, offset: x.offset, length: 1 }]);
    return ((b[0] >> x.bit!) & 1) === 1;
  };
  await sleep(300);
  assert.equal(await bit('Q', 'H_Main_Green'), false, 'switched off: flashing amber');
  // simulated input: S_On
  const on = sym('S_On');
  await client.writeSymbol(on, true);
  await sleep(900);
  assert.equal(await bit('Q', 'H_Main_Green'), true, 'main road green after flash + all red');
  s = await client.state();
  assert.ok(s.scanUs !== undefined);
  client.close();

  // a second connection sees the same CPU (the program is kept)
  const again = new DeviceClient('simulation');
  await again.connect();
  assert.equal((await again.state()).programId, r.programId);
  again.close();
});

test('simulated CPU: data logs kept in memory', { skip }, async () => {
  const text = `VAR_GLOBAL n : DInt; t : Real; s : String[10] := 'abc'; END_VAR
    ORGANIZATION_BLOCK "Main" BEGIN n := n + 1; t := DINT_TO_REAL(n) / 2.0; IF n MOD 5 = 0 THEN DATALOG_WRITE('Lot'); END_IF; END_ORGANIZATION_BLOCK`;
  const r = compile({ sources: [{ file: 'a.scl', text }], cycleMs: 10, dataLogs: [{ id: '1', name: 'Lot', trigger: { kind: 'program' }, columns: [{ name: 'n', tag: 'n' }, { name: 't', tag: 't' }, { name: 's', tag: 's' }] }] });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const client = new DeviceClient('simulation');
  await client.connect();
  await client.download(r.image!);
  await client.start(true);
  await sleep(600);
  const st = await client.dataLogRead(0, 5);
  client.close();
  assert.deepEqual(st.columns, ['n', 't', 's']);
  assert.deepEqual(st.kinds, ['int', 'real', 'text']);
  assert.ok(st.records! >= 5, `records ${st.records}`);
  const row = st.rows![0];
  assert.equal(Number(row[2]) % 5, 0);
  assert.equal(row[3], Number(row[2]) / 2);
  assert.equal(row[4], 'abc');
});
