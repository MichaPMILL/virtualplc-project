// Studio backend: compilation, device sessions. Runs in the Electron main process
// (or in the development web server). The renderer talks to it through `StudioApi`.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createEngineeringKey, engineeringPublicKey, keyFingerprint, signProgram,
  compileDevice, DeviceClient, findSymbol, formatTemporal, formatValue, loadProject, parseAddress, parseTemporal, TEMPORAL_PREFIXES,
  type DeviceInfo, type DeviceState, type LogEntry, type Project, type ProjectDiagnostic, type SymbolNode, type PlcValue,
  type DataLogStatus, type TraceCertificate,
} from '../../../sdk/src/index.ts';

export interface CompileSummary {
  ok: boolean;
  diagnostics: ProjectDiagnostic[];
  programId?: string;
  stats: { code: number; data: number; constants: number; inputs: number; outputs: number; memory: number };
  symbols: SymbolNode[];
  functions: Array<{ name: string; kind: string; file?: string }>;
  /** Line of the generated source where the code of each block starts (block id -> line) */
  codeLines: Record<string, number>;
  /** Numbered data blocks and their location in the data memory (absolute addresses) */
  dbs: Array<{ number: number; name: string; offset: number; size: number }>;
  /** Data logs in the order of the CPU (configured ones, then DataLogCreate) */
  dataLogs: Array<{ name: string; columns: string[]; program: boolean }>;
  time: string;
}

export interface MonitorValue {
  path: string;
  value?: PlcValue;
  text?: string;
  error?: string;
}

interface Compiled {
  image: Uint8Array;
  symbols: SymbolNode[];
  programId: string;
  functions: CompileSummary['functions'];
}

interface Session {
  client: DeviceClient;
  info: DeviceInfo;
}

export class Backend {
  private readonly compiled = new Map<string, Compiled>();
  private readonly sessions = new Map<string, Session>();

  compile(projectJson: string, deviceId: string): CompileSummary {
    const project = loadProject(projectJson);
    const device = findDevice(project, deviceId);
    const r = compileDevice(project, device);
    if (r.ok && r.image && r.programId) {
      this.compiled.set(deviceId, { image: r.image, symbols: r.symbols, programId: r.programId, functions: r.functions });
    }
    return {
      ok: r.ok, diagnostics: r.diagnostics, programId: r.programId, stats: r.stats, symbols: r.symbols,
      functions: r.functions, time: new Date().toISOString(), dbs: r.dbs ?? [], dataLogs: r.dataLogs ?? [],
      codeLines: Object.fromEntries(r.sources.filter((x) => x.blockId).map((x) => [x.blockId!, x.codeLine])),
    };
  }

  async connect(deviceId: string, host: string, port: number, password?: string, user?: string, pinnedKey?: string): Promise<DeviceInfo> {
    await this.disconnect(deviceId);
    const client = new DeviceClient(host, port);
    client.timeoutMs = 4000;
    if (pinnedKey) client.pinnedKey = pinnedKey;
    const info = await client.connect(password || undefined, user || undefined);
    this.sessions.set(deviceId, { client, info });
    return info;
  }

  async disconnect(deviceId: string): Promise<void> {
    this.sessions.get(deviceId)?.client.close();
    this.sessions.delete(deviceId);
  }

  isConnected(deviceId: string): boolean {
    return this.sessions.get(deviceId)?.client.connected ?? false;
  }

  async state(deviceId: string): Promise<DeviceState & { offlineProgramId: string | null }> {
    const s = await this.session(deviceId).client.state();
    return { ...s, offlineProgramId: this.compiled.get(deviceId)?.programId ?? null };
  }

  async download(deviceId: string, startAfter: boolean): Promise<void> {
    const c = this.compiled.get(deviceId);
    if (!c) throw new Error('Compile the program before downloading it');
    const { client } = this.session(deviceId);
    // every program is signed with the engineering key of this workstation (CPUs started with
    // --signed-programs load only programs signed by a key they trust)
    await client.download(c.image, undefined, signProgram(c.image, this.engineeringKeyPem()));
    if (startAfter) await client.start();
  }

