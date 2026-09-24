/** Growable little-endian byte buffer. */
export class ByteWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.length, v & 0xff);
    this.length += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v & 0xffff, true);
    this.length += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.length, v | 0, true);
    this.length += 4;
    return this;
  }

  i64(v: number | bigint): this {
    this.ensure(8);
    this.view.setBigInt64(this.length, BigInt.asIntN(64, BigInt(v)), true);
    this.length += 8;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  str8(s: string): this {
    const b = new TextEncoder().encode(s).subarray(0, 255);
    return this.u8(b.length).bytes(b);
  }

  patchI32(at: number, v: number): void {
    this.view.setInt32(at, v | 0, true);
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Big-endian writes into a fixed memory image (PLC data memory). */
export class MemoryImage {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  used = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  write(offset: number, vmSize: number, kind: 'int' | 'float', value: number): void {
    this.used = Math.max(this.used, offset + vmSize);
    if (kind === 'float') {
      if (vmSize === 4) this.view.setFloat32(offset, value);
      else this.view.setFloat64(offset, value);
      return;
    }
    switch (vmSize) {
      case 1:
        this.view.setUint8(offset, value & 0xff);
        break;
      case 2:
        this.view.setUint16(offset, value & 0xffff);
        break;
      case 4:
        this.view.setUint32(offset, value >>> 0);
        break;
      default:
        this.view.setBigInt64(offset, BigInt.asIntN(64, BigInt(Math.trunc(value))));
    }
  }

  writeBytes(offset: number, data: Uint8Array): void {
    this.bytes.set(data, offset);
    this.used = Math.max(this.used, offset + data.length);
  }
}
