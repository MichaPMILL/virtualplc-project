// Minimal S7 communication client (ISO-on-TCP) used to test the CPU's S7 server,
// the way an HMI configured with an "S7-300/400" connection talks to a PLC.
import { Socket } from 'node:net';

export const AREA = { I: 0x81, Q: 0x82, M: 0x83, DB: 0x84 } as const;

export class S7Client {
  private sock = new Socket();
  private buf = Buffer.alloc(0);
  private waiters: Array<(b: Buffer) => void> = [];
  private ref = 1;
  pdu = 0;

  async connect(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.sock.once('error', reject);
      this.sock.connect(port, host, () => resolve());
    });
    this.sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 4 && this.buf.length >= this.buf.readUInt16BE(2)) {
        const n = this.buf.readUInt16BE(2);
        const pkt = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        this.waiters.shift()?.(pkt);
      }
    });
    // COTP connection request: TPDU size 1024, calling TSAP 0x0100, called TSAP 0x0102 (rack 0, slot 2)
    const cr = Buffer.from([0x03, 0x00, 0x00, 0x16, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x01, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x01, 0x02]);
    const cc = await this.exchange(cr);
    if (cc[5] !== 0xd0) throw new Error('COTP connection refused');
    const setup = await this.job(Buffer.from([0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0]), Buffer.alloc(0));
    this.pdu = setup.param.readUInt16BE(6);
  }

  close(): void {
    this.sock.destroy();
  }

  private exchange(packet: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('S7 timeout')), 3000);
      this.waiters.push((b) => { clearTimeout(timer); resolve(b); });
      this.sock.write(packet);
    });
  }

  /** Sends an S7 job; returns the parameter and data of the ack_data. */
  async job(param: Buffer, data: Buffer): Promise<{ param: Buffer; data: Buffer; error: number }> {
    const header = Buffer.alloc(10);
    header[0] = 0x32;
    header[1] = 1;
    header.writeUInt16BE(this.ref++, 4);
    header.writeUInt16BE(param.length, 6);
    header.writeUInt16BE(data.length, 8);
    const s7 = Buffer.concat([header, param, data]);
    const tpkt = Buffer.concat([Buffer.from([3, 0, 0, 0, 2, 0xf0, 0x80]), s7]);
    tpkt.writeUInt16BE(tpkt.length, 2);
    const r = await this.exchange(tpkt);
    const s = r.subarray(7);
    const plen = s.readUInt16BE(6);
    const dlen = s.readUInt16BE(8);
    const error = s[10] << 8 | s[11];
    return { param: s.subarray(12, 12 + plen), data: s.subarray(12 + plen, 12 + plen + dlen), error };
  }

  private item(area: number, db: number, byte: number, bytes: number, bit?: number): Buffer {
    const it = Buffer.alloc(12);
    it[0] = 0x12; it[1] = 0x0a; it[2] = 0x10;
    it[3] = bit === undefined ? 0x02 : 0x01;
    it.writeUInt16BE(bit === undefined ? bytes : 1, 4);
    it.writeUInt16BE(db, 6);
    it[8] = area;
    const addr = byte * 8 + (bit ?? 0);
    it[9] = (addr >> 16) & 0xff; it[10] = (addr >> 8) & 0xff; it[11] = addr & 0xff;
    return it;
  }

  /** Reads bytes (or one bit); returns the item return code (0xff = ok) and the data. */
  async read(area: number, db: number, byte: number, bytes: number, bit?: number): Promise<{ code: number; data: Buffer }> {
    const r = await this.job(Buffer.concat([Buffer.from([0x04, 1]), this.item(area, db, byte, bytes, bit)]), Buffer.alloc(0));
    const code = r.data[0];
    const len = r.data[1] === 0x04 ? r.data.readUInt16BE(2) / 8 : r.data.readUInt16BE(2);
    return { code, data: r.data.subarray(4, 4 + (code === 0xff ? len : 0)) };
  }

  /** Writes bytes (or one bit); returns the item return code (0xff = ok). */
  async write(area: number, db: number, byte: number, value: Buffer, bit?: number): Promise<number> {
    const head = Buffer.alloc(4);
    head[1] = bit === undefined ? 0x04 : 0x03;
    head.writeUInt16BE(bit === undefined ? value.length * 8 : 1, 2);
    const r = await this.job(Buffer.concat([Buffer.from([0x05, 1]), this.item(area, db, byte, value.length, bit)]), Buffer.concat([head, value]));
    return r.data[0];
  }
}