  /** Engineering key of this workstation: VPLC_ENGINEERING_KEY or ~/.virtualplc/engineering-key.pem (created on first use) */
  private engineeringKeyPem(): string {
    const path = process.env.VPLC_ENGINEERING_KEY || join(homedir(), '.virtualplc', 'engineering-key.pem');
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, createEngineeringKey().privateKeyPem, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    return readFileSync(path, 'utf8');
  }

  async engineeringKey(): Promise<{ publicKey: string; fingerprint: string }> {
    const publicKey = engineeringPublicKey(this.engineeringKeyPem());
    return { publicKey, fingerprint: await keyFingerprint(publicKey) };
  }

  async start(deviceId: string, cold: boolean): Promise<void> {
    await this.session(deviceId).client.start(cold);
  }

  async stop(deviceId: string): Promise<void> {
    await this.session(deviceId).client.stop();
  }

  async logs(deviceId: string, from: number): Promise<LogEntry[]> {
    return this.session(deviceId).client.logs(from);
  }

  /** Reads variables by path ("Tag", "DB".Member, %MW10) using the symbols of the last compilation. */
  async read(deviceId: string, paths: string[]): Promise<MonitorValue[]> {
    const { client } = this.session(deviceId);
    const c = this.compiled.get(deviceId);
    const resolved = paths.map((path) => ({ path, symbol: this.resolve(c, path) }));
    const valid = resolved.filter((r) => r.symbol !== null) as Array<{ path: string; symbol: SymbolNode }>;
    const values = valid.length ? await client.readSymbols(valid.map((r) => r.symbol)) : [];
    const byPath = new Map(valid.map((r, i) => [r.path, { value: values[i], symbol: r.symbol }]));
    return resolved.map(({ path }) => {
      const v = byPath.get(path);
      if (!v) return { path, error: c ? 'unknown' : 'not compiled' };
      return { path, value: v.value, text: typeof v.value === 'object' ? undefined : formatValue(v.symbol, v.value) };
    });
  }

  async write(deviceId: string, path: string, text: string): Promise<void> {
    const c = this.compiled.get(deviceId);
    const symbol = this.resolve(c, path);
    if (!symbol || symbol.children) throw new Error(`Cannot modify '${path}'`);
    await this.session(deviceId).client.writeSymbol(symbol, parseValue(symbol, text));
  }

  async force(deviceId: string, path: string, value: boolean | null): Promise<void> {
    const symbol = this.resolve(this.compiled.get(deviceId), path);
    if (!symbol || symbol.bit === undefined || (symbol.area !== 'I' && symbol.area !== 'Q')) {
      throw new Error(`Only %I and %Q bits can be forced ('${path}')`);
    }
    await this.session(deviceId).client.force(symbol.area, symbol.offset, symbol.bit, value);
  }

  async unforceAll(deviceId: string): Promise<void> {
    await this.session(deviceId).client.unforceAll();
  }

  // Traceability (data logs)
  async dataLogRead(deviceId: string, log: number, count: number, before = 0): Promise<DataLogStatus> {
    return this.session(deviceId).client.dataLogRead(log, count, before);
  }

  async dataLogTest(deviceId: string, log: number): Promise<DataLogStatus> {
    return this.session(deviceId).client.dataLogTest(log);
  }

  /** Client of an online device (users, audit trail) */
  client(deviceId: string): DeviceClient {
    return this.session(deviceId).client;
  }

  async setSecret(deviceId: string, key: string, value: string): Promise<void> {
    await this.session(deviceId).client.setSecret(key, value);
  }

  async traceCertificate(deviceId: string, log: number, max: number): Promise<TraceCertificate> {
    return this.session(deviceId).client.traceCertificate(log, max);
  }

