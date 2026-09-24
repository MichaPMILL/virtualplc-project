// Device configuration ("Configuration des appareils") and online & diagnostics.
import { DEVICE_TYPES, type Device, type IoModuleConfig } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import { contextMenu } from '../ui/chrome.ts';
import type { EditorView } from './types.ts';

type ModuleKind = IoModuleConfig['kind'];

const MODULE_LABELS: Record<ModuleKind, string> = {
  'modbus-tcp': 'Module Modbus TCP',
  'gpio-di': 'Entrée TOR (GPIO)',
  'gpio-do': 'Sortie TOR (GPIO)',
  'gpio-ai': 'Entrée analogique (GPIO)',
  'gpio-ao': 'Sortie analogique (GPIO)',
};

function supportedModules(device: Device): ModuleKind[] {
  switch (device.type) {
    case 'linux': return ['modbus-tcp', 'gpio-di', 'gpio-do'];
    case 'esp32': return ['gpio-di', 'gpio-do', 'gpio-ai', 'gpio-ao'];
    default: return ['gpio-di', 'gpio-do', 'gpio-ai', 'gpio-ao'];
  }
}

/** First free byte (area I or Q) after the modules already configured. */
function nextByte(device: Device, area: 'I' | 'Q'): number {
  let next = 0;
  for (const m of device.io) {
    const ranges: Array<[string, number, number]> = m.kind === 'modbus-tcp'
      ? [['I', m.di?.byte ?? 0, Math.ceil((m.di?.count ?? 0) / 8)], ['Q', m.coils?.byte ?? 0, Math.ceil((m.coils?.count ?? 0) / 8)],
        ['I', m.ir?.byte ?? 0, (m.ir?.count ?? 0) * 2], ['Q', m.hr?.byte ?? 0, (m.hr?.count ?? 0) * 2]]
      : m.kind === 'gpio-di' ? [['I', m.byte, 1]] : m.kind === 'gpio-do' ? [['Q', m.byte, 1]]
        : m.kind === 'gpio-ai' ? [['I', m.byte, 2]] : [['Q', m.byte, 2]];
    for (const [a, byte, len] of ranges) if (a === area && len > 0) next = Math.max(next, byte + len);
  }
  return next;
}

function newModule(device: Device, kind: ModuleKind): IoModuleConfig {
  const n = device.io.length + 1;
  switch (kind) {
    case 'modbus-tcp':
      return { kind, name: `IO_${n}`, host: '192.168.0.20', port: 502, unit: 1, di: { byte: nextByte(device, 'I'), count: 8 }, coils: { byte: nextByte(device, 'Q'), count: 8 } };
    case 'gpio-di': {
      const bits = device.io.filter((m) => m.kind === 'gpio-di').length;
      return { kind, name: `DI_${n}`, pin: 0, byte: 100 + Math.floor(bits / 8), bit: bits % 8 };
    }
    case 'gpio-do': {
      const bits = device.io.filter((m) => m.kind === 'gpio-do').length;
      return { kind, name: `DQ_${n}`, pin: 0, byte: 100 + Math.floor(bits / 8), bit: bits % 8 };
    }
    case 'gpio-ai':
      return { kind, name: `AI_${n}`, pin: 0, byte: 200 + 2 * device.io.filter((m) => m.kind === 'gpio-ai').length };
    default:
      return { kind: 'gpio-ao', name: `AQ_${n}`, pin: 0, byte: 200 + 2 * device.io.filter((m) => m.kind === 'gpio-ao').length };
  }
}

