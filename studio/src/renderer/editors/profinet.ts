// PROFINET in the device configuration: the CPU as IO-Device of another controller
// (areas exchanged, GSDML export) and IO-Devices driven by the CPU as IO-Controller
// (added from their GSDML file: slots, modules, addresses, variables).
import {
  generateGsdml, parseGsdml, type Device, type GsdModule, type IoModuleConfig, type PnCatalog, type PnCatalogSubmodule, type PnSubmodule,
} from '../../../../sdk/src/browser.ts';
import { h } from '../dom.ts';
import { downloadFile, host } from '../host.ts';
import { alertDialog } from '../ui/dialogs.ts';
import { store } from '../store.ts';

export type PnDeviceModule = Extract<IoModuleConfig, { kind: 'profinet-device' }>;
export type PnRemoteModule = Extract<IoModuleConfig, { kind: 'profinet-remote' }>;

const field = (label: string, input: HTMLElement, hint?: string) =>
  h('div', { className: 'field' }, h('label', null, label), input, hint ? h('span', { className: 'hint' }, hint) : h('span'));
const sub = (text: string) => h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, text);

function num(value: number, set: (v: number) => void, min = 0, max = 65535, width = '110px'): HTMLInputElement {
  const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), style: `width:${width}` });
  i.onchange = () => {
    const v = Math.max(min, Math.min(max, Math.round(Number(i.value) || 0)));
    i.value = String(v);
    set(v);
  };
  return i;
}

function text(value: string, set: (v: string) => void, placeholder = ''): HTMLInputElement {
  const i = h('input', { value, placeholder });
  i.onchange = () => set(i.value.trim());
  return i;
}

function hexInput(value: number, set: (v: number) => void): HTMLInputElement {
  const i = h('input', { value: `0x${value.toString(16).toUpperCase().padStart(4, '0')}`, style: 'width:110px' });
  i.onchange = () => {
    const v = Number(i.value.trim());
    if (Number.isInteger(v) && v >= 0 && v <= 0xFFFF) set(v);
    i.value = `0x${(Number.isInteger(v) && v >= 0 && v <= 0xFFFF ? v : value).toString(16).toUpperCase().padStart(4, '0')}`;
  };
  return i;
}

/** PROFINET name of station rules (lower case, digits, '-', '.') */
export function validStationName(name: string): boolean {
  return name.length > 0 && name.length <= 240 && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(name) && !/^port-/.test(name)
    && !/^\d+\.\d+\.\d+\.\d+$/.test(name);
}

export function stationNameFrom(name: string): string {
  const s = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  return validStationName(s) ? s : 'virtualplc';
}

export function newPnDevice(device: Device, n: number, inByte: number, outByte: number): PnDeviceModule {
  return {
    kind: 'profinet-device', name: `PN_IO_Device_${n}`, interface: 'eth0', stationName: stationNameFrom(device.name), vendorId: 0, deviceId: 1,
    inByte, inLength: 64, outByte, outLength: 64,
  };
}

// ---------------------------------------------------------------------------
// CPU as IO-Device
// ---------------------------------------------------------------------------

