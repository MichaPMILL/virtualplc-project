// Traceability: data logs (records of tag values written by the CPU to its local database,
// then forwarded to PostgreSQL / MySQL / MariaDB). Browser-safe: shared by the compiler,
// the project model and the Studio.
import { parseAddress } from './parser.ts';
import { findSymbol, type SymbolNode } from './symbols.ts';
import { HMI_STRING, HMI_TIME } from './image.ts';

export type DataLogTrigger =
  /** DATALOG_WRITE('Name') in the program */
  | { kind: 'program' }
  /** rising edge of a Bool tag (e.g. "Machine".BoxDone) */
  | { kind: 'edge'; tag: string }
  /** every `ms` milliseconds */
  | { kind: 'period'; ms: number };

export interface DataLogColumn {
  /** Column name in the database */
  name: string;
  /** Tag path ("Machine".Count, BoxCount, %IW2) */
  tag: string;
}

export type TlsMode = 'disable' | 'require' | 'verify';

/** Remote database fed by the CPU (the password is stored on the CPU, never in the project) */
export interface DataLogDestination {
  kind: 'postgresql' | 'mysql';
  host: string;
  port?: number;
  database: string;
  table: string;
  user: string;
  /** verify (default): TLS with certificate and host name check; require: TLS without check */
  tls?: TlsMode;
}

export interface DataLog {
  id: string;
  name: string;
  comment?: string;
  columns: DataLogColumn[];
  trigger: DataLogTrigger;
  /** Days the records stay in the local database once forwarded (0 = forever) */
  retentionDays?: number;
  destination?: DataLogDestination;
}

/** A data log resolved to memory addresses (DATALOGS section of the image) */
export interface DataLogImage {
  name: string;
  trigger: { kind: 'program' } | { kind: 'edge'; area: SymbolNode['area']; offset: number; bit: number } | { kind: 'period'; ms: number };
  retentionDays: number;
  columns: Array<{ name: string; area: SymbolNode['area']; offset: number; bit?: number; type: number; size: number }>;
  destination?: Required<Omit<DataLogDestination, 'tls'>> & { tls: TlsMode };
}

