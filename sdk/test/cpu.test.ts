// End-to-end: runtime/build/vplc-cpu (Linux CPU) driven through the device protocol,
// with a simulated Modbus TCP I/O module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile, DeviceClient, findSymbol, type CompileResult } from '../src/index.ts';

const CPU = new URL('../../runtime/build/vplc-cpu', import.meta.url).pathname;
const skip = existsSync(CPU) ? false : 'build runtime/ first';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Tiny Modbus TCP slave: 8 discrete inputs, 8 coils. */
function fakeIoModule(port: number): { server: Server; inputs: boolean[]; coils: boolean[] } {
  const io = { inputs: new Array(8).fill(false), coils: new Array(8).fill(false) };
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 7 && buf.length >= 6 + buf.readUInt16BE(4)) {
        const len = buf.readUInt16BE(4);
        const pdu = buf.subarray(7, 6 + len);
        const head = buf.subarray(0, 7);
        buf = buf.subarray(6 + len);
        let resp: Buffer;
        if (pdu[0] === 2) {
          let bits = 0;
          io.inputs.forEach((v, i) => (bits |= v ? 1 << i : 0));
          resp = Buffer.from([2, 1, bits]);
        } else if (pdu[0] === 15) {
          const qty = pdu.readUInt16BE(3);
          for (let i = 0; i < qty; i++) io.coils[i] = ((pdu[6 + (i >> 3)] >> (i & 7)) & 1) === 1;
          resp = Buffer.from(pdu.subarray(0, 5));
        } else {
          resp = Buffer.from([pdu[0] | 0x80, 1]);
        }
        const out = Buffer.concat([head, resp]);
        out.writeUInt16BE(resp.length + 1, 4);
        sock.write(out);
      }
    });
  });
  server.listen(port, '127.0.0.1');
  return { server, ...io };
}

