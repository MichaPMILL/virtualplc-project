// Simulated PROFIBUS DP slave (DP-V0) on a serial port, for the tests of the DP master of vplc-cpu.
import { SerialPort } from 'serialport';

export interface DpSlaveOptions {
  path: string;
  station: number;
  identNumber: number;
  /** Expected configuration identifiers (Chk_Cfg) */
  config: number[];
  inLength: number;
  outLength: number;
}

export class DpSlave {
  readonly opts: DpSlaveOptions;
  inputs: Buffer;
  outputs: Buffer;
  prm: Buffer | null = null;
  state: 'wait-prm' | 'wait-cfg' | 'data' = 'wait-prm';
  cfgFault = false;
  prmFault = false;
  /** Pending extended diagnosis (reported with a high-priority answer) */
  extDiag: number[] | null = null;
  mute = false;
  exchanges = 0;
  private port: SerialPort;
  private buf = Buffer.alloc(0);

  constructor(opts: DpSlaveOptions) {
    this.opts = opts;
    this.inputs = Buffer.alloc(opts.inLength);
    this.outputs = Buffer.alloc(opts.outLength);
    this.port = new SerialPort({ path: opts.path, baudRate: 115200, autoOpen: false });
  }

  async open(): Promise<void> {
    await new Promise<void>((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
    this.port.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
  }

  close(): void {
    if (this.port.isOpen) this.port.close();
  }

  private send(frame: number[]): void {
    if (!this.mute) this.port.write(Buffer.from(frame));
  }

  private sd2(da: number, sa: number, fc: number, data: number[], sap?: [number, number]): number[] {
    const body = [sap ? da | 0x80 : da, sap ? sa | 0x80 : sa, fc, ...(sap ?? []), ...data];
    const fcs = body.reduce((a, b) => (a + b) & 0xff, 0);
    return [0x68, body.length, body.length, 0x68, ...body, fcs, 0x16];
  }

  private diag(master: number): number[] {
    const s1 = (this.state !== 'data' && this.state !== 'wait-cfg' && !this.prm ? 0 : 0) | (this.cfgFault ? 0x04 : 0) | (this.prmFault ? 0x40 : 0) | (this.extDiag ? 0x08 : 0);
    const s2 = 0x04 | (this.state === 'wait-prm' ? 0x01 : 0) | (this.prm && this.prm[0] & 0x08 ? 0x08 : 0);
    return [s1, s2, 0, this.state === 'data' ? master : 0xff, this.opts.identNumber >> 8, this.opts.identNumber & 0xff, ...(this.extDiag ?? [])];
  }

  private parse(): void {
    for (;;) {
      if (!this.buf.length) return;
      const sd = this.buf[0];
      let len = 0;
      if (sd === 0x10) len = 6;
      else if (sd === 0x68) {
        if (this.buf.length < 4) return;
        len = this.buf[1] + 6;
      } else { this.buf = this.buf.subarray(1); continue; }
      if (this.buf.length < len) return;
      const f = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      this.handle(f);
    }
  }

  private handle(f: Buffer): void {
    let da: number, sa: number, data: Buffer;
    if (f[0] === 0x10) {
      [da, sa] = [f[1], f[2]];
      data = Buffer.alloc(0);
    } else {
      [da, sa] = [f[4], f[5]];
      data = f.subarray(7, f.length - 2);
    }
    if ((da & 0x7f) !== this.opts.station) return;
    const master = sa & 0x7f;
    let dsap = -1;
    let ssap = -1;
    if (da & 0x80) { dsap = data[0]; data = data.subarray(1); }
    if (sa & 0x80) { ssap = data[0]; data = data.subarray(1); }
    const me = this.opts.station;
    if (dsap === 60) {  // Slave_Diag
      this.send(this.sd2(master, me, 0x08, this.diag(master), [ssap, 60]));
      if (this.extDiag && this.state === 'data') this.extDiag = null;
      return;
    }
    if (dsap === 61) {  // Set_Prm
      const ident = data[4] << 8 | data[5];
      this.prmFault = ident !== this.opts.identNumber;
      this.prm = Buffer.from(data);
      this.state = this.prmFault ? 'wait-prm' : 'wait-cfg';
      this.send([0xe5]);
      return;
    }
    if (dsap === 62) {  // Chk_Cfg
      this.cfgFault = data.length !== this.opts.config.length || this.opts.config.some((b, i) => data[i] !== b);
      if (this.state === 'wait-cfg' && !this.cfgFault) this.state = 'data';
      this.send([0xe5]);
      return;
    }
    if (dsap === -1 && this.state === 'data') {  // Data_Exchange
      data.copy(this.outputs, 0, 0, Math.min(data.length, this.outputs.length));
      this.exchanges++;
      this.send(this.sd2(master, me, this.extDiag ? 0x0a : 0x08, [...this.inputs]));
    }
  }
}
