// Client of the VirtualPLC device protocol (docs/protocol.md) over TCP, or over a serial
// link (USB) for microcontroller CPUs: the host is then a serial port (COM3, /dev/ttyUSB0…)
// and the port number the speed in bauds.
import { Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { crc32 } from './crc32.ts';
import { BAUD_RATES, DEFAULT_BAUD, isSerialPort, isSimulatorHost } from './serial.ts';
import { simulator } from './simulator.ts';
import type { TraceCertificate, TraceRecord } from './datalog.ts';
import type { AuditLog, Role, UserAccount } from './security.ts';
import { ROLES } from './security.ts';

export { isSerialPort, isSimulatorHost };
import { Area, Command, PROTOCOL_PORT, Status } from './isa.ts';
import type { SymbolNode } from './symbols.ts';
import { decodeValue, encodeValue, type PlcValue } from './values.ts';

export interface DeviceInfo {
  protocol: number;
  device: string;
  firmware: string;
  name: string;
  maxPayload: number;
  maxProgram: number;
  maxData: number;
  auth: boolean;
  /** The CPU has user accounts (user name + password, roles) */
  users?: boolean;
  /** After connect(): logged-in user and role */
  user?: string;
  role?: Role;
  /** After connect(): public key of the CPU (hex) when the link is encrypted (TLS) */
  key?: string;
}


export interface DeviceState {
  state: 'NO_PROGRAM' | 'STOP' | 'RUN' | 'FAULT';
  programId: string | null;
  programName?: string;
  cycleMs?: number;
  scans: number;
  scanUs: number;
  maxScanUs: number;
  forces: number;
  logSeq: number;
  uptimeMs: number;
  fault: { code: string; function: number; line: number; pc: number } | null;
  /** I/O modules: connection state, diagnostic text (PROFINET: state, active diagnoses, neighbour) */
  io: Array<{ module: number; ok: boolean; diag?: string }>;
}

export interface LogEntry {
  seq: number;
  t: number;
  msg: string;
}

/** State and latest records of a data log (DATALOG_READ) */
export interface DataLogStatus {
  name?: string;
  plc?: string;
  epoch?: number;
  records?: number;
  pending?: number;
  destination?: string;
  connected?: boolean;
  forwarded?: number;
  lastSync?: string;
  password?: boolean;
  error?: string;
  columns?: string[];
  kinds?: Array<'bool' | 'int' | 'real' | 'text'>;
  /** Ed25519 public key of the CPU (hex) */
  publicKey?: string;
  /**
   * [record id, time (ISO), ...values, chain (16 first hex digits), forwarded];
   * full rows: [record id, time (ns), ...values, chain, forwarded, signature]
   */
  rows?: Array<Array<string | number | boolean | null>>;
}

export class DeviceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DeviceError';
    this.status = status;
  }
}

const AREA_CODES = { D: Area.D, I: Area.I, Q: Area.Q, M: Area.M } as const;
type AreaName = keyof typeof AREA_CODES;

