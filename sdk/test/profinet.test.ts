// PROFINET end to end: one CPU as IO-Controller, another as IO-Device, linked by a virtual
// Ethernet pair (the device in its own network namespace). Needs root and iproute2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, DeviceClient, generateGsdml, parseGsdml, pnModuleIdent, pnSubmodules, type IoModuleConfig } from '../src/index.ts';

const CPU = new URL('../../runtime/build/vplc-cpu', import.meta.url).pathname;
const NS = 'vplc-pn-test';
const ip = (...args: string[]) => execFileSync('ip', args, { stdio: 'pipe' });
const canRun = (() => {
  if (!existsSync(CPU)) return 'build runtime/ first';
  if (process.getuid?.() !== 0) return 'needs root (raw Ethernet, network namespace)';
  try {
    ip('-V');
  } catch {
    return 'needs iproute2';
  }
  return false;
})();

function image(source: string, hardware: IoModuleConfig[]): Uint8Array {
  const r = compile({ buildTime: 0, sources: [{ file: 'main.scl', text: source }], hardware, cycleMs: 5 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.image!;
}

async function until(what: () => boolean | Promise<boolean>, ms: number, message: string | (() => string)) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await what()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(typeof message === 'string' ? message : message());
}

test('PROFINET: IO-Controller and IO-Device (DCP, connect, cyclic data, watchdog, reconnection)', { skip: canRun, timeout: 60000 }, async () => {
  try { ip('netns', 'del', NS); } catch { /* not there */ }
  try { ip('link', 'del', 'vpnc'); } catch { /* not there */ }
  ip('netns', 'add', NS);
  const procs: ChildProcess[] = [];
  const logs = { dev: '', ctl: '' };
  try {
    ip('link', 'add', 'vpnc', 'type', 'veth', 'peer', 'name', 'vpnd');
    ip('link', 'set', 'vpnd', 'netns', NS);
    ip('netns', 'exec', NS, 'ip', 'link', 'set', 'lo', 'up');
    ip('netns', 'exec', NS, 'ip', 'link', 'set', 'vpnd', 'up');
    ip('addr', 'add', '192.168.78.1/24', 'dev', 'vpnc');
    ip('link', 'set', 'vpnc', 'up');

    // controller configuration from the GSDML of the device: OUT 2 bytes in slot 1, IN 2 bytes in slot 2
    const gsd = parseGsdml(generateGsdml({ vendorId: 0, deviceId: 1 }).xml);
    const byIdent = (ident: number) => [...gsd.modules.values()].find((m) => m.ident === ident)!;
    const submodules = pnSubmodules(gsd.daps[0], [{ slot: 1, module: byIdent(pnModuleIdent('out', 2)) }, { slot: 2, module: byIdent(pnModuleIdent('in', 2)) }], 0, 0);
    assert.deepEqual(submodules.map((x) => `${x.slot}.${x.subslot}`), ['0.1', '0.32768', '0.32769', '1.1', '2.1']);
    submodules[3].records = [{ index: 1, data: [1, 2, 3] }, { index: 2, data: [4] }];
    const devDir = mkdtempSync(join(tmpdir(), 'vplc-pnd-'));
    const ctlDir = mkdtempSync(join(tmpdir(), 'vplc-pnc-'));
    // device: its outputs to the controller = its inputs + 1000; no IP yet (the controller sets it)
    writeFileSync(join(devDir, 'program.vplc'), image(`
      VAR_GLOBAL "InW" AT %IW0 : UInt; "OutW" AT %QW0 : UInt; END_VAR
      ORGANIZATION_BLOCK "Main" BEGIN "OutW" := "InW" + 1000; END_ORGANIZATION_BLOCK`,
    [{ kind: 'profinet-device', name: 'PN', interface: 'vpnd', stationName: 'test-device', deviceId: 1, inByte: 0, inLength: 4, outByte: 0, outLength: 4 }]));
    writeFileSync(join(ctlDir, 'program.vplc'), image(`
      VAR_GLOBAL "Count" AT %QW0 : UInt; "Back" AT %IW0 : UInt; END_VAR
      ORGANIZATION_BLOCK "Main" BEGIN "Count" := "Count" + 1; END_ORGANIZATION_BLOCK`,
    [{
      kind: 'profinet-remote', name: 'test-device', interface: 'vpnc', stationName: 'test-device', ip: '192.168.78.2', vendorId: 0, deviceId: 1, cycleMs: 4,
      submodules,
    }]));
    const start = (which: 'dev' | 'ctl') => {
      const args = ['--data', which === 'dev' ? devDir : ctlDir, '--port', which === 'dev' ? '20105' : '20187', '--modbus-port', '0', '--s7-port', '0', '--opcua-port', '0'];
      const p = which === 'dev' ? spawn('ip', ['netns', 'exec', NS, CPU, ...args]) : spawn(CPU, ['--listen', '127.0.0.1', ...args]);
      p.stdout!.on('data', (d) => (logs[which] += d));
      p.stderr!.on('data', (d) => (logs[which] += d));
      procs.push(p);
      return p;
    };
    const dev = start('dev');
    start('ctl');
    await until(() => /data exchange started/.test(logs.ctl), 10000, () => `no data exchange:\n${logs.ctl}\n${logs.dev}`);
    assert.match(logs.dev, /IP address set to 192\.168\.78\.2/);
    assert.match(logs.dev, /end of parametrization \(2 parameter record\(s\)\)/);

    // cyclic data both ways
    const ctl = new DeviceClient('127.0.0.1', 20187);
    await ctl.connect();
    await until(async () => {
      const [i, q] = await ctl.read([{ area: 'I', offset: 0, length: 2 }, { area: 'Q', offset: 0, length: 2 }]);
      const back = i.readUInt16BE(0), count = q.readUInt16BE(0);
      return back > 1000 && count + 1000 - back >= 0 && count + 1000 - back < 50;
    }, 5000, 'the device does not echo the controller outputs');

    // device lost: watchdog, then reconnection once it is back (name and IP were kept)
    dev.kill();
    await until(() => /connection lost \(watchdog/.test(logs.ctl), 5000, 'watchdog not detected');
    assert.match(readFileSync(join(devDir, 'profinet.conf'), 'utf8'), /name=test-device\nip=192\.168\.78\.2/);
    start('dev');
    await until(() => (logs.ctl.match(/data exchange started/g) ?? []).length >= 2, 15000, () => `no reconnection:\n${logs.ctl}`);
    ctl.close?.();
  } finally {
    for (const p of procs) p.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { ip('netns', 'del', NS); } catch { /* ignore */ }
    try { ip('link', 'del', 'vpnc'); } catch { /* ignore */ }
  }
});
