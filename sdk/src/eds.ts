// EDS files (Electronic Data Sheet, ODVA) of EtherNet/IP devices: identity, parameters,
// assemblies and the connections the device accepts (point of the Forward_Open).

export interface EdsParam {
  number: number;
  name: string;
  units: string;
  min?: number;
  max?: number;
  default?: number;
}

export interface EdsAssembly {
  number: number;
  name: string;
  /** Assembly instance, from the path "20 04 24 xx" */
  instance?: number;
  size?: number;
}

export interface EdsConnection {
  number: number;
  name: string;
  /** exclusive owner, input only, listen only */
  type: 'exclusive-owner' | 'input-only' | 'listen-only' | 'other';
  configInstance: number;
  outInstance: number;
  inInstance: number;
  outSize: number;
  inSize: number;
  /** 32-bit run/idle header in O->T / T->O */
  outHeader: boolean;
  inHeader: boolean;
  /** T->O kinds accepted by the device */
  pointToPoint: boolean;
  multicast: boolean;
  /** Requested packet interval in ms: default and limits (from the RPI parameter) */
  rpiMs?: number;
  rpiMinMs?: number;
  rpiMaxMs?: number;
  help?: string;
}

export interface Eds {
  vendorId: number;
  vendorName: string;
  deviceType: number;
  deviceTypeName: string;
  productCode: number;
  productName: string;
  catalog: string;
  revision: { major: number; minor: number };
  params: Map<number, EdsParam>;
  assemblies: Map<number, EdsAssembly>;
  connections: EdsConnection[];
}

type Section = Map<string, string[]>;

/** Splits the file into sections of entries; each entry is its list of fields. */
function sections(text: string): Map<string, Section> {
  const out = new Map<string, Section>();
  let current: Section | null = null;
  let i = 0;
  const n = text.length;
  let entry = '';
  const flush = () => {
    const e = entry.trim();
    entry = '';
    if (!e || !current) return;
    const eq = e.indexOf('=');
    if (eq < 0) return;
    const key = e.slice(0, eq).trim().toLowerCase();
    current.set(key, splitFields(e.slice(eq + 1)));
  };
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      // string (with "" continuation of adjacent strings)
      const end = text.indexOf('"', i + 1);
      const stop = end < 0 ? n : end + 1;
      entry += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '$') {  // comment to the end of the line
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '[' && entry.trim() === '') {
      const end = text.indexOf(']', i);
      const name = text.slice(i + 1, end < 0 ? n : end).trim().toLowerCase();
      current = out.get(name) ?? new Map();
      out.set(name, current);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === ';') {
      flush();
      i++;
      continue;
    }
    entry += c;
    i++;
  }
  return out;
}

function splitFields(value: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inString = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') {
      inString = !inString;
      cur += c;
    } else if (c === ',' && !inString) {
      fields.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur.trim());
  return fields;
}

