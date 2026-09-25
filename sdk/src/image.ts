import { ByteWriter } from './bytes.ts';
import { crc32 } from './crc32.ts';
import { Area, IoModule, ISA_VERSION, Section } from './isa.ts';

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
  | { kind: 'gpio-ao'; name: string; pin: number; byte: number }
  | {
    kind: 'iolink-master'; name: string; host: string; port?: number; unit?: number; pollMs?: number;
    /** Modbus function used to read the input process data: 3 = holding registers (default), 4 = input registers */
    inFunction?: 3 | 4;
    ports: IoLinkPort[];
   }
  | {
    /** This CPU as a PROFINET IO-Device of an external IO-Controller */
    kind: 'profinet-device'; name: string;
    /** Network interface (e.g. eth0) */
    interface: string;
    /** Initial name of station (the controller's engineering tool may change it with DCP) */
    stationName: string;
    vendorId?: number; deviceId?: number;
    /** Controller outputs are written to %I from inByte (inLength bytes max), controller inputs are read from %Q */
    inByte: number; inLength: number;
    outByte: number; outLength: number;
  }
  | {
    /** An IO-Device driven by this CPU as PROFINET IO-Controller */
    kind: 'profinet-remote'; name: string;
    interface: string;
    stationName: string;
    /** IP address given to the device (DCP) */
    ip: string;
    vendorId: number; deviceId: number;
    /** Update time in ms (default 8) */
    cycleMs?: number;
    /** Watchdog factor (default 3) */
    watchdog?: number;
    submodules: PnSubmodule[];
    /** Studio only: catalogue of the device (from its GSDML) and plugged modules */
    catalog?: PnCatalog;
  }
  | {
    /** An EtherNet/IP adapter (I/O block, drive, camera…) driven by this CPU as scanner (implicit class 1 I/O) */
    kind: 'enip-adapter'; name: string;
    host: string;
    /** Encapsulation TCP port (default 44818) */
    port?: number;
    /** Requested packet interval in ms (default 10) */
    rpiMs?: number;
    /** Assembly instances: configuration, output (O→T), input (T→O) */
    configInstance: number; outInstance: number; inInstance: number;
    /** Data sizes in bytes (without sequence count and run/idle header) and their %Q / %I addresses */
    outLength: number; outByte: number;
    inLength: number; inByte: number;
    /** 32-bit run/idle header in the O→T data (default true) and in the T→O data (default false) */
    outHeader?: boolean; inHeader?: boolean;
    /** T→O multicast instead of point-to-point */
    multicast?: boolean;
    /** Connection timeout multiplier code 0..7 (×4 … ×512, default 1: ×8) */
    timeoutMultiplier?: number;
    /** Electronic key (checked by the adapter when vendorId is set; compatible revisions accepted) */
    vendorId?: number; deviceType?: number; productCode?: number; revision?: { major: number; minor: number };
    /** Configuration data sent with the Forward_Open (data segment) */
    configData?: number[];
    /** Studio only: what was read from the EDS file */
    catalog?: EdsCatalog;
  }
  | {
    /** A PROFIBUS DP slave driven by this CPU as DP master (class 1), through an RS-485 adapter */
    kind: 'profibus-slave'; name: string;
    /** Serial port of the RS-485 adapter (all the slaves of a port share the master) */
    port: string;
    /** Bus speed in bit/s (9600 … 1500000; up to 12 Mbit/s with a fast adapter) */
    baud: number;
    /** Station address of the slave (1…125) and of the master (default 1) */
    station: number;
    masterAddress?: number;
    /** Ident number of the slave (GSD Ident_Number), checked by the slave */
    identNumber: number;
    /** Watchdog of the slave in ms (outputs off when the master stops): 0 = none */
    watchdogMs?: number;
    /** Parameters (User_Prm_Data) and configuration identifiers (Chk_Cfg) */
    userPrm?: number[];
    config: number[];
    inByte: number; inLength: number;
    outByte: number; outLength: number;
    /** The adapter receives what it sends (RS-485 without echo suppression) */
    echo?: boolean;
    /** Studio only: GSD catalogue */
    catalog?: GsdCatalog;
  };

/** What the Studio keeps of a PROFIBUS GSD file */
export interface GsdCatalog {
  file: string;
  vendor: string;
  model: string;
  modular: boolean;
  maxModules: number;
  modules: Array<{ name: string; config: number[] }>;
  /** Plugged modules, in order */
  plugged: string[];
}