interface Pending {
  seq: number;
  resolve: (r: { status: number; payload: Buffer }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Byte stream to the device (TCP socket or serial port). */
interface Link {
  write(data: Buffer): void;
  destroy(): void;
}

export class DeviceClient {
  private socket: Link | null = null;
  private serial = false;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  readonly host: string;
  readonly port: number;
  timeoutMs = 5000;
  maxPayload = 1024;
  /**
   * Encryption of the TCP link: 'auto' tries TLS and falls back to the plain protocol for
   * CPUs without TLS (microcontrollers) unless a key is pinned; 'on' requires TLS.
   */
  tls: 'auto' | 'on' | 'off' = 'auto';
  /** Expected public key of the CPU (hex, pinned at the first connection): TLS is then required */
  pinnedKey?: string;
  /** Public key of the CPU seen during the TLS handshake (hex), null on a plain link */
  peerKey: string | null = null;

  constructor(host: string, port = PROTOCOL_PORT) {
    this.host = host;
    this.port = port;
  }

  /**
   * Opens the connection. CPUs with user accounts need `user` and `password`; CPUs with
   * a single password accept the password alone (user "admin").
   */
  async connect(password?: string, user?: string): Promise<DeviceInfo> {
    let info: DeviceInfo;
    if (isSerialPort(this.host)) {
      info = await this.connectSerial();
    } else if (isSimulatorHost(this.host)) {
      const sim = await simulator();
      this.socket = sim.connect((d) => this.onData(d));
      info = await this.info();
    } else {
      await this.connectTcp();
      info = await this.info();
    }
    this.maxPayload = Math.max(64, info.maxPayload);
    if (this.peerKey) info.key = this.peerKey;
    if (info.auth) {
      if (!password) {
        throw new DeviceError(info.users ? 'The device requires a user name and a password' : 'The device requires a password', Status.UNAUTHORIZED);
      }
      const payload = user
        ? Buffer.concat([Buffer.from(user, 'utf8'), Buffer.from([0]), Buffer.from(password, 'utf8')])
        : Buffer.from(password, 'utf8');
      const r = (await this.request(Command.AUTH, payload)).toString('utf8');
      try {
        const who = JSON.parse(r) as { user?: string; role?: Role };
        if (who.user) info.user = who.user;
        if (who.role) info.role = who.role;
      } catch {
        // older CPUs answer nothing
      }
    }
    return info;
  }

  /** Serial link: opening the port may restart the board, so INFO is retried while it boots. */
  private async connectSerial(): Promise<DeviceInfo> {
    let SerialPort: typeof import('serialport').SerialPort;
    try {
      ({ SerialPort } = await import('serialport'));
    } catch {
      throw new Error('Serial links are not available in this installation (serialport module missing)');
    }
    const baudRate = BAUD_RATES.includes(this.port) ? this.port : DEFAULT_BAUD;
    const port = new SerialPort({ path: this.host.trim(), baudRate, autoOpen: false, hupcl: false });
    await new Promise<void>((resolve, reject) => port.open((e) => (e ? reject(new Error(`Cannot open ${this.host}: ${e.message}`)) : resolve())));
    // ESP32 boards: DTR / RTS drive EN / IO0 — keep the board running normally
    await new Promise<void>((resolve) => port.set({ dtr: false, rts: false }, () => resolve()));
    port.on('data', (d: Buffer) => this.onData(d));
    port.on('error', (e: Error) => this.fail(e));
    port.on('close', () => this.fail(new Error('Serial link closed')));
    this.serial = true;
    this.socket = { write: (d) => port.write(d), destroy: () => { port.removeAllListeners('close'); if (port.isOpen) port.close(); } };
    const saved = this.timeoutMs;
    try {
      for (let attempt = 0; ; attempt++) {
        this.timeoutMs = 1000;
        try {
          return await this.info();
        } catch (e) {
          if (attempt >= 5 || !this.socket) throw new Error(`No answer from a VirtualPLC CPU on ${this.host} at ${baudRate} bauds`);
          this.buffer = Buffer.alloc(0);
        }
      }
    } finally {
      this.timeoutMs = saved;
    }
  }

  get encrypted(): boolean {
    return this.peerKey !== null;
  }

  private async connectTcp(): Promise<void> {
    this.peerKey = null;
    if (this.tls !== 'off' || this.pinnedKey) {
      try {
        await this.connectTls();
        return;
      } catch (e) {
        if (e instanceof DeviceError || this.tls === 'on' || this.pinnedKey) throw e;
        // 'auto': CPU without TLS (it closes the link on the TLS hello)
      }
    }
    await this.connectPlain();
  }

  private async connectTls(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // The certificate is self-signed by the CPU: its key is checked against the pinned one
      const socket: TLSSocket = tlsConnect({ host: this.host, port: this.port, rejectUnauthorized: false, minVersion: 'TLSv1.2', servername: undefined });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`TLS connection to ${this.host}:${this.port} timed out`));
      }, this.timeoutMs);
      const early = (e: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error(`Cannot connect to ${this.host}:${this.port} with TLS: ${e.message}`));
      };
      socket.once('error', early);
      socket.once('close', () => early(new Error('closed during the handshake')));
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        let key = '';
        try {
          const jwk = socket.getPeerX509Certificate()?.publicKey.export({ format: 'jwk' }) as { crv?: string; x?: string } | undefined;
          if (jwk?.crv === 'Ed25519' && jwk.x) key = Buffer.from(jwk.x, 'base64url').toString('hex');
        } catch {
          key = '';
        }
        if (!key || (this.pinnedKey && key !== this.pinnedKey.toLowerCase())) {
          socket.destroy();
          reject(new DeviceError(
            key ? `The key of the CPU at ${this.host} is not the expected one: another device answers at this address, or the CPU was replaced or reset. Check the key fingerprint on the CPU before trusting it.`
              : `The CPU at ${this.host} did not present an identity key`,
            Status.UNAUTHORIZED));
          return;
        }
        this.peerKey = key;
        socket.setNoDelay(true);
        socket.on('error', (e) => this.fail(e));
        socket.on('close', () => this.fail(new Error('Connection closed by the device')));
        socket.on('data', (d) => this.onData(d));
        this.socket = { write: (d) => socket.write(d), destroy: () => socket.destroy() };
        resolve();
      });
    });
  }

  private async connectPlain(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection to ${this.host}:${this.port} timed out`));
      }, this.timeoutMs);
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Cannot connect to ${this.host}:${this.port}: ${e.message}`));
      });
      socket.connect(this.port, this.host, () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        socket.removeAllListeners('error');
        socket.on('error', (e) => this.fail(e));
        socket.on('close', () => this.fail(new Error('Connection closed by the device')));
        socket.on('data', (d) => this.onData(d));
        this.socket = { write: (d) => socket.write(d), destroy: () => socket.destroy() };
        resolve();
      });
    });
  }

  close(): void {
    const link = this.socket;
    this.socket = null;
    link?.destroy();
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  async info(): Promise<DeviceInfo> {
    return JSON.parse((await this.request(Command.INFO)).toString('utf8'));
  }

  async state(): Promise<DeviceState> {
    return JSON.parse((await this.request(Command.STATE)).toString('utf8'));
  }

  async start(cold = false): Promise<void> {
    await this.request(Command.START, Buffer.from([cold ? 1 : 0]));
  }

  async stop(): Promise<void> {
    await this.request(Command.STOP);
  }

  async logs(from = 0): Promise<LogEntry[]> {
    const p = Buffer.alloc(4);
    p.writeUInt32LE(from);
    return JSON.parse((await this.request(Command.LOGS, p)).toString('utf8'));
  }

  /** Traceability: state and latest records of a data log (newest first; `before` = record id). */
  async dataLogRead(log: number, count = 20, before = 0, full = false): Promise<DataLogStatus> {
    const p = Buffer.alloc(13);
    p.writeUInt8(full ? 1 : 0, 12);
    p.writeUInt16LE(log, 0);
    p.writeUInt16LE(count, 2);
    p.writeUInt32LE(before % 2 ** 32, 4);
    p.writeUInt32LE(Math.floor(before / 2 ** 32), 8);
    return JSON.parse((await this.request(Command.DATALOG_READ, p)).toString('utf8'));
  }

  /**
   * Traceability certificate of the latest `max` records of a data log (all of them when they
   * fit), to give to a customer (verifyTraceCertificate).
   */
  async traceCertificate(log: number, max = 1000): Promise<TraceCertificate> {
    const first = await this.dataLogRead(log, 0, 0, true);
    if (first.error && !first.columns) throw new Error(first.error);
    const records: TraceRecord[] = [];
    let before = 0;
    let previous: string | undefined;
    const n = first.columns?.length ?? 0;
    while (records.length < max) {
      const page = await this.dataLogRead(log, Math.min(40, max - records.length + 1), before, true);
      const rows = page.rows ?? [];
      if (!rows.length) break;
      for (const row of rows) {
        const record: TraceRecord = { recordId: String(row[0]), tsNs: String(row[1]), values: row.slice(2, 2 + n) as TraceRecord['values'], chain: String(row[2 + n]), sig: String(row[4 + n] ?? '') };
        if (records.length === max) {
          previous = record.chain;
          break;
        }
        records.push(record);
      }
      before = Number(rows[rows.length - 1][0]);
      if (previous !== undefined || before <= 1) break;
    }
    records.reverse();
    if (previous === undefined && records.length && BigInt(records[0].recordId) > 1n) {
      // records deleted by the retention time: the chain continues from the one before
      const older = await this.dataLogRead(log, 1, Number(records[0].recordId), true);
      if (older.rows?.length) previous = String(older.rows[0][2 + n]);
    }
    return {
      format: 'virtualplc-trace', version: 1, plc: first.plc ?? '', log: first.name ?? '', epoch: first.epoch ?? 0,
      columns: first.columns ?? [], kinds: first.kinds ?? [], publicKey: first.publicKey ?? '',
      ...(previous !== undefined ? { previous } : {}), created: new Date().toISOString(), records,
    };
  }

  /** Traceability: connects now to the database of the data log (state as dataLogRead). */
  async dataLogTest(log: number): Promise<DataLogStatus> {
    const p = Buffer.alloc(2);
    p.writeUInt16LE(log, 0);
    return JSON.parse((await this.request(Command.DATALOG_TEST, p)).toString('utf8'));
  }

  private async usersRequest(op: number, ...fields: string[]): Promise<Record<string, unknown>> {
    const parts: Buffer[] = [Buffer.from([op])];
    fields.forEach((f, k) => {
      if (k) parts.push(Buffer.from([0]));
      parts.push(Buffer.from(f, 'utf8'));
    });
    const r = (await this.request(Command.USERS, Buffer.concat(parts))).toString('utf8');
    return r ? JSON.parse(r) : {};
  }

  /** User accounts of the CPU (an administrator sees all, the others see themselves). */
  async users(): Promise<{ users: UserAccount[]; self: string }> {
    const r = await this.usersRequest(0);
    return { users: (r.users as UserAccount[]) ?? [], self: String(r.self ?? '') };
  }

  /** Creates or replaces a user (administrator). */
  async setUser(name: string, password: string, role: Role): Promise<void> {
    await this.usersRequest(1, name, password, String(ROLES.indexOf(role) + 1));
  }

  /** Deletes a user (administrator; the last administrator cannot be deleted). */
  async deleteUser(name: string): Promise<void> {
    await this.usersRequest(2, name);
  }

  /** Sets a new password for a user (administrator). */
  async resetPassword(name: string, password: string): Promise<void> {
    await this.usersRequest(3, name, password);
  }

  /** Changes the password of the logged-in user. */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.usersRequest(4, oldPassword, newPassword);
  }

  /** Engineering keys trusted by the CPU for signed programs */
  async trustedKeys(): Promise<{ required: boolean; keys: Array<{ name: string; key: string }> }> {
    const r = await this.usersRequest(5);
    return { required: r.required === true, keys: (r.keys as Array<{ name: string; key: string }>) ?? [] };
  }

  /** Trusts an engineering public key (hex) for signed programs (administrator). */
  async trustKey(name: string, publicKey: string): Promise<void> {
    await this.usersRequest(6, name, publicKey);
  }

  async untrustKey(name: string): Promise<void> {
    await this.usersRequest(7, name);
  }

  /** Audit trail: the last `count` records, or the records from sequence number `from`. */
  async auditRead(count = 50, from = 0): Promise<AuditLog> {
    const p = Buffer.alloc(6);
    p.writeUInt32LE(from, 0);
    p.writeUInt16LE(count, 4);
    const r = JSON.parse((await this.request(Command.AUDIT_READ, p)).toString('utf8')) as AuditLog;
    r.records ??= [];
    return r;
  }

  /** Whole audit trail kept by the CPU from sequence number `from` (several requests). */
  async auditReadAll(from = 1, max = 100000): Promise<AuditLog> {
    const all: AuditLog = { records: [] };
    for (let next = from; all.records.length < max;) {
      const page = await this.auditRead(500, next);
      Object.assign(all, { plc: page.plc, key: page.key, first: page.first, last: page.last });
      if (!page.records.length) break;
      all.records.push(...page.records);
      next = page.records[page.records.length - 1].seq + 1;
    }
    return all;
  }

  /** Stores credentials on the CPU (database password): they never leave the CPU again. */
  async setSecret(key: string, value: string): Promise<void> {
    const k = Buffer.from(key, 'utf8');
    const v = Buffer.from(value, 'utf8');
    if (k.length > 255 || v.length > 255) throw new Error('Key or value too long');
    const p = Buffer.alloc(3 + k.length + v.length);
    p.writeUInt8(k.length, 0);
    k.copy(p, 1);
    p.writeUInt16LE(v.length, 1 + k.length);
    v.copy(p, 3 + k.length);
    await this.request(Command.SET_SECRET, p);
  }

  /**
   * Downloads a program image (the CPU goes to STOP; call start() afterwards). `signature`:
   * from signProgram() (CPUs started with --signed-programs refuse unsigned programs).
   */
  async download(image: Uint8Array, onProgress?: (sent: number, total: number) => void, signature?: Uint8Array): Promise<void> {
    const begin = Buffer.alloc(8);
    begin.writeUInt32LE(image.length, 0);
    begin.writeUInt32LE(crc32(image), 4);
    await this.request(Command.DOWNLOAD_BEGIN, begin);
    const chunk = this.maxPayload - 4;
    for (let off = 0; off < image.length; off += chunk) {
      const part = image.subarray(off, Math.min(image.length, off + chunk));
      const p = Buffer.alloc(4 + part.length);
      p.writeUInt32LE(off, 0);
      p.set(part, 4);
      await this.request(Command.DOWNLOAD_CHUNK, p);
      onProgress?.(off + part.length, image.length);
    }
    await this.request(Command.DOWNLOAD_END, signature ? Buffer.from(signature) : Buffer.alloc(0), 30000);
  }

  /** Uploads the program image stored in the CPU. */
  async upload(): Promise<Uint8Array> {
    const parts: Buffer[] = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const p = Buffer.alloc(4);
      p.writeUInt32LE(offset);
      const r = await this.request(Command.UPLOAD, p);
      total = r.readUInt32LE(0);
      const data = r.subarray(4);
      if (data.length === 0 && offset < total) throw new Error('Upload interrupted');
      parts.push(data);
      offset += data.length;
    }
    return new Uint8Array(Buffer.concat(parts));
  }

  /** Reads several memory ranges in one request. */
  async read(ranges: Array<{ area: AreaName; offset: number; length: number }>): Promise<Buffer[]> {
    const out: Buffer[] = [];
    // Split into requests that fit in a response
    let batch: typeof ranges = [];
    let size = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const p = Buffer.alloc(batch.length * 7);
      batch.forEach((r, i) => {
        p.writeUInt8(AREA_CODES[r.area], i * 7);
        p.writeUInt32LE(r.offset, i * 7 + 1);
        p.writeUInt16LE(r.length, i * 7 + 5);
      });
      const data = await this.request(Command.READ, p);
      let pos = 0;
      for (const r of batch) {
        out.push(data.subarray(pos, pos + r.length));
        pos += r.length;
      }
      batch = [];
      size = 0;
    };
    for (const r of ranges) {
      if (r.length > this.maxPayload) throw new Error('Range too large');
      if (size + r.length > this.maxPayload || (batch.length + 1) * 7 > this.maxPayload) await flush();
      batch.push(r);
      size += r.length;
    }
    await flush();
    return out;
  }

  /** Reads the values of symbols (from CompileResult.symbols). */
  async readSymbols(symbols: SymbolNode[]): Promise<PlcValue[]> {
    const data = await this.read(symbols.map((s) => ({ area: s.area, offset: s.offset, length: s.size })));
    return symbols.map((s, i) => decodeValue(s, new Uint8Array(data[i])));
  }

  async writeSymbol(symbol: SymbolNode, value: PlcValue): Promise<void> {
    if (symbol.bit !== undefined) {
      await this.writeRaw([{ area: symbol.area, offset: symbol.offset, bit: symbol.bit, data: Buffer.from([value ? 1 : 0]) }]);
    } else {
      await this.writeRaw([{ area: symbol.area, offset: symbol.offset, data: Buffer.from(encodeValue(symbol, value)) }]);
    }
  }

  async writeRaw(items: Array<{ area: AreaName; offset: number; bit?: number; data: Uint8Array }>): Promise<void> {
    const parts = items.map((it) => {
      const h = Buffer.alloc(8);
      h.writeUInt8(AREA_CODES[it.area], 0);
      h.writeUInt32LE(it.offset, 1);
      h.writeUInt8(it.bit ?? 0xff, 5);
      h.writeUInt16LE(it.data.length, 6);
      return Buffer.concat([h, Buffer.from(it.data)]);
    });
    await this.request(Command.WRITE, Buffer.concat(parts));
  }

  /** Forces a bit of %I or %Q; value null removes the force. */
  async force(area: 'I' | 'Q', byte: number, bit: number, value: boolean | null): Promise<void> {
    const p = Buffer.alloc(7);
    p.writeUInt8(AREA_CODES[area], 0);
    p.writeUInt32LE(byte, 1);
    p.writeUInt8(bit, 5);
    p.writeUInt8(value === null ? 2 : value ? 1 : 0, 6);
    await this.request(Command.FORCE, p);
  }

  async unforceAll(): Promise<void> {
    await this.request(Command.UNFORCE_ALL);
  }

  // --------------------------------------------------------------------------

  /** Sends one request; requests are serialised (one in flight). */
  request(command: number, payload: Uint8Array = Buffer.alloc(0), timeoutMs = this.timeoutMs): Promise<Buffer> {
    const run = async () => {
      if (!this.socket) throw new Error('Not connected');
      const seq = (this.seq = (this.seq + 1) & 0xff);
      const header = Buffer.alloc(8);
      header.write('VP', 0, 'latin1');
      header.writeUInt8(command, 2);
      header.writeUInt8(seq, 3);
      header.writeUInt32LE(payload.length, 4);
      const body = Buffer.concat([header.subarray(2), Buffer.from(payload)]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32LE(crc32(body));
      const response = await new Promise<{ status: number; payload: Buffer }>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new Error('The device did not answer in time'));
          // a serial link stays open (the board may still be starting); TCP reconnects
          if (!this.serial) this.close();
        }, timeoutMs);
        this.pending = { seq, resolve, reject, timer };
        this.socket!.write(Buffer.concat([header, Buffer.from(payload), crc]));
      });
      if (response.status !== Status.OK) {
        const names = Object.fromEntries(Object.entries(Status).map(([k, v]) => [v, k]));
        throw new DeviceError(response.payload.toString('utf8') || names[response.status] || 'error', response.status);
      }
      return response.payload;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 13) {
      if (this.buffer[0] !== 0x56 || this.buffer[1] !== 0x52) {
        if (this.serial) {
          // boot messages or noise on a serial link: resynchronise on the next "VR"
          const next = this.buffer.indexOf('VR', 1, 'latin1');
          this.buffer = next < 0 ? this.buffer.subarray(this.buffer.length - 1) : this.buffer.subarray(next);
          continue;
        }
        this.fail(new Error('Invalid response from the device'));
        return;
      }
      const len = this.buffer.readUInt32LE(5);
      if (this.serial && len > Math.max(this.maxPayload, 65536) + 16) {
        this.buffer = this.buffer.subarray(1);  // noise that looked like a header
        continue;
      }
      if (this.buffer.length < 13 + len) return;
      const frame = this.buffer.subarray(0, 13 + len);
      if (crc32(frame.subarray(2, 9 + len)) !== frame.readUInt32LE(9 + len)) {
        if (this.serial) {
          this.buffer = this.buffer.subarray(1);  // false start: search again
          continue;
        }
        this.fail(new Error('Corrupted response from the device'));
        return;
      }
      this.buffer = this.buffer.subarray(13 + len);
      const p = this.pending;
      if (p && frame[3] === p.seq) {
        clearTimeout(p.timer);
        this.pending = null;
        p.resolve({ status: frame[4], payload: Buffer.from(frame.subarray(9, 9 + len)) });
      }
    }
  }

  private fail(e: Error): void {
    const p = this.pending;
    this.pending = null;
    const link = this.socket;
    this.socket = null;
    link?.destroy();
    if (p) {
      clearTimeout(p.timer);
      p.reject(e);
    }
  }
}