/** "abc" "def" -> abcdef */
function str(f: string | undefined): string {
  if (!f) return '';
  const parts = [...f.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return parts.length ? parts.join('') : f.trim();
}

function num(f: string | undefined): number | undefined {
  if (f === undefined) return undefined;
  const t = f.trim();
  if (!t) return undefined;
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return undefined;
}

export function parseEds(text: string): Eds {
  const s = sections(text.replace(/^﻿/, ''));
  const dev = s.get('device');
  if (!dev) throw new Error('Not an EDS file: no [Device] section');
  const get = (sec: Section | undefined, key: string) => sec?.get(key.toLowerCase())?.[0];

  const params = new Map<number, EdsParam>();
  for (const [key, f] of s.get('params') ?? []) {
    const m = /^param(\d+)$/.exec(key);
    if (!m) continue;
    // reserved, link path size, link path, descriptor, data type, data size, name, units, help, min, max, default
    params.set(Number(m[1]), { number: Number(m[1]), name: str(f[6]), units: str(f[7]), min: num(f[9]), max: num(f[10]), default: num(f[11]) });
  }
  const paramValue = (ref: string | undefined): number | undefined => {
    const m = /^param(\d+)$/i.exec(ref?.trim() ?? '');
    return m ? params.get(Number(m[1]))?.default : num(ref);
  };

  const pathBytes = (path: string): number[] => path.trim().split(/\s+/).filter(Boolean).map((t) => {
    const ref = /^\[?(param\d+)\]?$/i.exec(t);
    if (ref) return paramValue(ref[1]) ?? 0;
    return parseInt(t, 16);
  });
  /** Logical segments of a path: class, instance, connection points */
  const decode = (bytes: number[]) => {
    const r: { cls?: number; instances: number[]; points: number[] } = { instances: [], points: [] };
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i];
      if (b === 0x20) { r.cls = bytes[i + 1]; i += 2; }
      else if (b === 0x21) { r.cls = bytes[i + 2] | (bytes[i + 3] << 8); i += 4; }
      else if (b === 0x24) { r.instances.push(bytes[i + 1]); i += 2; }
      else if (b === 0x25) { r.instances.push(bytes[i + 2] | (bytes[i + 3] << 8)); i += 4; }
      else if (b === 0x2c) { r.points.push(bytes[i + 1]); i += 2; }
      else if (b === 0x2d) { r.points.push(bytes[i + 2] | (bytes[i + 3] << 8)); i += 4; }
      else if (b === 0x34) i += 10;  // electronic key
      else if (b === 0x80) { i += 2 + bytes[i + 1] * 2; }  // data segment
      else if (b === 0x30) i += 2;  // attribute
      else i += 1;
    }
    return r;
  };

  const assemblies = new Map<number, EdsAssembly>();
  for (const [key, f] of s.get('assembly') ?? []) {
    const m = /^assem(\d+)$/.exec(key);
    if (!m) continue;
    const path = decode(pathBytes(str(f[1])));
    let size = num(f[2]);
    if (size === undefined && f.length > 6) {
      // members: size in bits, reference
      let bits = 0;
      for (let k = 6; k + 1 < f.length; k += 2) bits += num(f[k]) ?? 0;
      if (bits) size = Math.ceil(bits / 8);
    }
    assemblies.set(Number(m[1]), { number: Number(m[1]), name: str(f[0]), instance: path.instances[0], size });
  }
  const sizeOf = (sizeField: string | undefined, format: string | undefined): number => {
    const direct = paramValue(sizeField);
    if (direct !== undefined) return direct;
    const a = /^assem(\d+)$/i.exec(format?.trim() ?? '');
    return a ? assemblies.get(Number(a[1]))?.size ?? 0 : 0;
  };

  const connections: EdsConnection[] = [];
  for (const [key, f] of s.get('connection manager') ?? []) {
    const m = /^connection(\d+)$/.exec(key);
    if (!m) continue;
    // trigger & transport, parameters, O->T RPI, size, format, T->O RPI, size, format,
    // config 1 size, format, config 2 size, format, name, help, path
    const trigger = num(f[0]) ?? 0;
    const cparams = num(f[1]) ?? 0;
    const path = decode(pathBytes(str(f[14])));
    const rpiParam = /^param(\d+)$/i.exec(f[2]?.trim() ?? '');
    const rpi = rpiParam ? params.get(Number(rpiParam[1])) : undefined;
    const typeBits = (trigger >> 24) & 0xf;
    const outSize = sizeOf(f[3], f[4]);
    const inSize = sizeOf(f[6], f[7]);
    const outFormat = (cparams >> 8) & 0xf;
    const inFormat = (cparams >> 12) & 0xf;
    const toKinds = (cparams >> 20) & 0xf;
    connections.push({
      number: Number(m[1]),
      name: str(f[12]) || `Connection${m[1]}`,
      type: typeBits & 4 ? 'exclusive-owner' : typeBits & 2 ? 'input-only' : typeBits & 1 ? 'listen-only' : 'other',
      configInstance: path.instances[0] ?? 1,
      outInstance: path.points[0] ?? 0,
      inInstance: path.points[1] ?? path.points[0] ?? 0,
      // the sizes of the EDS are the data sizes (header and sequence count excluded)
      outSize, inSize,
      outHeader: outFormat === 4,
      inHeader: inFormat === 4,
      pointToPoint: (toKinds & 4) !== 0 || toKinds === 0,
      multicast: (toKinds & 2) !== 0,
      rpiMs: rpi?.default !== undefined ? rpi.default / 1000 : num(f[2]) !== undefined ? num(f[2])! / 1000 : undefined,
      rpiMinMs: rpi?.min !== undefined ? rpi.min / 1000 : undefined,
      rpiMaxMs: rpi?.max !== undefined ? rpi.max / 1000 : undefined,
      help: str(f[13]) || undefined,
    });
  }
  return {
    vendorId: num(get(dev, 'VendCode')) ?? 0,
    vendorName: str(get(dev, 'VendName')),
    deviceType: num(get(dev, 'ProdType')) ?? 0,
    deviceTypeName: str(get(dev, 'ProdTypeStr')),
    productCode: num(get(dev, 'ProdCode')) ?? 0,
    productName: str(get(dev, 'ProdName')),
    catalog: str(get(dev, 'Catalog')),
    revision: { major: num(get(dev, 'MajRev')) ?? 1, minor: num(get(dev, 'MinRev')) ?? 1 },
    params,
    assemblies,
    connections,
  };
}
