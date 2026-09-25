// Minimal EtherNet/IP adapter (target) for the tests of the scanner of vplc-cpu:
// RegisterSession, ListIdentity, Forward_Open / Forward_Close, cyclic class 1 I/O over UDP.
import { createServer, type Server, type Socket } from 'node:net';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';

export interface AdapterOptions {
  address: string;  // own address (e.g. 127.0.0.2, so that it can use UDP port 2222 next to the scanner)
  configInstance: number;
  outInstance: number;
  inInstance: number;
  outLength: number;
  inLength: number;
  vendorId?: number;
  productCode?: number;
}

interface Connection {
  otId: number;
  toId: number;
  serial: number;
  rpiUs: number;
  peer: string;
  timer: NodeJS.Timeout;
  seq: number;
  cipSeq: number;
}

export class EnipAdapter {
  readonly opts: AdapterOptions;
  /** Data produced (T->O) and last data consumed (O->T) */
  input: Buffer;
  output: Buffer;
  run = false;
  forwardOpens = 0;
  forwardCloses = 0;
  lastForwardOpen: Buffer | null = null;
  /** Stops answering on UDP (to test the connection timeout of the scanner) */
  mute = false;
  port = 0;
  private server: Server;
  private udp: UdpSocket;
  private conn: Connection | null = null;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
    this.input = Buffer.alloc(opts.inLength);
    this.output = Buffer.alloc(opts.outLength);
    this.server = createServer((s) => this.serve(s));
    this.udp = createSocket({ type: 'udp4', reuseAddr: true });
    this.udp.on('message', (m) => this.consume(m));
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.udp.bind(2222, this.opts.address, () => r()));
    await new Promise<void>((r) => this.server.listen(0, this.opts.address, () => r()));
    this.port = (this.server.address() as { port: number }).port;
  }

  close(): void {
    if (this.conn) clearInterval(this.conn.timer);
    this.server.close();
    this.udp.close();
  }

  get connected(): boolean {
    return this.conn !== null;
  }

  private serve(s: Socket): void {
    let buf = Buffer.alloc(0);
    s.on('error', () => undefined);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 24 && buf.length >= 24 + buf.readUInt16LE(2)) {
        const len = buf.readUInt16LE(2);
        const cmd = buf.readUInt16LE(0);
        const head = buf.subarray(0, 24);
        const body = buf.subarray(24, 24 + len);
        buf = buf.subarray(24 + len);
        this.encap(s, cmd, head, body);
      }
    });
  }

  private reply(s: Socket, head: Buffer, body: Buffer, session?: number): void {
    const h = Buffer.from(head);
    h.writeUInt16LE(body.length, 2);
    if (session !== undefined) h.writeUInt32LE(session, 4);
    s.write(Buffer.concat([h, body]));
  }

  private encap(s: Socket, cmd: number, head: Buffer, body: Buffer): void {
    if (cmd === 0x65) return this.reply(s, head, Buffer.from([1, 0, 0, 0]), 0x1234);
    if (cmd === 0x66) return;
    if (cmd !== 0x6f) return this.reply(s, head, Buffer.alloc(0));
    // SendRRData: interface (4), timeout (2), item count, null item, unconnected data item
    const len = body.readUInt16LE(14);
    const msg = body.subarray(16, 16 + len);
    const answer = this.cip(msg, s.remoteAddress ?? '127.0.0.1');
    const out = Buffer.alloc(16 + answer.length);
    out.writeUInt16LE(2, 6);
    out.writeUInt16LE(0xb2, 12);
    out.writeUInt16LE(answer.length, 14);
    answer.copy(out, 16);
    this.reply(s, head, out);
  }

  private error(service: number, general: number, extended?: number): Buffer {
    const b = Buffer.alloc(extended === undefined ? 4 : 6);
    b[0] = service | 0x80;
    b[2] = general;
    if (extended !== undefined) {
      b[3] = 1;
      b.writeUInt16LE(extended, 4);
    }
    return b;
  }

  private cip(msg: Buffer, peer: string): Buffer {
    const service = msg[0];
    const data = msg.subarray(2 + msg[1] * 2);
    if (service === 0x54) {
      this.forwardOpens++;
      this.lastForwardOpen = Buffer.from(data);
      const toId = data.readUInt32LE(6);
      const serial = data.readUInt16LE(10);
      const vendor = data.readUInt16LE(12);
      const origSerial = data.readUInt32LE(14);
      const rpiUs = data.readUInt32LE(22);
      const otSize = data.readUInt16LE(26) & 0x1ff;
      const toSize = data.readUInt16LE(32) & 0x1ff;
      const path = data.subarray(36, 36 + data[35] * 2);
      // electronic key, then 20 04 24 cfg 2C out 2C in
      let p = 0;
      if (path[0] === 0x34) {
        const v = path.readUInt16LE(2);
        const product = path.readUInt16LE(6);
        if ((this.opts.vendorId && v !== this.opts.vendorId) || (this.opts.productCode && product !== this.opts.productCode)) return this.error(0x54, 0x01, 0x0114);
        p = 10;
      }
      const cfg = path[p + 3], out = path[p + 5], inp = path[p + 7];
      if (cfg !== this.opts.configInstance || out !== this.opts.outInstance || inp !== this.opts.inInstance) return this.error(0x54, 0x01, 0x0117);
      if (otSize !== this.opts.outLength + 6) return this.error(0x54, 0x01, 0x0127);
      if (toSize !== this.opts.inLength + 2) return this.error(0x54, 0x01, 0x0128);
      if (this.conn) clearInterval(this.conn.timer);
      const otId = 0x10000 + Math.floor(Math.random() * 0xffff);
      const conn: Connection = { otId, toId, serial, rpiUs, peer, seq: 0, cipSeq: 0, timer: setInterval(() => this.produce(), Math.max(1, rpiUs / 1000)) };
      this.conn = conn;
      const r = Buffer.alloc(4 + 26);
      r[0] = 0xd4;
      r.writeUInt32LE(otId, 4);
      r.writeUInt32LE(toId, 8);
      r.writeUInt16LE(serial, 12);
      r.writeUInt16LE(vendor, 14);
      r.writeUInt32LE(origSerial, 16);
      r.writeUInt32LE(rpiUs, 20);
      r.writeUInt32LE(rpiUs, 24);
      return r;
    }
    if (service === 0x4e) {
      this.forwardCloses++;
      if (this.conn) clearInterval(this.conn.timer);
      this.conn = null;
      const r = Buffer.alloc(4 + 10);
      r[0] = 0xce;
      return r;
    }
    return this.error(service, 0x08);
  }

  private produce(): void {
    const c = this.conn;
    if (!c || this.mute) return;
    const p = Buffer.alloc(18 + 2 + this.input.length);
    p.writeUInt16LE(2, 0);
    p.writeUInt16LE(0x8002, 2);
    p.writeUInt16LE(8, 4);
    p.writeUInt32LE(c.toId, 6);
    p.writeUInt32LE(++c.seq, 10);
    p.writeUInt16LE(0xb1, 14);
    p.writeUInt16LE(2 + this.input.length, 16);
    p.writeUInt16LE(++c.cipSeq & 0xffff, 18);
    this.input.copy(p, 20);
    this.udp.send(p, 2222, c.peer);
  }

  private consume(m: Buffer): void {
    const c = this.conn;
    if (!c || m.length < 20 || m.readUInt16LE(2) !== 0x8002 || m.readUInt32LE(6) !== c.otId) return;
    const len = m.readUInt16LE(16);
    // sequence count (2), run/idle header (4), data
    this.run = (m.readUInt32LE(20) & 1) === 1;
    m.subarray(24, 18 + len).copy(this.output);
  }
}

