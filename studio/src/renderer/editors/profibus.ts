// PROFIBUS DP in the device configuration: slaves driven by the CPU as DP master (class 1)
// through an RS-485 adapter, added from their GSD file (modules, parameters) or by hand.
import { cfgLengths, parseGsd, type Device, type IoModuleConfig } from '../../../../sdk/src/browser.ts';
import { h } from '../dom.ts';
import { call, host } from '../host.ts';
import { alertDialog } from '../ui/dialogs.ts';
import { store } from '../store.ts';

export type DpModule = Extract<IoModuleConfig, { kind: 'profibus-slave' }>;

export const DP_SPEEDS = [9600, 19200, 45450, 93750, 187500, 500000, 1500000, 3000000, 6000000, 12000000];

const field = (label: string, input: HTMLElement, hint?: string) =>
  h('div', { className: 'field' }, h('label', null, label), input, hint ? h('span', { className: 'hint' }, hint) : h('span'));
const sub = (text: string) => h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, text);

function num(value: number, set: (v: number) => void, min = 0, max = 65535): HTMLInputElement {
  const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), style: 'width:110px' });
  i.onchange = () => {
    const v = Math.max(min, Math.min(max, Math.round(Number(i.value) || 0)));
    i.value = String(v);
    set(v);
  };
  return i;
}

const hex = (bytes: number[] | undefined) => (bytes ?? []).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

function hexInput(value: number[] | undefined, set: (v: number[]) => void): HTMLInputElement {
  const i = h('input', { value: hex(value), className: 'mono', placeholder: '(aucun)' });
  i.onchange = () => {
    const tokens = i.value.trim().split(/[\s,]+/).filter(Boolean);
    if (tokens.some((t) => !/^(0x)?[0-9a-f]{1,2}$/i.test(t))) {
      void alertDialog('PROFIBUS', 'Octets en hexadécimal séparés par des espaces (ex. 00 01 FF).', 'error');
      i.value = hex(value);
      return;
    }
    set(tokens.map((t) => parseInt(t.replace(/^0x/i, ''), 16)));
  };
  return i;
}

const speedLabel = (b: number) => (b >= 1000000 ? `${b / 1000000} Mbit/s` : `${b / 1000} kbit/s`);

function busPort(device: Device): string {
  const other = device.io.find((m) => m.kind === 'profibus-slave') as DpModule | undefined;
  return other?.port ?? '/dev/ttyUSB0';
}

function nextStation(device: Device): number {
  const used = new Set(device.io.filter((m) => m.kind === 'profibus-slave').map((m) => (m as DpModule).station));
  let s = 3;
  while (used.has(s)) s++;
  return s;
}

export function newDpSlave(device: Device, inByte: number, outByte: number): DpModule {
  const n = device.io.filter((x) => x.kind === 'profibus-slave').length + 1;
  const other = device.io.find((m) => m.kind === 'profibus-slave') as DpModule | undefined;
  return {
    kind: 'profibus-slave', name: `DP_${n}`, port: busPort(device), baud: other?.baud ?? 500000, station: nextStation(device),
    identNumber: 0, watchdogMs: 200, config: [0x11, 0x21], inByte, inLength: 2, outByte, outLength: 2,
  };
}

/** Recomputes the configuration and the lengths from the plugged modules */
export function applyDpModules(m: DpModule): void {
  const c = m.catalog;
  if (!c) return;
  m.config = c.plugged.flatMap((name) => c.modules.find((x) => x.name === name)?.config ?? []);
  const l = cfgLengths(m.config);
  m.inLength = l.inLength;
  m.outLength = l.outLength;
}

export async function addGsdSlave(device: Device, nextIn: number, nextOut: number): Promise<DpModule | null> {
  const [file] = await host.openFiles('gsd');
  if (!file) return null;
  try {
    const g = parseGsd(new TextDecoder('latin1').decode(file.bytes));
    if (!g.modules.length) throw new Error('Le fichier GSD ne décrit aucun module.');
    const m = newDpSlave(device, nextIn, nextOut);
    const other = device.io.find((x) => x.kind === 'profibus-slave' && x !== m) as DpModule | undefined;
    m.name = `DP_${m.station}`;
    m.identNumber = g.identNumber;
    m.userPrm = g.userPrm.length ? g.userPrm : undefined;
    m.baud = other?.baud ?? (g.bauds.includes(500000) ? 500000 : g.bauds[g.bauds.length - 1] ?? 500000);
    m.catalog = {
      file: file.name, vendor: g.vendor, model: g.model, modular: g.modular, maxModules: g.modular ? g.maxModules : 1,
      modules: g.modules.map((x) => ({ name: x.name, config: x.config })),
      plugged: g.modular ? [] : [g.modules[0].name],
    };
    applyDpModules(m);
    store.addMessage({ severity: 'ok', path: `${device.name} > ${m.name}`,
      text: `GSD « ${file.name} » : ${g.vendor} ${g.model} (ident 0x${g.identNumber.toString(16).toUpperCase()}), ${g.modules.length} module(s), station ${m.station}.` });
    return m;
  } catch (e) {
    await alertDialog('GSD', (e as Error).message, 'error');
    return null;
  }
}

