// PROFIBUS DP master of vplc-cpu against a simulated slave on a pseudo-terminal pair (socat).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, DeviceClient } from '../src/index.ts';
import { DpSlave } from './dpSlave.ts';

const CPU = new URL('../../runtime/build/vplc-cpu', import.meta.url).pathname;
const skip = !existsSync(CPU) ? 'build runtime/ first' : (() => {
  try { execFileSync('socat', ['-V'], { stdio: 'ignore' }); return false; } catch { return 'needs socat'; }
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const PROGRAM = `
VAR_GLOBAL
  In0 AT %IB0 : Byte;
  In1 AT %IB1 : Byte;
  Out0 AT %QB0 : Byte;
  Out1 AT %QB1 : Byte;
END_VAR
ORGANIZATION_BLOCK "Main"
BEGIN
  Out0 := In0;
  Out1 := 16#5A;
END_ORGANIZATION_BLOCK`;

test('PROFIBUS DP: parameters, configuration, data exchange, diagnosis, wrong configuration', { skip, timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vplc-dp-'));
  const a = join(dir, 'ttyMaster');
  const b = join(dir, 'ttySlave');
  const procs: ChildProcess[] = [];
  const slave = new DpSlave({ path: b, station: 5, identNumber: 0x80F1, config: [0x11, 0x21], inLength: 2, outLength: 2 });
  let output = '';
  const c = new DeviceClient('127.0.0.1', await freePort());
  try {
    procs.push(spawn('socat', [`pty,raw,echo=0,link=${a}`, `pty,raw,echo=0,link=${b}`]));
    await until(() => existsSync(a) && existsSync(b), 'pty pair');
    await slave.open();
    const make = (config: number[]) => compile({
      sources: [{ file: 'main.scl', text: PROGRAM }], cycleMs: 5,
      hardware: [{
        kind: 'profibus-slave', name: 'ET_5', port: a, baud: 500000, station: 5, identNumber: 0x80F1, watchdogMs: 200,
        userPrm: [0x00, 0x01], config, inByte: 0, inLength: 2, outByte: 0, outLength: 2,
      }],
    });
    const r = make([0x11, 0x21]);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    const cpu = spawn(CPU, ['--data', dir, '--listen', '127.0.0.1', '--port', String(c.port), '--modbus-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    cpu.stdout!.on('data', (d) => (output += d));
    cpu.stderr!.on('data', (d) => (output += d));
    procs.push(cpu);
    await until(async () => c.connect().then(() => true, () => false), 'CPU');
    await c.download(r.image!);
    await c.start();
    await until(() => slave.state === 'data', 'Set_Prm and Chk_Cfg');
    // Set_Prm: lock + watchdog on, factors 20 x 1 (200 ms), ident, user parameters
    assert.deepEqual([...slave.prm!], [0x88, 20, 1, 11, 0x80, 0xf1, 0, 0x00, 0x01]);
    slave.inputs[0] = 0x3c;
    await until(() => slave.outputs[0] === 0x3c && slave.outputs[1] === 0x5a, `outputs at the slave (${slave.outputs.toString('hex')})`);
    await until(async () => (await c.state()).io[0]?.ok === true, 'module OK');
    assert.match((await c.state()).io[0].diag ?? '', /data exchange/);

    // extended diagnosis: high priority answer, then Slave_Diag read by the master
    slave.extDiag = [0x42, 0x01];
    await until(async () => /extended: 42 01/.test((await c.state()).io[0].diag ?? ''), 'extended diagnosis');

    // slave silent: lost, inputs to 0, then back
    slave.mute = true;
    await until(async () => (await c.state()).io[0]?.ok === false, 'loss detected');
    slave.mute = false;
    slave.state = 'wait-prm';
    await until(async () => (await c.state()).io[0]?.ok === true, 'reconnection', 15000);

    // configuration that does not match the slave: reported
    await c.download(make([0x13, 0x21]).image!);
    await c.start();
    await until(async () => /configuration fault/.test((await c.state()).io[0]?.diag ?? ''), 'configuration fault');
  } catch (e) {
    throw new Error(`${(e as Error).message}\n--- CPU ---\n${output}`);
  } finally {
    c.close();
    slave.close();
    for (const p of procs) p.kill();
  }
});