function addresses(m: IoModuleConfig): string[] {
  const range = (area: string, byte: number, bytes: number) => (bytes > 0 ? `${area} ${byte}${bytes > 1 ? `...${byte + bytes - 1}` : ''}` : null);
  switch (m.kind) {
    case 'modbus-tcp':
      return [range('I', m.di?.byte ?? 0, Math.ceil((m.di?.count ?? 0) / 8)), range('Q', m.coils?.byte ?? 0, Math.ceil((m.coils?.count ?? 0) / 8)),
        range('IW', m.ir?.byte ?? 0, (m.ir?.count ?? 0) * 2), range('QW', m.hr?.byte ?? 0, (m.hr?.count ?? 0) * 2)].filter((x): x is string => !!x);
    case 'gpio-di': return [`%I${m.byte}.${m.bit}`];
    case 'gpio-do': return [`%Q${m.byte}.${m.bit}`];
    case 'gpio-ai': return [`%IW${m.byte}`];
    default: return [`%QW${m.byte}`];
  }
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('div', { className: 'field' }, h('label', null, label), input, hint ? h('span', { className: 'hint' }, hint) : h('span'));
}

function numInput(value: number, onChange: (v: number) => void, min = 0, max = 65535): HTMLInputElement {
  const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), style: 'width:110px' });
  i.onchange = () => {
    const v = Math.max(min, Math.min(max, Math.round(Number(i.value) || 0)));
    i.value = String(v);
    onChange(v);
  };
  return i;
}

function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const i = h('input', { value });
  i.onchange = () => onChange(i.value.trim());
  return i;
}

