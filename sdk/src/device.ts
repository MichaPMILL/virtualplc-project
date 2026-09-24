// Client of the VirtualPLC device protocol (docs/protocol.md) over TCP.
import { Socket } from 'node:net';
import { crc32 } from './crc32.ts';
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
  io: Array<{ module: number; ok: boolean }>;
}

export interface LogEntry {
  seq: number;
  t: number;
  msg: string;
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

export class DeviceClient {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending: Pending | null = null;
  readonly host: string;
  readonly port: number;
  timeoutMs = 5000;
  maxPayload = 1024;

  constructor(host: string, port = PROTOCOL_PORT) {
    this.host = host;
    this.port = port;
  }

  async connect(password?: string): Promise<DeviceInfo> {
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
        this.socket = socket;
        resolve();
      });
    });
    const info = await this.info();
    this.maxPayload = Math.max(64, info.maxPayload);
    if (info.auth) {
      if (!password) throw new DeviceError('The device requires a password', Status.UNAUTHORIZED);
      await this.request(Command.AUTH, Buffer.from(password, 'utf8'));
    }
    return info;
  }

  close(): void {
    this.socket?.removeAllListeners('close');
    this.socket?.destroy();
    this.socket = null;
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

  /** Downloads a program image (the CPU goes to STOP; call start() afterwards). */
  async download(image: Uint8Array, onProgress?: (sent: number, total: number) => void): Promise<void> {
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
    await this.request(Command.DOWNLOAD_END, Buffer.alloc(0), 30000);
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
          this.close();
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
        this.fail(new Error('Invalid response from the device'));
        return;
      }
      const len = this.buffer.readUInt32LE(5);
      if (this.buffer.length < 13 + len) return;
      const frame = this.buffer.subarray(0, 13 + len);
      this.buffer = this.buffer.subarray(13 + len);
      if (crc32(frame.subarray(2, 9 + len)) !== frame.readUInt32LE(9 + len)) {
        this.fail(new Error('Corrupted response from the device'));
        return;
      }
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
    this.socket?.destroy();
    this.socket = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(e);
    }
  }
}
