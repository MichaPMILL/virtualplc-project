// Serial link (USB) between the Studio client and a CPU: vplc-cpu --serial on one end of a
// pseudo-terminal pair (socat), the client on the other; noise before the first frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, DeviceClient, isSerialPort } from '../src/index.ts';

const CPU = new URL('../../runtime/build/vplc-cpu', import.meta.url).pathname;
const skip = !existsSync(CPU) ? 'build runtime/ first' : (() => {
  if (process.getuid?.() !== 0) return 'needs root (serial port links under /dev)';
  try { execFileSync('socat', ['-V'], { stdio: 'ignore' }); return false; } catch { return 'needs socat'; }
})();

test('serial port names', () => {
  for (const s of ['COM3', 'com12', '/dev/ttyUSB0', '/dev/cu.usbmodem1101']) assert.equal(isSerialPort(s), true, s);
  for (const s of ['192.168.0.10', 'plc.local', 'serial']) assert.equal(isSerialPort(s), false, s);
});

test('device protocol over a serial link (download, run, read)', { skip, timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vplc-serial-'));
  const a = join(dir, 'ttyCPU');
  const b = `/dev/vplc-test-${process.pid}`;
  const procs: ChildProcess[] = [];
  try {
    procs.push(spawn('socat', [`pty,raw,echo=0,link=${a}`, `pty,raw,echo=0,link=${b}`]));
    for (let i = 0; i < 50 && !(existsSync(a) && existsSync(b)); i++) await new Promise((r) => setTimeout(r, 100));
    // a board printing boot messages before the CPU starts
    writeFileSync(a, 'ets Jun  8 2016 00:22:57\r\nrst:0x1 (POWERON_RESET),boot:0x13\r\nVR garbage\r\n');
    procs.push(spawn(CPU, ['--data', dir, '--port', '20166', '--listen', '127.0.0.1', '--modbus-port', '0', '--s7-port', '0', '--opcua-port', '0', '--serial', `${a}:115200`]));
    await new Promise((r) => setTimeout(r, 300));

    const client = new DeviceClient(b, 115200);
    const info = await client.connect();
    assert.equal(info.device.startsWith('linux'), true);
    const r = compile({ buildTime: 0, sources: [{ file: 'm.scl', text: 'VAR_GLOBAL "N" AT %MW0 : Int; END_VAR\nORGANIZATION_BLOCK "Main" BEGIN "N" := "N" + 1; END_ORGANIZATION_BLOCK' }] });
    await client.download(r.image!);
    await client.start();
    await new Promise((res) => setTimeout(res, 200));
    const [m] = await client.read([{ area: 'M', offset: 0, length: 2 }]);
    assert.ok(m.readInt16BE(0) > 0, 'the program runs');
    assert.equal((await client.state()).state, 'RUN');
    client.close();
  } finally {
    for (const p of procs) p.kill();
  }
});