/** ListIdentity answer of a simulated device (UDP 44818 on its own address) */
export async function identityResponder(address: string, name: string, port = 44818): Promise<{ close: () => void }> {
  const udp = createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (m, rinfo) => {
    if (m.length < 24 || m.readUInt16LE(0) !== 0x63) return;
    const id = Buffer.alloc(33 + name.length + 1);
    id.writeUInt16LE(1, 0);
    id.writeUInt16BE(2, 2);                 // sin_family
    id.writeUInt16BE(44818, 4);
    id.writeUInt16LE(0x1234, 18);           // vendor
    id.writeUInt16LE(43, 20);               // device type
    id.writeUInt16LE(17, 22);               // product
    id[24] = 2; id[25] = 3;                 // revision
    id.writeUInt32LE(0xa1b2c3d4, 28);       // serial
    id[32] = name.length;
    id.write(name, 33, 'latin1');
    const r = Buffer.alloc(24 + 6);
    r.writeUInt16LE(0x63, 0);
    r.writeUInt16LE(6 + id.length, 2);
    r.writeUInt16LE(1, 24);
    r.writeUInt16LE(0x0c, 26);
    r.writeUInt16LE(id.length, 28);
    udp.send(Buffer.concat([r, id]), rinfo.port, rinfo.address);
  });
  await new Promise<void>((res) => udp.bind(port, address, () => res()));
  return { close: () => udp.close() };
}
