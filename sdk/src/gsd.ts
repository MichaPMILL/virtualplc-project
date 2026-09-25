// PROFIBUS DP device description files (GSD, ASCII): identity, supported speeds, parameters
// and the modules with their configuration identifiers.

export interface GsdModule {
  name: string;
  /** Configuration identifiers (Chk_Cfg) */
  config: number[];
  inLength: number;
  outLength: number;
}

export interface Gsd {
  vendor: string;
  model: string;
  revision: string;
  identNumber: number;
  modular: boolean;
  maxModules: number;
  /** Speeds supported (bit/s) */
  bauds: number[];
  /** User_Prm_Data (constant part) */
  userPrm: number[];
  modules: GsdModule[];
}

const SPEEDS: Array<[string, number]> = [
  ['9.6', 9600], ['19.2', 19200], ['45.45', 45450], ['93.75', 93750], ['187.5', 187500], ['500', 500000],
  ['1.5M', 1500000], ['3M', 3000000], ['6M', 6000000], ['12M', 12000000],
];

/** Input / output lengths of configuration identifiers (compact and special formats) */
export function cfgLengths(cfg: number[]): { inLength: number; outLength: number } {
  let inLength = 0;
  let outLength = 0;
  for (let k = 0; k < cfg.length; k++) {
    const b = cfg[k];
    if (b & 0x30) {
      const len = ((b & 0x0f) + 1) * (b & 0x40 ? 2 : 1);
      if (b & 0x10) inLength += len;
      if (b & 0x20) outLength += len;
      continue;
    }
    if (b === 0) continue;
    const dir = b >> 6;
    const manufacturer = b & 0x0f;
    const len = (at: number) => (at < cfg.length ? ((cfg[at] & 0x3f) + 1) * (cfg[at] & 0x40 ? 2 : 1) : 0);
    let at = k + 1;
    if (dir === 1 || dir === 3) outLength += len(at++);
    if (dir === 2 || dir === 3) inLength += len(at++);
    k = at - 1 + manufacturer;
  }
  return { inLength, outLength };
}

function num(v: string): number {
  const t = v.trim();
  return /^0x/i.test(t) ? parseInt(t, 16) : Number(t);
}

function bytes(v: string): number[] {
  return v.split(',').map((x) => x.trim()).filter(Boolean).map(num).filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);
}

const str = (v: string) => v.trim().replace(/^"|"$/g, '');

export function parseGsd(text: string): Gsd {
  // join the continued lines ("\" at the end), drop the comments (";")
  const lines = text.replace(/^﻿/, '').replace(/\\\s*\r?\n/g, ' ').split(/\r?\n/).map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
  if (!lines.some((l) => /^#profibus_dp/i.test(l))) throw new Error('Not a PROFIBUS GSD file (#Profibus_DP missing)');
  const g: Gsd = { vendor: '', model: '', revision: '', identNumber: 0, modular: false, maxModules: 1, bauds: [], userPrm: [], modules: [] };
  const extConst: Array<[number, number[]]> = [];
  let module: GsdModule | null = null;
  for (const line of lines) {
    if (/^endmodule$/i.test(line)) {
      if (module) g.modules.push(module);
      module = null;
      continue;
    }
    const m = /^([A-Za-z0-9_.]+)(\(\s*\d+\s*\))?\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[3];
    if (key === 'module') {
      const mm = /^"([^"]*)"\s*(.*)$/.exec(value);
      if (!mm) continue;
      const config = bytes(mm[2]);
      module = { name: mm[1], config, ...cfgLengths(config) };
      continue;
    }
    if (module) continue;  // module parameters (Ext_Module_Prm_Data…) are not used
    switch (key) {
      case 'vendor_name': g.vendor = str(value); break;
      case 'model_name': g.model = str(value); break;
      case 'revision': g.revision = str(value); break;
      case 'ident_number': g.identNumber = num(value); break;
      case 'modular_station': g.modular = num(value) === 1; break;
      case 'max_module': g.maxModules = num(value); break;
      case 'user_prm_data': g.userPrm = bytes(value); break;
      case 'ext_user_prm_data_const': extConst.push([Number(/\d+/.exec(m[2] ?? '0')?.[0] ?? 0), bytes(value)]); break;
      default: {
        const speed = SPEEDS.find(([k]) => key === `${k.toLowerCase()}_supp`);
        if (speed && num(value) === 1) g.bauds.push(speed[1]);
      }
    }
  }
  if (extConst.length) {
    const prm: number[] = [];
    for (const [offset, data] of extConst) data.forEach((b, i) => { prm[offset + i] = b; });
    g.userPrm = Array.from(prm, (b) => b ?? 0);
  }
  return g;
}