async function until(fn: () => Promise<boolean> | boolean, what: string, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timeout waiting for ${what}`);
}

function startCpu(dir: string, port: number, modbusPort: number, extra: string[] = []): ChildProcess {
  return spawn(CPU, ['--data', dir, '--listen', '127.0.0.1', '--port', String(port), '--modbus-port', String(modbusPort), '--name', 'TestPLC', ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const PROGRAM = `
VAR_GLOBAL
  Button AT %I0.1 : Bool;
  Lamp AT %Q0.2 : Bool;
  Presses : Int;
  Setpoint AT %MW10 : Int := 7;
END_VAR
DATA_BLOCK "Edge" R_TRIG BEGIN END_DATA_BLOCK
ORGANIZATION_BLOCK "Main" BEGIN
  "Edge"(CLK := Button);
  IF "Edge".Q THEN Presses += 1; LOG('pressed ', Presses); END_IF;
  Lamp := Button;
END_ORGANIZATION_BLOCK`;

test('Linux CPU: download, run, monitor, remote I/O, persistence, password', { skip, timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vplc-cpu-'));
  const [port, modbusPort, ioPort] = [await freePort(), await freePort(), await freePort()];
  const io = fakeIoModule(ioPort);
  const result: CompileResult = compile({
    sources: [{ file: 'main.scl', text: PROGRAM }],
    name: 'Lamp',
    cycleMs: 5,
    hardware: [{ kind: 'modbus-tcp', name: 'IO_1', host: '127.0.0.1', port: ioPort, di: { byte: 0, count: 8 }, coils: { byte: 0, count: 8 } }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));

  let cpu = startCpu(dir, port, modbusPort);
  const client = new DeviceClient('127.0.0.1', port);
  try {
    await until(async () => client.connect().then(() => true, () => false), 'CPU to listen');
    const info = await client.info();
    assert.equal(info.name, 'TestPLC');
    assert.equal((await client.state()).state, 'NO_PROGRAM');

    // Download + start
    await client.download(result.image!);
    let state = await client.state();
    assert.equal(state.state, 'STOP');
    assert.equal(state.programId, result.programId);
    await client.start();
    await until(async () => (await client.state()).io[0]?.ok === true, 'I/O module online');

    // Input from the remote module -> program -> output coil
    const button = findSymbol(result.symbols, 'Button')!;
    const presses = findSymbol(result.symbols, 'Presses')!;
    io.inputs[1] = true;
    await until(() => io.coils[2], 'lamp output');
    assert.equal((await client.readSymbols([button]))[0], true);
    io.inputs[1] = false;
    await until(() => !io.coils[2], 'lamp off');
    assert.equal((await client.readSymbols([presses]))[0], 1);
    assert.equal((await client.readSymbols([findSymbol(result.symbols, 'Setpoint')!]))[0], 7);
    assert.ok((await client.logs()).some((l) => l.msg === 'pressed 1'));

    // Online value change and force
    await client.writeSymbol(presses, 41);
    io.inputs[1] = true;
    await until(async () => (await client.readSymbols([presses]))[0] === 42, 'edge after write');
    await client.force('Q', 0, 2, false);
    await until(() => !io.coils[2], 'forced output');
    assert.equal((await client.state()).forces, 1);
    await client.unforceAll();

    // Upload returns the same image
    assert.deepEqual(Buffer.from(await client.upload()), Buffer.from(result.image!));

    // A corrupted download is rejected and the previous program keeps working
    const bad = Buffer.from(result.image!);
    bad[20] ^= 0xff;
    await assert.rejects(client.download(bad), /checksum/);
    state = await client.state();
    assert.equal(state.programId, result.programId);

    // Persistence: restart the CPU process, the program runs again automatically
    client.close();
    cpu.kill('SIGTERM');
    await new Promise((r) => cpu.once('exit', r));
    assert.equal(io.coils[2], false, 'outputs are switched off on shutdown');
    writeFileSync(join(dir, 'pw'), 'secret\n');
    cpu = startCpu(dir, port, modbusPort, ['--password-file', join(dir, 'pw')]);
    await until(async () => {
      const c = new DeviceClient('127.0.0.1', port);
      try {
        await c.connect();
        return false;
      } catch (e) {
        return /password/.test((e as Error).message);
      } finally {
        c.close();
      }
    }, 'password protection');
    await client.connect('secret');
    await until(async () => (await client.state()).state === 'RUN', 'automatic start');
  } finally {
    client.close();
    cpu.kill('SIGTERM');
    io.server.close();
  }
});

test('Linux CPU: S7 communication for HMIs (absolute %I/%Q/%M and DB access)', { skip, timeout: 30000 }, async () => {
  const { S7Client, AREA } = await import('./s7client.ts');
  const dir = mkdtempSync(join(tmpdir(), 'vplc-s7-'));
  const [port, modbusPort, s7Port] = [await freePort(), await freePort(), await freePort()];
  const result = compile({
    sources: [{ file: 'main.scl', text: `
      VAR_GLOBAL
        Start AT %I0.0 : Bool;
        Lamp AT %Q0.1 : Bool;
        Speed AT %MW10 : Int;
        Limit AT %MW12 : Int := 1500;
      END_VAR
      DATA_BLOCK "Recipe"
        STRUCT
          Temperature : Real := 21.5;
          Count : DInt;
          Enabled : Bool;
        END_STRUCT;
      BEGIN END_DATA_BLOCK
      ORGANIZATION_BLOCK "Main" BEGIN
        Lamp := "Recipe".Enabled;
        "Recipe".Count := "Recipe".Count + 1;
      END_ORGANIZATION_BLOCK` }],
    name: 'S7',
    cycleMs: 5,
    dbNumbers: { Recipe: 3 },
    hmi: { readOnly: ['Limit'] },
    services: { s7: { enabled: true, write: true } },
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  const cpu = startCpu(dir, port, modbusPort, ['--s7-port', String(s7Port)]);
  const client = new DeviceClient('127.0.0.1', port);
  const s7 = new S7Client();
  try {
    await until(async () => client.connect().then(() => true, () => false), 'CPU to listen');
    await client.download(result.image!);
    await client.start();
    await until(async () => s7.connect('127.0.0.1', s7Port).then(() => true, () => false), 'S7 server');
    assert.equal(s7.pdu, 480);

    // DB3: Temperature (Real, DBD0), Count (DInt, DBD4), Enabled (Bool, DBX8.0)
    const t = await s7.read(AREA.DB, 3, 0, 4);
    assert.equal(t.code, 0xff);
    assert.equal(t.data.readFloatBE(0), 21.5);
    const c1 = (await s7.read(AREA.DB, 3, 4, 4)).data.readInt32BE(0);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok((await s7.read(AREA.DB, 3, 4, 4)).data.readInt32BE(0) > c1, 'values follow the running program');

    // HMI writes a DB bit -> program sets the output
    assert.equal(await s7.write(AREA.DB, 3, 8, Buffer.from([1])), 0xff);
    await until(async () => ((await s7.read(AREA.Q, 0, 0, 1, 1)).data[0] ?? 0) === 1, 'output from HMI command');
    // %M word write / read
    assert.equal(await s7.write(AREA.M, 0, 10, Buffer.from([0x03, 0xe8])), 0xff);
    assert.equal((await s7.read(AREA.M, 0, 10, 2)).data.readInt16BE(0), 1000);
    assert.equal((await client.readSymbols([findSymbol(result.symbols, 'Speed')!]))[0], 1000);

    // Access rights and errors
    assert.equal(await s7.write(AREA.M, 0, 12, Buffer.from([0, 1])), 0x03, 'read-only variable');
    assert.equal(await s7.write(AREA.I, 0, 0, Buffer.from([1])), 0x03, 'inputs cannot be written');
    assert.equal((await s7.read(AREA.DB, 9, 0, 2)).code, 0x0a, 'unknown DB');
    assert.equal((await s7.read(AREA.DB, 3, 8, 4)).code, 0x05, 'beyond the end of the DB');
  } finally {
    s7.close();
    client.close();
    cpu.kill();
  }
});