export function dpProps(device: Device, m: DpModule, touch: () => void, rerender: () => void): HTMLElement[] {
  const c = m.catalog;
  const sameBus = device.io.filter((x) => x.kind === 'profibus-slave' && x.port === m.port) as DpModule[];
  // the speed and the master address are those of the bus: shared by its slaves
  const setBus = (f: (x: DpModule) => void) => { for (const x of sameBus) f(x); touch(); rerender(); };
  const portInput = h('input', { value: m.port, list: 'dp-ports' });
  portInput.onchange = () => { m.port = portInput.value.trim(); touch(); rerender(); };
  const ports = h('datalist', { id: 'dp-ports' });
  void call('serialPorts').then((list) => { for (const p of list) ports.append(h('option', { value: p.path }, p.label || p.path)); }).catch(() => undefined);
  const speeds = h('select', null, ...DP_SPEEDS.map((b) => h('option', { value: String(b), selected: b === m.baud }, speedLabel(b))));
  speeds.onchange = () => setBus((x) => { x.baud = Number(speeds.value); });
  const range = (area: string, byte: number, len: number) => (len ? `%${area}${byte}…%${area}${byte + len - 1}` : '—');
  const out: HTMLElement[] = [
    h('p', { className: 'muted', style: 'margin:4px 0;line-height:1.45' },
      `Esclave PROFIBUS DP piloté par cette CPU (maître DP classe 1)${c ? ` — ${c.vendor} ${c.model} (${c.file})` : ''}. `
      + 'Liaison par un adaptateur RS-485 (USB ou port série) relié au bus ; la CPU paramètre l\'esclave (Set_Prm, Chk_Cfg) puis échange ses données en continu.'),
    sub('Bus'),
    field('Port série', h('span', null, portInput, ports), 'Adaptateur RS-485 (ex. /dev/ttyUSB0) ; tous les esclaves du même port forment un bus'),
    field('Vitesse', speeds, 'Identique pour tous les esclaves du bus (réglage de l\'adaptateur : jusqu\'à 12 Mbit/s selon le modèle)'),
    field('Adresse du maître', num(m.masterAddress ?? 1, (v) => setBus((x) => { x.masterAddress = v; }), 0, 125)),
    field('Écho de l\'adaptateur', (() => { const cb = h('input', { type: 'checkbox', checked: !!m.echo, style: 'width:auto' }); cb.onchange = () => setBus((x) => { x.echo = cb.checked || undefined; }); return cb; })(),
      'Cocher si l\'adaptateur relit ce qu\'il émet (RS-485 sans suppression d\'écho)'),
    sub('Esclave'),
    field('Adresse PROFIBUS', num(m.station, (v) => {
      if (sameBus.some((x) => x !== m && x.station === v)) { void alertDialog('PROFIBUS', `L'adresse ${v} est déjà utilisée sur ce bus.`, 'error'); rerender(); return; }
      m.station = v; touch(); rerender();
    }, 1, 125), 'Réglée sur l\'esclave (roues codeuses, paramètre)'),
    field('Numéro d\'identification', (() => {
      const i = h('input', { value: `0x${m.identNumber.toString(16).toUpperCase().padStart(4, '0')}`, style: 'width:110px' });
      i.onchange = () => { const v = Number(i.value.trim()); if (Number.isInteger(v) && v >= 0 && v <= 0xffff) m.identNumber = v; touch(); rerender(); };
      return i;
    })(), 'Ident_Number du fichier GSD : vérifié par l\'esclave'),
    field('Chien de garde (ms)', num(m.watchdogMs ?? 0, (v) => { m.watchdogMs = v; touch(); }, 0, 65000), 'L\'esclave coupe ses sorties sans échange pendant ce temps (0 = sans)'),
    field('Paramètres utilisateur', hexInput(m.userPrm, (v) => { m.userPrm = v.length ? v : undefined; touch(); }), 'User_Prm_Data (octets hexadécimaux)'),
    sub('Modules et adresses'),
    field('Adresses de début', h('span', { style: 'display:flex;gap:6px;align-items:center' },
      '%I', num(m.inByte, (v) => { m.inByte = v; touch(); rerender(); }), '%Q', num(m.outByte, (v) => { m.outByte = v; touch(); rerender(); }))),
  ];
  if (c) {
    const table = h('table', { className: 'grid', style: 'margin-top:4px' }, h('tr', null, h('th', null, 'Empl.'), h('th', null, 'Module'), h('th', null, 'Identifiants'), h('th', null, 'E'), h('th', null, 'S')));
    const slots = c.modular ? Math.max(c.plugged.length + 1, 1) : 1;
    for (let k = 0; k < Math.min(slots, c.maxModules); k++) {
      const sel = h('select', { style: 'width:100%', disabled: !c.modular }, h('option', { value: '' }, '—'), ...c.modules.map((x) => h('option', { value: x.name }, x.name)));
      sel.value = c.plugged[k] ?? '';
      sel.onchange = () => {
        if (sel.value) c.plugged[k] = sel.value;
        else c.plugged.splice(k, 1);
        applyDpModules(m);
        touch();
        rerender();
      };
      const mod = c.modules.find((x) => x.name === c.plugged[k]);
      const l = mod ? cfgLengths(mod.config) : { inLength: 0, outLength: 0 };
      table.append(h('tr', null, h('td', null, String(k + 1)), h('td', null, sel), h('td', { className: 'mono' }, hex(mod?.config)), h('td', null, l.inLength ? `${l.inLength} o` : ''), h('td', null, l.outLength ? `${l.outLength} o` : '')));
    }
    out.push(h('div', { style: 'overflow:auto;max-height:300px' }, table));
  } else {
    out.push(field('Identifiants de configuration', hexInput(m.config, (v) => { m.config = v; const l = cfgLengths(v); m.inLength = l.inLength; m.outLength = l.outLength; touch(); rerender(); }),
      'Chk_Cfg (octets hexadécimaux, ex. 11 21 = 2 octets d\'entrées, 2 de sorties)'));
  }
  out.push(h('p', { className: 'muted', style: 'margin:6px 0' }, `Entrées ${range('I', m.inByte, m.inLength)} ; sorties ${range('Q', m.outByte, m.outLength)}.`));
  return out;
}
