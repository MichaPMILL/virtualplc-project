import { ByteWriter } from './bytes.ts';
import { crc32 } from './crc32.ts';
import { IoModule, ISA_VERSION, Section } from './isa.ts';

export interface FunctionEntry {
  codeOffset: number;
  frameOffset: number;
  frameSize: number;
}

export interface LineEntry {
  pc: number;
  func: number;
  line: number;
}

interface IoRange {
  /** First byte in the process image */
  byte: number;
  count: number;
}

/** An I/O module of the device configuration. */
export type IoModuleConfig =
  | { kind: 'modbus-tcp'; name: string; host: string; port?: number; unit?: number; pollMs?: number; di?: IoRange; coils?: IoRange; ir?: IoRange; hr?: IoRange }
  | { kind: 'gpio-di'; name: string; pin: number; byte: number; bit: number; invert?: boolean; pullup?: boolean }
  | { kind: 'gpio-do'; name: string; pin: number; byte: number; bit: number; invert?: boolean }
  | { kind: 'gpio-ai'; name: string; pin: number; byte: number }
  | { kind: 'gpio-ao'; name: string; pin: number; byte: number };

export interface ImageInput {
  name: string;
  compilerVersion: string;
  buildTime: number;
  dataSize: number;
  imageSizes: { I: number; Q: number; M: number };
  stackCells: number;
  callDepth: number;
  cycleMs: number;
  code: Uint8Array;
  consts: Uint8Array;
  init: Uint8Array;
  functions: FunctionEntry[];
  startup: number;
  main: number;
  lines: LineEntry[];
  hardware: IoModuleConfig[];
}

/** Serialises a program image (see docs/bytecode.md). */
export function buildImage(p: ImageInput): Uint8Array {
  const sections: Array<[number, Uint8Array]> = [];
  const section = (type: number, fill: (w: ByteWriter) => void) => {
    const w = new ByteWriter();
    fill(w);
    sections.push([type, w.toBytes()]);
  };

  section(Section.META, (w) => w.str8(p.name).str8(p.compilerVersion).u32(p.buildTime));
  section(Section.LIMITS, (w) => w.u32(p.dataSize).u16(p.imageSizes.I).u16(p.imageSizes.Q).u16(p.imageSizes.M).u16(p.stackCells).u16(p.callDepth).u16(p.cycleMs));
  section(Section.CODE, (w) => w.bytes(p.code));
  section(Section.CONST, (w) => w.bytes(p.consts));
  section(Section.INIT, (w) => w.bytes(p.init));
  section(Section.FUNCS, (w) => {
    w.u16(p.functions.length);
    for (const f of p.functions) w.u32(f.codeOffset).u32(f.frameOffset).u32(f.frameSize);
  });
  section(Section.ENTRIES, (w) => w.u16(p.startup).u16(p.main));
  section(Section.LINES, (w) => {
    w.u32(p.lines.length);
    for (const l of [...p.lines].sort((a, b) => a.pc - b.pc)) w.u32(l.pc).u16(l.func).u16(l.line);
  });
  section(Section.IOCONF, (w) => {
    w.u16(p.hardware.length);
    for (const m of p.hardware) writeModule(w, m);
  });

  const out = new ByteWriter();
  out.bytes(new TextEncoder().encode('VPLC')).u16(ISA_VERSION).u16(sections.length);
  for (const [type, data] of sections) out.u8(type).u32(data.length).bytes(data);
  const body = out.toBytes();
  out.u32(crc32(body));
  return out.toBytes();
}

function writeModule(w: ByteWriter, m: IoModuleConfig): void {
  switch (m.kind) {
    case 'modbus-tcp':
      w.u8(IoModule.MODBUS_TCP).str8(m.host).u16(m.port ?? 502).u8(m.unit ?? 1);
      for (const r of [m.di, m.coils, m.ir, m.hr]) w.u16(r?.count ?? 0).u16(r?.byte ?? 0);
      w.u16(m.pollMs ?? 0);
      break;
    case 'gpio-di':
      w.u8(IoModule.GPIO_DI).u8(m.pin).u16(m.byte).u8(m.bit).u8((m.invert ? 1 : 0) | (m.pullup ? 2 : 0));
      break;
    case 'gpio-do':
      w.u8(IoModule.GPIO_DO).u8(m.pin).u16(m.byte).u8(m.bit).u8(m.invert ? 1 : 0);
      break;
    case 'gpio-ai':
      w.u8(IoModule.GPIO_AI).u8(m.pin).u16(m.byte);
      break;
    case 'gpio-ao':
      w.u8(IoModule.GPIO_AO).u8(m.pin).u16(m.byte);
      break;
  }
}

export interface ParsedImage {
  format: number;
  sections: Map<number, Uint8Array>;
  crc: number;
}

/** Splits an image into its sections and verifies the checksum. */
export function readImage(image: Uint8Array): ParsedImage {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  if (image.length < 12 || new TextDecoder().decode(image.subarray(0, 4)) !== 'VPLC') throw new Error('Not a VirtualPLC program image');
  const crc = view.getUint32(image.length - 4, true);
  if (crc32(image.subarray(0, image.length - 4)) !== crc) throw new Error('Program image checksum mismatch');
  const format = view.getUint16(4, true);
  const count = view.getUint16(6, true);
  const sections = new Map<number, Uint8Array>();
  let pos = 8;
  for (let i = 0; i < count; i++) {
    const type = view.getUint8(pos);
    const len = view.getUint32(pos + 1, true);
    sections.set(type, image.subarray(pos + 5, pos + 5 + len));
    pos += 5 + len;
  }
  return { format, sections, crc };
}