export function pnDeviceProps(device: Device, m: PnDeviceModule, touch: () => void): HTMLElement[] {
  const station = text(m.stationName, (v) => {
    if (!validStationName(v)) {
      void alertDialog('Nom de station', `« ${v} » n'est pas un nom de station PROFINET valide (minuscules, chiffres, « - » et « . »).`, 'error');
      station.value = m.stationName;
      return;
    }
    m.stationName = v;
    touch();
  });
  return [
    h('p', { className: 'muted', style: 'margin:4px 0;line-height:1.45' },
      'La CPU échange des données avec un automate maître PROFINET (IO-Controller). Importez le fichier GSDML dans son outil d\'ingénierie, '
      + 'ajoutez l\'appareil et des modules IN / OUT : les sorties du maître arrivent dans la zone %I ci-dessous, ses entrées sont lues dans la zone %Q, '
      + 'dans l\'ordre des emplacements.'),
    sub('Interface'),
    field('Interface réseau', text(m.interface, (v) => { m.interface = v || 'eth0'; touch(); }), 'ex. eth0, enp2s0 — nécessite les droits CAP_NET_RAW / CAP_NET_ADMIN'),
    field('Nom de station', station, 'Nom initial ; le maître peut le modifier (DCP), la CPU le conserve'),
    sub('Identification (fichier GSDML)'),
    field('Vendor ID', hexInput(m.vendorId ?? 0, (v) => { m.vendorId = v; touch(); }), 'Identifiant fabricant attribué par PI (0x0000 pour les essais)'),
    field('Device ID', hexInput(m.deviceId ?? 1, (v) => { m.deviceId = v; touch(); })),
    sub('Zones d\'échange'),
    field('Sorties du maître → %I', h('span', { style: 'display:flex;gap:6px;align-items:center' },
      num(m.inByte, (v) => { m.inByte = v; touch(); }), 'longueur', num(m.inLength, (v) => { m.inLength = v; touch(); }, 0, 1440, '90px')), `%IB${m.inByte} … %IB${m.inByte + Math.max(m.inLength, 1) - 1}`),
    field('Entrées du maître ← %Q', h('span', { style: 'display:flex;gap:6px;align-items:center' },
      num(m.outByte, (v) => { m.outByte = v; touch(); }), 'longueur', num(m.outLength, (v) => { m.outLength = v; touch(); }, 0, 1440, '90px')), `%QB${m.outByte} … %QB${m.outByte + Math.max(m.outLength, 1) - 1}`),
    h('div', { style: 'margin-top:10px' },
      h('button', { className: 'button primary', onclick: () => {
        const g = generateGsdml({ vendorId: m.vendorId ?? 0, deviceId: m.deviceId ?? 1 });
        downloadFile(g.fileName, g.xml);
        store.addMessage({ severity: 'ok', path: `${device.name} > ${m.name}`, text: `Fichier GSDML « ${g.fileName} » exporté.` });
      } }, 'Exporter le fichier GSDML...')),
  ];
}

// ---------------------------------------------------------------------------
// IO-Devices driven by the CPU (IO-Controller)
// ---------------------------------------------------------------------------

const toCatalogSubs = (m: GsdModule): PnCatalogSubmodule[] => m.submodules.map((s) => ({
  name: s.name, subslot: s.subslot, ident: s.ident, inLength: s.inLength, outLength: s.outLength, records: s.records,
}));

/** Recomputes the submodules (and their addresses) from the plugged modules. */
export function applyCatalog(m: PnRemoteModule): void {
  const c = m.catalog;
  if (!c) return;
  const subs: PnSubmodule[] = [];
  let i = c.inBase;
  let q = c.outBase;
  const add = (slot: number, ident: number, list: PnCatalogSubmodule[]) => {
    for (const s of list) {
      subs.push({
        slot, subslot: s.subslot, moduleIdent: ident, submoduleIdent: s.ident, inLength: s.inLength, inByte: s.inLength ? i : 0,
        outLength: s.outLength, outByte: s.outLength ? q : 0, records: s.records.length ? s.records : undefined,
      });
      i += s.inLength;
      q += s.outLength;
    }
  };
  add(0, c.dapIdent, c.dapSubmodules);
  for (const p of [...c.plugged].sort((a, b) => a.slot - b.slot)) {
    const mod = c.modules.find((x) => x.id === p.moduleId);
    if (mod) add(p.slot, mod.ident, mod.submodules);
  }
  m.submodules = subs;
}