/** What the Studio keeps of an EDS file */
export interface EdsCatalog {
  file: string;
  vendor: string;
  product: string;
  /** Connection chosen in the EDS ([Connection Manager] ConnectionN name) */
  connection?: string;
}

/** What the Studio keeps of a GSDML file to configure the device again. */
export interface PnCatalog {
  file: string;
  vendor: string;
  family?: string;
  dapName: string;
  dapIdent: number;
  dapSubmodules: PnCatalogSubmodule[];
  physicalSlots: number[];
  minCycleMs: number;
  modules: Array<{ id: string; name: string; orderNumber?: string; ident: number; slots: number[]; fixed: number[]; submodules: PnCatalogSubmodule[] }>;
  plugged: Array<{ slot: number; moduleId: string }>;
  /** First %I / %Q bytes of the device */
  inBase: number;
  outBase: number;
}

export interface PnCatalogSubmodule {
  name: string;
  subslot: number;
  ident: number;
  inLength: number;
  outLength: number;
  records: Array<{ index: number; data: number[] }>;
}

/** A submodule of a PROFINET IO-Device (from its GSDML), mapped to the process image. */
export interface PnSubmodule {
  slot: number;
  subslot: number;
  moduleIdent: number;
  submoduleIdent: number;
  /** Input data (device → controller): length in bytes and %I byte */
  inLength: number;
  inByte: number;
  /** Output data (controller → device): length and %Q byte */
  outLength: number;
  outByte: number;
  /** Parameter records written before the end of parametrization (GSDML defaults) */
  records?: Array<{ index: number; data: number[] }>;
}

/** One port of an IO-Link master: its process data mapped to the process image. */
export interface IoLinkPort {
  /** Port number of the master (1..16) */
  port: number;
  /** Connected device (informative: vendor / product, IODD file) */
  device?: string;
  /** Process data in (sensor → PLC): Modbus register, %I byte, length in bytes */
  inRegister: number;
  inByte: number;
  inLength: number;
  /** Process data out (PLC → actuator) */
  outRegister: number;
  outByte: number;
  outLength: number;
}

/** A variable exposed to HMIs (OPC UA, S7, ...). */
export interface HmiSymbol {
  /** Path segments, e.g. ["Motor_DB", "Timer", "ET"] or ["Values[3]"] */
  path: string[];
  area: 'D' | 'I' | 'Q' | 'M';
  offset: number;
  bit?: number;
  /** VM type code, or HMI_STRING / HMI_TIME */
  type: number;
  size: number;
  writable: boolean;
}

export const HMI_STRING = 0x20;
export const HMI_TIME = 0x21;

/** Data block number and location (absolute addressing, e.g. DB1.DBW2). */
export interface DbEntry {
  number: number;
  name: string;
  offset: number;
  size: number;
}

