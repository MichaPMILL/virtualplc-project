// EtherNet/IP scanner of vplc-cpu against a simulated adapter (implicit class 1 I/O).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, DeviceClient } from '../src/index.ts';
import { EnipAdapter } from './enipAdapter.ts';

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

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

const PROGRAM = `
VAR_GLOBAL
  Trigger AT %Q0.0 : Bool;
  Command AT %QW2 : Int;
  Ready AT %I0.0 : Bool;
  Result AT %ID4 : DInt;
  Copy : DInt;
END_VAR
ORGANIZATION_BLOCK "Main"
BEGIN
  Trigger := Ready;
  Command := 1234;
  Copy := Result;
END_ORGANIZATION_BLOCK`;

test('EtherNet/IP: Forward_Open, cyclic I/O, timeout and reconnection, errors', { skip, timeout: 60000 }, async () => {
  const adapter = new EnipAdapter({ address: '127.0.0.2', configInstance: 151, outInstance: 150, inInstance: 100, outLength: 4, inLength: 8, vendorId: 0x1234, productCode: 7 });
  await adapter.start();
  const r = compile({
    sources: [{ file: 'main.scl', text: PROGRAM }],
    cycleMs: 5,
    hardware: [{
      kind: 'enip-adapter', name: 'Camera', host: '127.0.0.2', port: adapter.port, rpiMs: 5,
      configInstance: 151, outInstance: 150, inInstance: 100, outLength: 4, outByte: 0, inLength: 8, inByte: 0,
      vendorId: 0x1234, deviceType: 12, productCode: 7, revision: { major: 1, minor: 2 },
    }],
  });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  const dir = mkdtempSync(join(tmpdir(), 'vplc-enip-'));
  const port = await freePort();
  const cpu = spawn(CPU, ['--data', dir, '--listen', '127.0.0.1', '--port', String(port), '--modbus-port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  cpu.stdout!.on('data', (d) => (output += d));
  cpu.stderr!.on('data', (d) => (output += d));
  const c = new DeviceClient('127.0.0.1', port);
  try {
    await until(async () => c.connect().then(() => true, () => false), 'CPU');
    await c.download(r.image!);
    await c.start();
    await until(() => adapter.connected, 'Forward_Open');
    // electronic key with the compatibility bit, then 20 04 24 97 2C 96 2C 64
    const fo = adapter.lastForwardOpen!;
    const path = fo.subarray(36, 36 + fo[35] * 2);
    assert.deepEqual([...path], [0x34, 0x04, 0x34, 0x12, 12, 0, 7, 0, 0x81, 2, 0x20, 0x04, 0x24, 151, 0x2c, 150, 0x2c, 100]);
    assert.equal(fo.readUInt32LE(22), 5000);  // RPI in µs

    // T->O: inputs of the program; O->T: outputs, run/idle header
    adapter.input[0] = 1;
    adapter.input.writeInt32BE(-987654, 4);
    await until(() => adapter.output[0] === 1 && adapter.output.readInt16BE(2) === 1234, `outputs at the adapter (${adapter.output.toString('hex')})`);
    assert.equal(adapter.run, true);
    await until(async () => (await c.state()).io[0]?.ok === true, 'module OK');
    const state = await c.state();
    assert.match(state.io[0].diag ?? '', /connected \(RPI 5\.0 ms/);

    // Adapter silent: connection timeout, inputs to 0, then reconnection
    adapter.mute = true;
    await until(async () => (await c.state()).io[0]?.ok === false, 'timeout detected');
    const opens = adapter.forwardOpens;
    adapter.mute = false;
    await until(() => adapter.forwardOpens > opens, 'new Forward_Open', 15000);
    await until(async () => (await c.state()).io[0]?.ok === true, 'reconnected', 15000);
    assert.match(output, /connection timeout/);
  } catch (e) {
    throw new Error(`${(e as Error).message}\n--- CPU ---\n${output}`);
  } finally {
    c.close();
    cpu.kill();
    await sleep(200);
    adapter.close();
  }
});

test('EtherNet/IP: wrong assembly instance reported as a CIP error', { skip, timeout: 30000 }, async () => {
  const adapter = new EnipAdapter({ address: '127.0.0.3', configInstance: 1, outInstance: 150, inInstance: 100, outLength: 2, inLength: 2 });
  await adapter.start();
  const r = compile({
    sources: [{ file: 'main.scl', text: 'ORGANIZATION_BLOCK "Main"\nBEGIN\nEND_ORGANIZATION_BLOCK' }],
    hardware: [{ kind: 'enip-adapter', name: 'Drive', host: '127.0.0.3', port: adapter.port, configInstance: 1, outInstance: 151, inInstance: 100, outLength: 2, outByte: 0, inLength: 2, inByte: 0 }],
  });
  const dir = mkdtempSync(join(tmpdir(), 'vplc-enip-'));
  const port = await freePort();
  const cpu = spawn(CPU, ['--data', dir, '--listen', '127.0.0.1', '--port', String(port), '--modbus-port', '0'], { stdio: 'ignore' });
  const c = new DeviceClient('127.0.0.1', port);
  try {
    await until(async () => c.connect().then(() => true, () => false), 'CPU');
    await c.download(r.image!);
    await c.start();
    await until(async () => /0x0117: invalid produced or consumed application path/.test((await c.state()).io[0]?.diag ?? ''), 'CIP error in the diagnostics');
    assert.equal((await c.state()).io[0].ok, false);
  } finally {
    c.close();
    cpu.kill();
    await sleep(200);
    adapter.close();
  }
});

test('EtherNet/IP: ListIdentity discovery', async () => {
  const { enipDiscover } = await import('../src/index.ts');
  const { identityResponder } = await import('./enipAdapter.ts');
  const r = await identityResponder('127.0.0.4', 'VS-100', 44820);
  try {
    const found = await enipDiscover(500, '127.0.0.4', 44820);
    assert.equal(found.length, 1);
    assert.deepEqual({ ...found[0] }, {
      address: '127.0.0.4', vendorId: 0x1234, deviceType: 43, productCode: 17, revision: { major: 2, minor: 3 }, status: 0, serial: 0xa1b2c3d4, productName: 'VS-100',
    });
  } finally {
    r.close();
  }
});