export function deviceEditor(device: Device): EditorView {
  let selected: number = -1; // -1 = CPU
  const rack = h('div', { className: 'rack' });
  const props = h('div', { className: 'props-form' });
  const touch = () => {
    store.touch();
    renderRack();
  };

  const renderRack = () => {
    clear(rack);
    const s = store.onlineOf(device.id);
    const led = (on: boolean, cls: string) => h('span', { className: `led${on ? ` ${cls}` : ''}` });
    const row = h('div', { className: 'rack-row' });
    row.append(h('div', { className: `module cpu${selected === -1 ? ' selected' : ''}`, onclick: () => { selected = -1; renderRack(); renderProps(); } },
      h('div', { className: 'm-head' }, device.name),
      h('div', { className: 'm-leds' }, led(s.connected && s.state === 'RUN', 'on-green'), led(s.connected && s.state === 'STOP', 'on-yellow'), led(s.connected && s.state === 'FAULT', 'on-red')),
      h('div', { className: 'm-body' }, DEVICE_TYPES[device.type].label, h('br'), DEVICE_TYPES[device.type].order, h('br'), h('br'), `IP ${device.connection.host}`),
      h('div', { className: 'm-foot' }, `Emplacement 1`)));
    device.io.forEach((m, i) => {
      const ok = s.connected ? s.io?.[i]?.ok : undefined;
      row.append(h('div', {
        className: `module${selected === i ? ' selected' : ''}`,
        onclick: () => { selected = i; renderRack(); renderProps(); },
        oncontextmenu: (e: Event) => contextMenu(e as MouseEvent, [{ label: t.delete, icon: 'del', run: () => { device.io.splice(i, 1); selected = -1; touch(); renderProps(); } }]),
      },
      h('div', { className: 'm-head' }, m.name),
      h('div', { className: 'm-leds' }, led(ok === true, 'on-green'), led(ok === false, 'on-red')),
      h('div', { className: 'm-body' }, MODULE_LABELS[m.kind], m.kind === 'modbus-tcp' ? h('div', null, `${m.host}:${m.port ?? 502}`) : h('div', null, `GPIO ${m.pin}`),
        ...addresses(m).map((a) => h('div', { className: 'mono' }, a))),
      h('div', { className: 'm-foot' }, `Emplacement ${i + 2}`)));
    });
    row.append(h('div', {
      className: 'module add', title: 'Ajouter un module',
      onclick: (e: Event) => contextMenu(e as MouseEvent, supportedModules(device).map((k) => ({
        label: MODULE_LABELS[k], icon: 'device' as const, run: () => {
          device.io.push(newModule(device, k));
          selected = device.io.length - 1;
          touch();
          renderProps();
        },
      }))),
    }, '+'));
    rack.append(h('div', { className: 'muted', style: 'margin-bottom:8px' }, 'Vue des appareils — cliquez sur un module pour afficher ses propriétés, sur « + » pour ajouter un module d\'E/S.'), row);
  };

  const renderProps = () => {
    clear(props);
    if (selected === -1) {
      props.append(
        h('h3', null, `${device.name} [${DEVICE_TYPES[device.type].label}]`),
        h('div', { className: 'panel-subheader', style: 'margin:0 -14px 6px' }, t.general),
        field(t.name, textInput(device.name, (v) => { if (v) { device.name = v; touch(); store.emit('editors'); } })),
        field('Référence', h('input', { value: `${DEVICE_TYPES[device.type].order} (${DEVICE_TYPES[device.type].label})`, disabled: true })),
        field(t.comment, (() => { const ta = h('textarea'); ta.value = device.comment ?? ''; ta.onchange = () => { device.comment = ta.value; store.touch(); }; return ta; })()),
        h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, device.type === 'arduino' ? 'Interface USB' : 'Interface PROFINET / Ethernet'),
        field(device.type === 'arduino' ? 'Port série' : t.ipAddress, textInput(device.connection.host, (v) => { device.connection.host = v; touch(); }), device.type === 'arduino' ? 'ex. COM3, /dev/ttyACM0' : 'ex. 192.168.0.10'),
        field(t.port, numInput(device.connection.port, (v) => { device.connection.port = v; store.touch(); }, 1, 65535), 'Protocole VirtualPLC (par défaut 20105)'),
        h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, 'Cycle'),
        field('Temps de cycle (ms)', numInput(device.cpu.cycleMs, (v) => { device.cpu.cycleMs = v; store.touch(); }, 1, 60000), 'Période d\'exécution de l\'OB de cycle de programme'),
        h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, 'Protection & sécurité'),
        h('p', { className: 'muted', style: 'margin:4px 0' }, 'Le mot de passe d\'accès est défini sur la CPU (option --password-file du service vplc-cpu). Il est demandé lors de la liaison en ligne.'),
      );
      return;
    }
    const m = device.io[selected];
    if (!m) return;
    props.append(h('h3', null, `${m.name} — ${MODULE_LABELS[m.kind]}`),
      field(t.name, textInput(m.name, (v) => { if (/^[A-Za-z_]\w*$/.test(v)) { m.name = v; touch(); } }), 'Utilisable dans le programme : DEVICE_OK(' + m.name + ')'));
    if (m.kind === 'modbus-tcp') {
      const range = (label: string, key: 'di' | 'coils' | 'ir' | 'hr', area: string, unit: string) => {
        const r = (m[key] ??= { byte: 0, count: 0 });
        return h('div', { className: 'field', style: 'grid-template-columns:180px 110px 110px auto' }, h('label', null, label),
          numInput(r.count, (v) => { r.count = v; touch(); }, 0, key === 'di' || key === 'coils' ? 2000 : 125),
          numInput(r.byte, (v) => { r.byte = v; touch(); }),
          h('span', { className: 'hint' }, `${unit} → adresse de début %${area}${r.byte}`));
      };
      props.append(
        field(t.ipAddress, textInput(m.host, (v) => { m.host = v; touch(); })),
        field(t.port, numInput(m.port ?? 502, (v) => { m.port = v; touch(); }, 1, 65535)),
        field('ID esclave (unit)', numInput(m.unit ?? 1, (v) => { m.unit = v; touch(); }, 0, 255)),
        field('Période de scrutation (ms)', numInput(m.pollMs ?? 0, (v) => { m.pollMs = v; touch(); }, 0, 60000), '0 = à chaque cycle'),
        h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, 'Adresses d\'E/S (nombre, octet de début)'),
        range('Entrées TOR (FC2)', 'di', 'I', 'bits'),
        range('Sorties TOR (FC15)', 'coils', 'Q', 'bits'),
        range('Registres d\'entrée (FC4)', 'ir', 'IW', 'mots'),
        range('Registres de maintien (FC16)', 'hr', 'QW', 'mots'),
      );
    } else {
      props.append(field('Broche GPIO', numInput(m.pin, (v) => { m.pin = v; touch(); }, 0, 255), device.type === 'linux' ? 'Numéro de ligne GPIO (BCM sur Raspberry Pi)' : 'Numéro de broche de la carte'));
      if (m.kind === 'gpio-di' || m.kind === 'gpio-do') {
        props.append(
          field('Octet', numInput(m.byte, (v) => { m.byte = v; touch(); })),
          field('Bit', numInput(m.bit, (v) => { m.bit = v; touch(); }, 0, 7), `→ %${m.kind === 'gpio-di' ? 'I' : 'Q'}${m.byte}.${m.bit}`),
          field('Inverser', (() => { const cb = h('input', { type: 'checkbox', checked: !!m.invert, style: 'width:auto' }); cb.onchange = () => { m.invert = cb.checked; touch(); }; return cb; })()),
        );
        if (m.kind === 'gpio-di') {
          props.append(field('Résistance de tirage', (() => { const cb = h('input', { type: 'checkbox', checked: !!m.pullup, style: 'width:auto' }); cb.onchange = () => { m.pullup = cb.checked; touch(); }; return cb; })()));
        }
      } else {
        props.append(field('Adresse (octet)', numInput(m.byte, (v) => { m.byte = v; touch(); }), `→ %${m.kind === 'gpio-ai' ? 'IW' : 'QW'}${m.byte}`));
      }
    }
  };

  renderRack();
  renderProps();
  const unsubscribe = store.on((topic) => { if (topic === 'online') renderRack(); });
  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'subtabs' }, h('div', { className: 'tab active' }, svg(icons.device), 'Vue des appareils'), h('div', { className: 'tab' }, svg(icons.network), 'Vue du réseau')),
    h('div', { style: 'flex:1;display:grid;grid-template-rows:minmax(240px,45%) 1fr;min-height:0' },
      rack,
      h('div', { style: 'display:flex;flex-direction:column;min-height:0;border-top:1px solid var(--border)' },
        h('div', { className: 'panel-header' }, svg(icons.properties), t.properties), h('div', { style: 'flex:1;overflow:auto' }, props))));
  return {
    element,
    icon: 'device',
    title: () => `${device.name}`,
    crumbs: () => [device.name, t.deviceConfig],
    refresh: () => { renderRack(); renderProps(); },
    destroy: unsubscribe,
  };
}

