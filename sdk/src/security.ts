// Audit trail of the CPU: every record is hash-chained and signed by the CPU (Ed25519), so that
// a missing, inserted or altered record is detected (IEC 62443-3-3 SR 2.8 / SR 3.9).
import type { AuditRecord } from './device.ts';

async function sha256Hex(text: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(new ArrayBuffer(clean.length >> 1));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(2 * i, 2), 16);
  return out;
}

const field = (s: string) => s.replace(/[|\\]/g, (c) => `\\${c}`);

/** Chained form of an audit record: seq|ts|user|peer|action|detail ('|' and '\' escaped) */
export function auditCanonical(r: AuditRecord): string {
  return `${r.seq}|${r.ts}|${field(r.user)}|${field(r.peer)}|${field(r.action)}|${field(r.detail)}`;
}

export async function auditGenesis(plc: string): Promise<string> {
  return sha256Hex(`VirtualPLC audit|${plc}`);
}

export interface AuditVerification {
  ok: boolean;
  verified: number;
  brokenAt?: number;
  reason?: string;
}

/**
 * Verifies consecutive audit records. `previous` = chain of the record before the first one
 * (default: the start of the trail, record 1). With `publicKey`, each signature is checked too.
 */
export async function verifyAudit(opts: { plc: string; records: AuditRecord[]; previous?: string; publicKey?: string }): Promise<AuditVerification> {
  const key = opts.publicKey
    ? await globalThis.crypto.subtle.importKey('raw', hexBytes(opts.publicKey), { name: 'Ed25519' }, false, ['verify'])
    : null;
  let previous = opts.previous;
  let expected: number | null = null;
  if (previous === undefined) {
    previous = await auditGenesis(opts.plc);
    expected = 1;
  }
  let verified = 0;
  for (const r of opts.records) {
    if (expected !== null && r.seq !== expected) return { ok: false, verified, brokenAt: r.seq, reason: `record ${expected} is missing` };
    const c = await sha256Hex(`${previous}|${auditCanonical(r)}`);
    if (c !== r.chain) return { ok: false, verified, brokenAt: r.seq, reason: `record ${r.seq} was altered (or a record before it)` };
    if (key) {
      const valid = r.sig.length === 128 && await globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, hexBytes(r.sig), new TextEncoder().encode(c));
      if (!valid) return { ok: false, verified, brokenAt: r.seq, reason: `record ${r.seq} is not signed by this CPU` };
    }
    previous = c;
    expected = r.seq + 1;
    verified++;
  }
  return { ok: true, verified };
}
