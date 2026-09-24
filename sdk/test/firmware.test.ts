// The microcontroller firmware sketch running on Linux (runtime/build/vplc-firmware-sim,
// Arduino shim in firmware/test/host): serial link, GPIO modules, program kept at power off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, DeviceClient } from '../src/index.ts';

const SIM = new URL('../../runtime/build/vplc-firmware-sim', import.meta.url).pathname;
const skip = !existsSync(SIM) ? 'build runtime/ first' : (() => {
  if (process.getuid?.() !== 0) return 'needs root (serial port links under /dev)';
  try { execFileSync('socat', ['-V'], { stdio: 'ignore' }); return false; } catch { return 'needs socat'; }
})();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('firmware: serial download, GPIO modules, program kept at power off', { skip, timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vplc-fw-'));
  const pins = join(dir, 'pins');
  const fs = join(dir, 'fs');
  mkdirSync(pins);
  const a = join(dir, 'ttyBoard');
  const b = `/dev/vplc-fw-${process.pid}`;
  const procs: ChildProcess[] = [];
  const board = () => {
    const p = spawn(SIM, [], { env: { ...process.env, VPLC_SIM_SERIAL: a, VPLC_SIM_FS: fs, VPLC_SIM_PINS: pins } });
    procs.push(p);
    return p;
  };
  const out = (pin: number) => (existsSync(join(pins, `out-${pin}`)) ? readFileSync(join(pins, `out-${pin}`), 'utf8').trim() : '');
  try {
    procs.push(spawn('socat', [`pty,raw,echo=0,link=${a}`, `pty,raw,echo=0,link=${b}`]));
    for (let i = 0; i < 50 && !(existsSync(a) && existsSync(b)); i++) await wait(100);
    let proc = board();

    const client = new DeviceClient(b, 115200);
    const info = await client.connect();
    assert.equal(info.device, 'host-sim');
    assert.equal(info.maxPayload, 1024, 'small board profile');
    // DI pin 4 → %I0.0, DO pin 5 ← %Q0.0 (inverted input), AI pin 34 → %IW2, AO pin 25 ← %QW2
    const r = compile({
      buildTime: 0,
      hardware: [
        { kind: 'gpio-di', name: 'Button', pin: 4, byte: 0, bit: 0 },
        { kind: 'gpio-do', name: 'Lamp', pin: 5, byte: 0, bit: 0 },
        { kind: 'gpio-ai', name: 'Level', pin: 34, byte: 2 },
        { kind: 'gpio-ao', name: 'Valve', pin: 25, byte: 2 },
      ],
      sources: [{ file: 'm.scl', text: `
        VAR_GLOBAL "Button" AT %I0.0 : Bool; "Lamp" AT %Q0.0 : Bool; "Level" AT %IW2 : Int; "Valve" AT %QW2 : Int; END_VAR
        ORGANIZATION_BLOCK "Main" BEGIN
          "Lamp" := NOT "Button";
          "Valve" := "Level" / 2;
        END_ORGANIZATION_BLOCK` }],
    });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    await client.download(r.image!);
    await client.start();
    writeFileSync(join(pins, 'in-34'), '4095');  // full scale of a 12-bit ADC
    await wait(300);
    assert.equal(out(5), '1', 'lamp on while the button is released');
    const [iw] = await client.read([{ area: 'I', offset: 2, length: 2 }]);
    assert.equal(iw.readInt16BE(0), 27648, 'analog input scaled to 0..27648');
    assert.equal(out(25), '127', 'analog output 13824 / 27648 → PWM 127 of 255');
    writeFileSync(join(pins, 'in-4'), '1');
    await wait(300);
    assert.equal(out(5), '0');
    client.close();

    // power cycle: the program is loaded from the file system and runs again
    proc.kill();
    await wait(200);
    writeFileSync(join(pins, 'in-4'), '0');
    proc = board();
    await wait(800);
    assert.equal(out(5), '1', 'program restarted after power on');
    const again = new DeviceClient(b, 115200);
    await again.connect();
    assert.equal((await again.state()).state, 'RUN');
    again.close();
  } finally {
    for (const p of procs) p.kill();
  }
});