export async function addGsdmlDevice(device: Device, nextIn: number, nextOut: number): Promise<PnRemoteModule | null> {
  const [file] = await host.openFiles('gsdml');
  if (!file) return null;
  try {
    const gsd = parseGsdml(new TextDecoder().decode(file.bytes));
    const dap = gsd.daps[0];
    if (!dap) throw new Error('Aucun point d\'accès (DAP) dans le fichier');
    const catalog: PnCatalog = {
      file: file.name, vendor: gsd.vendorName, family: gsd.family, dapName: dap.name || gsd.info, dapIdent: dap.ident, dapSubmodules: toCatalogSubs(dap),
      physicalSlots: dap.physicalSlots, minCycleMs: dap.minDeviceIntervalMs,
      modules: dap.useable.flatMap((u): PnCatalog['modules'] => {
        const mod = gsd.modules.get(u.moduleId);
        return mod ? [{ id: mod.id, name: mod.name, orderNumber: mod.orderNumber, ident: mod.ident, slots: u.allowedSlots, fixed: u.fixedInSlots, submodules: toCatalogSubs(mod) }] : [];
      }),
      plugged: [],
      inBase: nextIn,
      outBase: nextOut,
    };
    // modules fixed in their slots are always there
    for (const mod of catalog.modules) for (const s of mod.fixed) catalog.plugged.push({ slot: s, moduleId: mod.id });
    const n = device.io.filter((x) => x.kind === 'profinet-remote').length + 1;
    const stationName = stationNameFrom(`${dap.name || gsd.vendorName || 'device'}-${n}`);
    const m: PnRemoteModule = {
      kind: 'profinet-remote', name: `PN_${n}`, interface: 'eth0', stationName, ip: `192.168.0.${100 + n}`,
      vendorId: gsd.vendorId, deviceId: gsd.deviceId, cycleMs: Math.max(4, Math.ceil(dap.minDeviceIntervalMs)), watchdog: 3, submodules: [], catalog,
    };
    applyCatalog(m);
    store.addMessage({ severity: 'ok', path: `${device.name} > ${m.name}`, text: `GSDML « ${file.name} » : ${gsd.vendorName} ${catalog.dapName}, ${catalog.modules.length} module(s) disponible(s).` });
    return m;
  } catch (e) {
    await alertDialog('GSDML', (e as Error).message, 'error');
    return null;
  }
}