export const DEFAULT_DB_PORT = { postgresql: 5432, mysql: 3306 } as const;
export const MAX_DATALOGS = 16;
export const MAX_DATALOG_COLUMNS = 64;
/** Values of one record (bytes) */
export const MAX_DATALOG_RECORD = 2048;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Symbol of a tag path or an absolute address */
export function tagSymbol(symbols: SymbolNode[], path: string): SymbolNode | null {
  const p = path.trim();
  const a = parseAddress(p);
  if (a) {
    const size = { X: 1, B: 1, W: 2, D: 4 }[a.size];
    return {
      name: p, type: a.size === 'X' ? 'Bool' : a.size === 'B' ? 'Byte' : a.size === 'W' ? 'Int' : 'DInt',
      kind: a.size === 'X' ? 'bool' : 'int', area: a.area, offset: a.byte, size,
      bit: a.size === 'X' ? a.bit : undefined, vmType: { X: 0, B: 1, W: 4, D: 6 }[a.size],
    };
  }
  return findSymbol(symbols, p.replace(/^#/, ''));
}

/** Resolves the data logs of a device; returns the error messages (empty when valid). */
export function resolveDataLogs(logs: DataLog[], symbols: SymbolNode[]): { images: DataLogImage[]; errors: string[] } {
  const errors: string[] = [];
  const images: DataLogImage[] = [];
  const names = new Set<string>();
  if (logs.length > MAX_DATALOGS) errors.push(`At most ${MAX_DATALOGS} data logs per CPU`);
  for (const log of logs.slice(0, MAX_DATALOGS)) {
    const where = `Data log '${log.name}'`;
    if (!NAME_RE.test(log.name)) errors.push(`${where}: invalid name (letters, digits and _, 63 characters at most)`);
    if (names.has(log.name.toLowerCase())) errors.push(`${where}: duplicate name`);
    names.add(log.name.toLowerCase());
    if (!log.columns.length) errors.push(`${where}: no column`);
    if (log.columns.length > MAX_DATALOG_COLUMNS) errors.push(`${where}: at most ${MAX_DATALOG_COLUMNS} columns`);
    const columns: DataLogImage['columns'] = [];
    const colNames = new Set(['id', 'ts', 'ts_ns', 'plc', 'record_id', 'chain', 'synced']);
    let size = 0;
    for (const c of log.columns) {
      if (!NAME_RE.test(c.name)) errors.push(`${where}: invalid column name '${c.name}'`);
      else if (colNames.has(c.name.toLowerCase())) errors.push(`${where}: column '${c.name}' is reserved or duplicate`);
      colNames.add(c.name.toLowerCase());
      const s = tagSymbol(symbols, c.tag);
      if (!s) {
        errors.push(`${where}: unknown tag '${c.tag}' (column ${c.name})`);
        continue;
      }
      const type = s.kind === 'string' ? HMI_STRING : s.kind === 'time' ? HMI_TIME : s.vmType;
      if (type === undefined || s.children) {
        errors.push(`${where}: '${c.tag}' is not an elementary value or a string (column ${c.name})`);
        continue;
      }
      size += s.bit !== undefined ? 1 : s.size;
      columns.push({ name: c.name, area: s.area, offset: s.offset, bit: s.bit, type, size: s.size });
    }
    if (size > MAX_DATALOG_RECORD) errors.push(`${where}: a record exceeds ${MAX_DATALOG_RECORD} bytes`);
    let trigger: DataLogImage['trigger'] = { kind: 'program' };
    if (log.trigger.kind === 'period') {
      if (!(log.trigger.ms >= 10 && log.trigger.ms <= 86_400_000)) errors.push(`${where}: period between 10 ms and 24 h`);
      trigger = { kind: 'period', ms: Math.round(log.trigger.ms) };
    } else if (log.trigger.kind === 'edge') {
      const s = tagSymbol(symbols, log.trigger.tag);
      if (!s || s.kind !== 'bool') errors.push(`${where}: the trigger '${log.trigger.tag}' must be a Bool tag`);
      else trigger = { kind: 'edge', area: s.area, offset: s.offset, bit: s.bit ?? 0xff };
    }
    let destination: DataLogImage['destination'];
    const d = log.destination;
    if (d) {
      if (!d.host.trim()) errors.push(`${where}: database host missing`);
      if (!NAME_RE.test(d.table)) errors.push(`${where}: invalid table name '${d.table}'`);
      if (!d.database.trim() || /[\s"'`;]/.test(d.database)) errors.push(`${where}: invalid database name '${d.database}'`);
      if (!d.user.trim()) errors.push(`${where}: database user missing`);
      destination = {
        kind: d.kind, host: d.host.trim(), port: d.port || DEFAULT_DB_PORT[d.kind], database: d.database.trim(),
        table: d.table, user: d.user.trim(), tls: d.tls ?? 'verify',
      };
    }
    images.push({ name: log.name, trigger, retentionDays: Math.max(0, Math.min(65535, Math.round(log.retentionDays ?? 0))), columns, destination });
  }
  return { images, errors };
}

/** Key of the credentials of a destination on the CPU (the password is set with SET_SECRET) */
export function secretKey(d: Pick<DataLogDestination, 'kind' | 'user' | 'host' | 'port' | 'database'>): string {
  return `${d.kind}://${d.user}@${d.host}:${d.port || DEFAULT_DB_PORT[d.kind]}/${d.database}`;
}

// ---------------------------------------------------------------------------
// Verification of the hash chain (docs/traceability.md) — for the end customer: any record
// changed, removed or inserted breaks the chain.
// ---------------------------------------------------------------------------

export type TraceKind = 'bool' | 'int' | 'real' | 'text';

export interface TraceRecord {
  recordId: number | bigint | string;
  /** ns since 1970 (as stored in ts_ns) */
  tsNs: number | bigint | string;
  values: Array<boolean | number | bigint | string | null>;
  chain: string;
  /** Ed25519 signature of the chain value by the CPU (hex) */
  sig?: string;
}

export interface TraceVerification {
  ok: boolean;
  verified: number;
  /** First record whose chain does not match (the record or one before it was altered) */
  brokenAt?: string;
  reason?: string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Canonical text of a record (same as the CPU, runtime/platform/linux/datalog/datalog.cpp) */
export function traceCanonical(r: TraceRecord, kinds: TraceKind[]): string {
  let s = `${BigInt(r.recordId)}|${BigInt(r.tsNs)}`;
  r.values.forEach((v, i) => {
    s += '|';
    if (v === null || v === undefined) {
      s += 'N';
      return;
    }
    switch (kinds[i]) {
      case 'bool': s += v === true || v === 1 || v === '1' || v === 't' || v === 'true' ? 'B1' : 'B0'; break;
      case 'int': s += `I${BigInt(typeof v === 'boolean' ? Number(v) : (v as number | bigint | string))}`; break;
      case 'real': {
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, Number(v));
        s += `R${view.getBigUint64(0).toString(16).padStart(16, '0')}`;
        break;
      }
      default: {
        const t = String(v);
        s += `T${new TextEncoder().encode(t).length}:${t}`;
      }
    }
  });
  return s;
}

export async function traceGenesis(plc: string, log: string, epoch: number | bigint | string): Promise<string> {
  return sha256Hex(`VirtualPLC data log|${plc}|${log}|${BigInt(epoch)}`);
}

/**
 * Verifies records of one data log (ordered by record id). `previous` is the chain of the record
 * before the first one given (by default the start of the chain: all records from record 1).
 */
export async function verifyTrace(opts: {
  plc: string; log: string; epoch: number | bigint | string; kinds: TraceKind[]; records: TraceRecord[]; previous?: string;
  /** Public key of the CPU (hex): the signature of every record is checked */
  publicKey?: string;
}): Promise<TraceVerification> {
  const key = opts.publicKey
    ? await globalThis.crypto.subtle.importKey('raw', hexBytes(opts.publicKey), { name: 'Ed25519' }, false, ['verify'])
    : null;
  let previous = opts.previous ?? await traceGenesis(opts.plc, opts.log, opts.epoch);
  let expectedId = opts.previous === undefined ? 1n : null;
  let verified = 0;
  for (const r of opts.records) {
    const id = BigInt(r.recordId);
    if (expectedId !== null && id !== expectedId) {
      return { ok: false, verified, brokenAt: String(id), reason: `record ${expectedId} is missing` };
    }
    const c = await sha256Hex(`${previous}|${traceCanonical(r, opts.kinds)}`);
    if (c !== r.chain.trim().toLowerCase()) {
      return { ok: false, verified, brokenAt: String(id), reason: `record ${id} was altered (or a record before it)` };
    }
    if (key) {
      const sig = r.sig?.trim() ?? '';
      const valid = sig.length === 128
        && await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, hexBytes(sig), new TextEncoder().encode(c));
      if (!valid) return { ok: false, verified, brokenAt: String(id), reason: `record ${id} is not signed by this CPU` };
    }
    previous = c;
    expectedId = id + 1n;
    verified++;
  }
  return { ok: true, verified };
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(new ArrayBuffer(clean.length >> 1));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(2 * i, 2), 16);
  return out;
}

/** Fingerprint of a CPU public key, to be checked by the customer: "3f9a 12c0 …" (SHA-256, 16 bytes) */
export async function keyFingerprint(publicKeyHex: string): Promise<string> {
  const hash = await sha256Hex(publicKeyHex.trim().toLowerCase());
  return hash.slice(0, 32).match(/..../g)!.join(' ');
}

/**
 * Traceability certificate: records of a data log with their hash chain and the signatures of
 * the CPU. Given to a customer, it proves the records were written by that CPU and not changed.
 */
export interface TraceCertificate {
  format: 'virtualplc-trace';
  version: 1;
  plc: string;
  log: string;
  epoch: number;
  columns: string[];
  kinds: TraceKind[];
  publicKey: string;
  /** Chain of the record before the first one (absent: the records start at record 1) */
  previous?: string;
  created: string;
  records: TraceRecord[];
}

export interface CertificateVerification extends TraceVerification {
  fingerprint?: string;
}

/** Verifies a certificate; `fingerprint` (from the producer) authenticates the CPU key */
export async function verifyTraceCertificate(cert: TraceCertificate, fingerprint?: string): Promise<CertificateVerification> {
  if (cert?.format !== 'virtualplc-trace' || cert.version !== 1) return { ok: false, verified: 0, reason: 'not a VirtualPLC traceability certificate' };
  if (!cert.publicKey) return { ok: false, verified: 0, reason: 'the certificate has no CPU public key' };
  const fp = await keyFingerprint(cert.publicKey);
  if (fingerprint !== undefined && fp.replace(/\s/g, '') !== fingerprint.replace(/\s/g, '').toLowerCase()) {
    return { ok: false, verified: 0, fingerprint: fp, reason: 'the CPU key is not the expected one (fingerprint mismatch)' };
  }
  const r = await verifyTrace({ plc: cert.plc, log: cert.log, epoch: cert.epoch, kinds: cert.kinds, records: cert.records, previous: cert.previous, publicKey: cert.publicKey });
  return { ...r, fingerprint: fp };
}