  private resolve(c: Compiled | undefined, path: string): SymbolNode | null {
    const p = path.trim();
    const address = parseAddress(p);
    if (address) {
      const size = { X: 1, B: 1, W: 2, D: 4 }[address.size];
      const vmType = { X: undefined, B: 1, W: 4, D: 6 }[address.size];
      return {
        name: p, type: address.size === 'X' ? 'Bool' : address.size === 'B' ? 'Byte' : address.size === 'W' ? 'Int' : 'DInt',
        kind: address.size === 'X' ? 'bool' : 'int', area: address.area, offset: address.byte, size,
        bit: address.size === 'X' ? address.bit : undefined, vmType,
      };
    }
    return c ? findSymbol(c.symbols, p.replace(/^#/, '')) : null;
  }

  private session(deviceId: string): Session {
    const s = this.sessions.get(deviceId);
    if (!s || !s.client.connected) {
      this.sessions.delete(deviceId);
      throw new Error('Not connected to the device (go online first)');
    }
    return s;
  }
}

function findDevice(project: Project, id: string) {
  const d = project.devices.find((x) => x.id === id);
  if (!d) throw new Error('Unknown device');
  return d;
}

/** Parses a value typed by the user in a watch table ("TRUE", "12", "1.5", "T#2s", "16#FF"). */
export function parseValue(symbol: SymbolNode, text: string): PlcValue {
  const t = text.trim();
  if (symbol.kind === 'bool' || symbol.bit !== undefined) {
    if (/^(true|1)$/i.test(t)) return true;
    if (/^(false|0)$/i.test(t)) return false;
    throw new Error(`'${text}' is not a Bool value (TRUE / FALSE)`);
  }
  if (symbol.kind === 'string') return t.replace(/^'(.*)'$/, '$1');
  // dates, times of day, LTIME: typed literal (D#2024-01-15, TOD#12:00:00, LT#5S...) or raw number
  const temporal = { ltime: 'LTIME', date: 'DATE', tod: 'TOD', ltod: 'LTOD', dt: 'DT', ldt: 'LDT' } as const;
  const tt = symbol.kind ? temporal[symbol.kind as keyof typeof temporal] : undefined;
  if (tt) {
    if (/^-?\d+$/.test(t)) return BigInt(t);
    const m = /^([A-Za-z_]+)#(.+)$/.exec(t);
    const type = m ? TEMPORAL_PREFIXES[m[1].toUpperCase()] : undefined;
    const v = type === tt ? parseTemporal(tt, m![2]) : null;
    if (v === null) throw new Error(`'${text}' is not a valid value (e.g. ${formatTemporal(tt, 0n)})`);
    return v;
  }
  if (symbol.kind === 'char') {
    const m = /^(?:W?CHAR#)?'(.)'$/iu.exec(t);
    if (m) return m[1].codePointAt(0)!;
    const n = /^(?:W?CHAR#)?(\d+)$/i.exec(t);
    if (n) return Number(n[1]);
    throw new Error(`'${text}' is not a character (e.g. 'A')`);
  }
  if (symbol.kind === 'time') {
    const m = /^(?:t|time)#(-)?(.+)$/i.exec(t);
    if (!m) {
      if (/^-?\d+$/.test(t)) return Number(t);
      throw new Error(`'${text}' is not a Time value (e.g. T#2S)`);
    }
    const factor: Record<string, number> = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
    const parts = [...m[2].replace(/_/g, '').toLowerCase().matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];
    return (m[1] ? -1 : 1) * Math.round(parts.reduce((s, p) => s + Number(p[1]) * factor[p[2]], 0));
  }
  const based = /^(2|8|16)#([0-9a-f_]+)$/i.exec(t);
  const n = based ? parseInt(based[2].replace(/_/g, ''), Number(based[1])) : Number(t);
  if (!Number.isFinite(n)) throw new Error(`'${text}' is not a number`);
  if (symbol.kind === 'int' && !Number.isInteger(n)) throw new Error(`'${text}' is not an integer`);
  return n;
}