/** Communication services of the CPU, configured in the device properties. */
export interface ServicesConfig {
  opcua?: { enabled: boolean; port?: number; write?: boolean; anonymous?: boolean };
  s7?: { enabled: boolean; port?: number; write?: boolean };
}

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
  symbols?: HmiSymbol[];
  dbs?: DbEntry[];
  services?: ServicesConfig;
  dataLogs?: import('./datalog.ts').DataLogImage[];
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
  if (p.symbols?.length) {
    section(Section.SYMS, (w) => {
      w.u32(p.symbols!.length);
      for (const s of p.symbols!) {
        w.u8(AREA[s.area]).u32(s.offset).u8(s.bit ?? 0xff).u8(s.type).u16(s.size).u8(s.writable ? 1 : 0).u8(s.path.length);
        for (const seg of s.path) w.str8(seg);
      }
    });
  }
  if (p.dbs?.length) {
    section(Section.DBS, (w) => {
      w.u16(p.dbs!.length);
      for (const d of p.dbs!) w.u16(d.number).u32(d.offset).u32(d.size).str8(d.name);
    });
  }
  if (p.dataLogs?.length) {
    section(Section.DATALOGS, (w) => {
      w.u16(p.dataLogs!.length);
      for (const l of p.dataLogs!) {
        w.str8(l.name);
        const t = l.trigger;
        if (t.kind === 'edge') w.u8(1).u8(AREA[t.area]).u32(t.offset).u8(t.bit);
        else if (t.kind === 'period') w.u8(2).u32(t.ms);
        else w.u8(0);
        w.u16(l.retentionDays).u8(l.columns.length);
        for (const c of l.columns) w.str8(c.name).u8(AREA[c.area]).u32(c.offset).u8(c.bit ?? 0xff).u8(c.type).u16(c.size);
        const d = l.destination;
        if (!d) {
          w.u8(0);
        } else {
          w.u8(d.kind === 'postgresql' ? 1 : 2).str8(d.host).u16(d.port).str8(d.database).str8(d.table).str8(d.user)
            .u8({ disable: 0, require: 1, verify: 2 }[d.tls]);
        }
      }
    });
  }
  if (p.services) {
    const { opcua, s7 } = p.services;
    section(Section.SERVICES, (w) => {
      w.u16(opcua?.port ?? 4840).u8((opcua?.enabled ? 1 : 0) | (opcua?.write !== false ? 2 : 0) | (opcua?.anonymous !== false ? 4 : 0));
      w.u16(s7?.port ?? 102).u8((s7?.enabled ? 1 : 0) | (s7?.write !== false ? 2 : 0));
    });
  }

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
    case 'iolink-master':
      w.u8(IoModule.IOLINK_MASTER).str8(m.host).u16(m.port ?? 502).u8(m.unit ?? 1).u16(m.pollMs ?? 0).u8(m.inFunction ?? 3).u8(m.ports.length);
      for (const p of m.ports) w.u8(p.port).u16(p.inRegister).u16(p.inByte).u8(p.inLength).u16(p.outRegister).u16(p.outByte).u8(p.outLength);
      break;
    case 'profinet-device':
      w.u8(IoModule.PROFINET_DEVICE).str8(m.interface).str8(m.stationName).u16(m.vendorId ?? 0).u16(m.deviceId ?? 1)
        .u16(m.inByte).u16(m.inLength).u16(m.outByte).u16(m.outLength);
      break;
    case 'profinet-remote':
      w.u8(IoModule.PROFINET_REMOTE).str8(m.interface).str8(m.stationName).str8(m.ip).u16(m.vendorId).u16(m.deviceId)
        .u16(m.cycleMs ?? 8).u16(m.watchdog ?? 3).u8(m.submodules.length);
      for (const x of m.submodules) {
        w.u16(x.slot).u16(x.subslot).u32(x.moduleIdent).u32(x.submoduleIdent).u16(x.inLength).u16(x.inByte).u16(x.outLength).u16(x.outByte);
        const records = x.records ?? [];
        w.u8(records.length);
        for (const r of records) {
          w.u16(r.index).u16(r.data.length);
          for (const b of r.data) w.u8(b);
        }
      }
      break;
    case 'enip-adapter': {
      const flags = (m.outHeader ?? true ? 1 : 0) | (m.inHeader ? 2 : 0) | (m.multicast ? 4 : 0) | (m.vendorId ? 8 : 0);
      const cfg = m.configData ?? [];
      w.u8(IoModule.ENIP_ADAPTER).str8(m.host).u16(m.port ?? 44818).u32(Math.round((m.rpiMs ?? 10) * 1000))
        .u16(m.configInstance).u16(m.outInstance).u16(m.inInstance)
        .u16(m.outLength).u16(m.outByte).u16(m.inLength).u16(m.inByte)
        .u8(flags).u8(m.timeoutMultiplier ?? 1)
        .u16(m.vendorId ?? 0).u16(m.deviceType ?? 0).u16(m.productCode ?? 0).u8(m.revision?.major ?? 0).u8(m.revision?.minor ?? 0)
        .u16(cfg.length);
      for (const b of cfg) w.u8(b);
      break;
    }
    case 'profibus-slave': {
      const prm = m.userPrm ?? [];
      w.u8(IoModule.PROFIBUS_SLAVE).str8(m.port).u32(m.baud).u8(m.station).u8(m.masterAddress ?? 1).u16(m.identNumber).u16(m.watchdogMs ?? 0)
        .u16(m.inByte).u16(m.inLength).u16(m.outByte).u16(m.outLength).u8(m.echo ? 1 : 0).u8(prm.length).u8(m.config.length);
      for (const b of prm) w.u8(b);
      for (const b of m.config) w.u8(b);
      break;
    }
  }
}

const AREA = { D: Area.D, I: Area.I, Q: Area.Q, M: Area.M } as const;

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