export function pnRemoteProps(device: Device, m: PnRemoteModule, touch: () => void, rerender: () => void): HTMLElement[] {
  const c = m.catalog;
  const station = text(m.stationName, (v) => {
    if (!validStationName(v)) {
      void alertDialog('Nom de station', `« ${v} » n'est pas un nom de station PROFINET valide.`, 'error');
      station.value = m.stationName;
      return;
    }
    m.stationName = v;
    touch();
  });
  const out: HTMLElement[] = [
    h('p', { className: 'muted', style: 'margin:4px 0;line-height:1.45' },
      `Appareil PROFINET piloté par cette CPU (IO-Controller)${c ? ` — ${c.vendor} ${c.dapName} (${c.file})` : ''}. `
      + 'Au démarrage, la CPU recherche l\'appareil par son nom de station, lui donne son adresse IP puis échange ses données à chaque cycle.'),
    sub('Réseau'),
    field('Interface réseau', text(m.interface, (v) => { m.interface = v || 'eth0'; touch(); }), 'Interface de la CPU reliée au réseau PROFINET (ex. eth0)'),
    field('Nom de station', station, 'Doit correspondre au nom enregistré dans l\'appareil'),
    field('Adresse IP', text(m.ip, (v) => { m.ip = v; touch(); }), 'Attribuée à l\'appareil par la CPU'),
    field('Temps de rafraîchissement (ms)', num(m.cycleMs ?? 8, (v) => { m.cycleMs = v; touch(); }, 1, 512), `Arrondi à une puissance de 2${c ? ` ; minimum de l'appareil : ${c.minCycleMs} ms` : ''}`),
    field('Facteur de surveillance', num(m.watchdog ?? 3, (v) => { m.watchdog = v; touch(); }, 1, 255), 'Cycles sans données avant de déclarer l\'appareil défaillant'),
  ];
  if (!c) return out;
  out.push(sub('Modules'),
    field('Adresses de début', h('span', { style: 'display:flex;gap:6px;align-items:center' },
      '%I', num(c.inBase, (v) => { c.inBase = v; applyCatalog(m); touch(); rerender(); }, 0, 65535, '80px'),
      '%Q', num(c.outBase, (v) => { c.outBase = v; applyCatalog(m); touch(); rerender(); }, 0, 65535, '80px'))));
  const table = h('table', { className: 'grid', style: 'margin-top:4px' },
    h('tr', null, h('th', null, 'Empl.'), h('th', null, 'Module'), h('th', null, 'Réf.'), h('th', null, 'Adresses E'), h('th', null, 'Adresses S')));
  const range = (area: string, byte: number, len: number) => (len ? `%${area}${byte}…${byte + len - 1}` : '');
  const rowFor = (slot: number) => {
    const subs = m.submodules.filter((x) => x.slot === slot);
    const ins = subs.filter((x) => x.inLength);
    const outs = subs.filter((x) => x.outLength);
    const inRange = ins.length ? range('I', ins[0].inByte, ins.reduce((a, x) => a + x.inLength, 0)) : '';
    const outRange = outs.length ? range('Q', outs[0].outByte, outs.reduce((a, x) => a + x.outLength, 0)) : '';
    if (slot === 0) {
      return h('tr', null, h('td', null, '0'), h('td', null, c.dapName), h('td', null, ''), h('td', { className: 'mono' }, inRange), h('td', { className: 'mono' }, outRange));
    }
    const plugged = c.plugged.find((p) => p.slot === slot);
    const choices = c.modules.filter((x) => x.slots.includes(slot));
    const fixed = plugged && c.modules.find((x) => x.id === plugged.moduleId)?.fixed.includes(slot);
    const sel = h('select', { style: 'width:100%', disabled: !!fixed }, h('option', { value: '' }, '—'),
      ...choices.map((x) => h('option', { value: x.id }, x.name || x.id)));
    sel.value = plugged?.moduleId ?? '';
    sel.onchange = () => {
      c.plugged = c.plugged.filter((p) => p.slot !== slot);
      if (sel.value) c.plugged.push({ slot, moduleId: sel.value });
      applyCatalog(m);
      touch();
      rerender();
    };
    const mod = plugged && c.modules.find((x) => x.id === plugged.moduleId);
    return h('tr', null, h('td', null, String(slot)), h('td', null, sel), h('td', null, mod?.orderNumber ?? ''),
      h('td', { className: 'mono' }, inRange), h('td', { className: 'mono' }, outRange));
  };
  const slots = c.physicalSlots.length ? c.physicalSlots : [0, ...new Set(c.modules.flatMap((x) => x.slots))].sort((a, b) => a - b);
  for (const s of slots) if (s === 0 || c.modules.some((x) => x.slots.includes(s))) table.append(rowFor(s));
  const tags = h('button', { className: 'button', style: 'margin-top:6px', title: 'Crée une table de variables avec les données de chaque module', onclick: () => {
    createTags(device, m);
    rerender();
  } }, 'Créer les variables API');
  out.push(h('div', { style: 'overflow:auto;max-height:340px' }, table), tags);
  return out;
}

/** Tags for the data of each module: Byte / Word / DWord, or one Byte per octet beyond. */
function createTags(device: Device, m: PnRemoteModule): void {
  const name = `PROFINET ${m.name}`;
  let table = device.tagTables.find((x) => x.name === name);
  if (!table) {
    table = { id: `tt-${Date.now().toString(36)}`, name, tags: [], constants: [] };
    device.tagTables.push(table);
  }
  const tags: Array<{ name: string; dataType: string; address: string; comment: string }> = [];
  const add = (base: string, area: 'I' | 'Q', byte: number, len: number, comment: string) => {
    const typed: Record<number, [string, string]> = { 1: ['Byte', 'B'], 2: ['Word', 'W'], 4: ['DWord', 'D'] };
    if (typed[len]) tags.push({ name: base, dataType: typed[len][0], address: `%${area}${typed[len][1]}${byte}`, comment });
    else for (let k = 0; k < len; k++) tags.push({ name: `${base}_${k}`, dataType: 'Byte', address: `%${area}B${byte + k}`, comment });
  };
  for (const s of m.submodules) {
    if (!s.inLength && !s.outLength) continue;
    const mod = m.catalog?.modules.find((x) => x.ident === s.moduleIdent);
    const label = `${m.stationName} emplacement ${s.slot}${mod ? ` (${mod.name})` : ''}`;
    if (s.inLength) add(`${m.name}_S${s.slot}_IN`, 'I', s.inByte, s.inLength, label);
    if (s.outLength) add(`${m.name}_S${s.slot}_OUT`, 'Q', s.outByte, s.outLength, label);
  }
  for (const tag of tags) {
    const i = table.tags.findIndex((x) => x.name === tag.name);
    if (i >= 0) table.tags[i] = tag;
    else table.tags.push(tag);
  }
  store.touch();
  store.addMessage({ severity: 'ok', path: `${device.name} > ${m.name}`, text: `${tags.length} variable(s) dans « ${name} ».` });
}