// ---------------------------------------------------------------------------
// Online & diagnostics
// ---------------------------------------------------------------------------

export function onlineEditor(device: Device): EditorView {
  const body = h('div', { style: 'flex:1;overflow:auto;padding:10px' });
  const render = () => {
    clear(body);
    const s = store.onlineOf(device.id);
    const offlineId = store.compile.get(device.id)?.programId;
    if (!s.connected) {
      body.append(h('div', { className: 'empty-state' },
        svg(icons.offline, 'icon'),
        h('div', null, `${device.name} n'est pas en ligne.`),
        h('button', { className: 'button primary', onclick: () => void A.goOnlineCmd(device) }, svg(icons.online), t.goOnline)));
      return;
    }
    const led = (on: boolean, color: string, blink = false) => h('span', { className: `led-big${on ? ` ${color}` : ''}${blink ? ' blink' : ''}` });
    const state = s.state ?? '?';
    const fault = s.fault;
    const faultBlock = fault ? store.compile.get(device.id)?.functions[fault.function] : undefined;
    const block = faultBlock ? device.blocks.find((b) => b.name.toLowerCase() === faultBlock.name.toLowerCase()) : undefined;
    body.append(
      h('div', { style: 'display:grid;grid-template-columns:320px 1fr;gap:12px;align-items:start' },
        h('div', { className: 'operator', style: 'margin:0' },
          h('div', { className: 'op-title' }, `Panneau de commande CPU — ${device.name}`),
          h('div', { className: 'op-body' },
            h('div', { className: 'leds' },
              led(state === 'RUN' || state === 'STOP', state === 'RUN' ? 'green' : 'yellow'), h('span', null, 'RUN / STOP'),
              led(state === 'FAULT', 'red', true), h('span', null, 'ERROR'),
              led((s.forces ?? 0) > 0, 'yellow'), h('span', null, 'MAINT (forçage)')),
            h('div', { className: 'op-buttons' },
              h('button', { className: 'button', disabled: state === 'RUN', onclick: () => void A.startCpuCmd(device) }, svg(icons.run), 'RUN'),
              h('button', { className: 'button', disabled: state !== 'RUN', onclick: () => void A.stopCpuCmd(device) }, svg(icons.stop), 'STOP'),
              h('button', { className: 'button', onclick: () => void A.coldRestartCmd(device) }, 'Démarrage à froid')))),
        h('div', { className: 'operator', style: 'margin:0' },
          h('div', { className: 'op-title' }, 'État'),
          h('div', { className: 'kv' },
            h('span', null, 'Mode de fonctionnement'), h('span', null, h('span', { className: `pill ${state === 'RUN' ? 'run' : state === 'FAULT' ? 'fault' : 'stop'}` }, state)),
            h('span', null, 'Adresse'), h('span', null, s.host ?? ''),
            h('span', null, 'Programme en ligne'), h('span', { className: 'mono' }, s.programId ?? '—'),
            h('span', null, 'Programme hors ligne'), h('span', { className: 'mono' }, offlineId ?? '(non compilé)'),
            h('span', null, 'Comparaison'), h('span', null, s.programId && offlineId ? (s.programId === offlineId ? h('span', { className: 'ok-text' }, 'Identiques') : h('span', { className: 'error-text' }, 'Différents — chargez le programme')) : '—'),
            h('span', null, 'Temps de cycle'), h('span', null, `configuré ${s.cycleMs ?? '?'} ms — exécution ${((s.scanUs ?? 0) / 1000).toFixed(2)} ms (max ${((s.maxScanUs ?? 0) / 1000).toFixed(2)} ms)`),
            h('span', null, 'Forçages actifs'), h('span', null, String(s.forces ?? 0)),
            ...(fault ? [h('span', null, 'Défaut'), h('span', { className: 'error-text' }, `${fault.code} dans ${faultBlock?.name ?? `fonction ${fault.function}`}, ligne ${fault.line} `,
              block ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); A.goto({ kind: 'block', deviceId: device.id, blockId: block.id, line: fault.line - (store.compile.get(device.id)?.codeLines[block.id] ?? 1) + 1 }); } }, 'Aller à') : '')] : []),
          ))),
      h('div', { className: 'operator', style: 'margin:12px 0 0' },
        h('div', { className: 'op-title' }, 'Modules d\'E/S'),
        h('table', { className: 'grid' },
          h('tr', null, h('th', { style: 'width:60px' }, 'État'), h('th', null, 'Module'), h('th', null, 'Type')),
          ...device.io.map((m, i) => h('tr', null, h('td', null, svg(s.io?.[i]?.ok ? icons.ok : icons.error)), h('td', null, m.name), h('td', null, MODULE_LABELS[m.kind]))),
          device.io.length === 0 ? h('tr', null, h('td', { colSpan: '3', className: 'muted' }, 'Aucun module configuré')) : null)),
      h('div', { className: 'operator', style: 'margin:12px 0 0' },
        h('div', { className: 'op-title' }, 'Tampon de diagnostic'),
        h('table', { className: 'grid' },
          h('tr', null, h('th', { style: 'width:60px' }, 'N°'), h('th', { style: 'width:110px' }, 'Temps (ms)'), h('th', null, 'Événement')),
          ...[...s.logs].reverse().slice(0, 200).map((l) => h('tr', null, h('td', null, String(l.seq)), h('td', { className: 'mono' }, String(l.t)), h('td', null, l.msg))))),
    );
  };
  const unsubscribe = store.on((topic) => { if (topic === 'online') render(); });
  render();
  return {
    element: h('div', { className: 'editor-host' }, body),
    icon: 'diag',
    title: () => `${t.onlineDiag}`,
    crumbs: () => [device.name, t.onlineDiag],
    destroy: unsubscribe,
  };
}
