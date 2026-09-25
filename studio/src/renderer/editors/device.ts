// Device configuration ("Configuration des appareils") and online & diagnostics.
import { DEVICE_TYPES, keyFingerprint, ioChannels, ioLinkTags, isSerialPort, parseIodd, type Device, type IoLinkPort, type IoModuleConfig } from '../../../../sdk/src/browser.ts';
import { host } from '../host.ts';
import { alertDialog, confirmDialog } from '../ui/dialogs.ts';
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import { contextMenu } from '../ui/chrome.ts';
import type { EditorView } from './types.ts';
import { addGsdmlDevice, newPnDevice, pnDeviceProps, pnRemoteProps } from './profinet.ts';
import { addEdsDevice, discoverEnipDevices, enipProps, newEnipAdapter } from './ethernetip.ts';
import { addGsdSlave, dpProps, newDpSlave } from './profibus.ts';

/** One tag per channel of the module that no tag uses yet */
function createTags(device: Device, m: IoModuleConfig): void {
  const table = device.tagTables[0];
  const used = new Set(device.tagTables.flatMap((tt) => tt.tags.map((x) => x.address.toUpperCase())));
  const names = new Set(device.tagTables.flatMap((tt) => tt.tags.map((x) => x.name.toLowerCase())));
  let added = 0;
  for (const c of ioChannels(device).filter((x) => x.module === m.name)) {
    if (used.has(c.address)) continue;
    let name = c.name;
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `${c.name}_${i}`;
    names.add(name.toLowerCase());
    table.tags.push({ name, dataType: c.dataType, address: c.address, comment: `${m.name} — ${c.detail}` });
    added++;
  }
  store.touch();
  store.addMessage({ severity: added ? 'ok' : 'info', text: added ? `${added} variable(s) créée(s) dans « ${table.name} » pour ${m.name}.` : `Toutes les entrées / sorties de ${m.name} ont déjà une variable.`, path: device.name });
  if (added) A.openEditor({ kind: 'tagTable', deviceId: device.id, tableId: table.id });
}

type ModuleKind = IoModuleConfig['kind'];

const MODULE_LABELS: Record<ModuleKind, string> = {
  'modbus-tcp': 'Module Modbus TCP',
  'gpio-di': 'Entrée TOR (GPIO)',
  'gpio-do': 'Sortie TOR (GPIO)',
  'gpio-ai': 'Entrée analogique (GPIO)',
  'gpio-ao': 'Sortie analogique (GPIO)',
  'iolink-master': 'Maître IO-Link (Modbus TCP)',
  'profinet-device': 'IO-Device PROFINET (vers un automate maître)',
  'profinet-remote': 'Appareil PROFINET (IO-Controller)',
  'enip-adapter': 'Appareil EtherNet/IP (scanner)',
  'profibus-slave': 'Esclave PROFIBUS DP (maître DP)',
};

function supportedModules(device: Device): ModuleKind[] {
  switch (device.type) {
    case 'linux': return ['modbus-tcp', 'iolink-master', 'profinet-device', 'enip-adapter', 'profibus-slave', 'gpio-di', 'gpio-do'];
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
      : m.kind === 'iolink-master' ? m.ports.flatMap((p): Array<[string, number, number]> => [['I', p.inByte, p.inLength], ['Q', p.outByte, p.outLength]])
      : m.kind === 'profinet-device' ? [['I', m.inByte, m.inLength], ['Q', m.outByte, m.outLength]]
      : m.kind === 'profinet-remote' ? m.submodules.flatMap((x): Array<[string, number, number]> => [['I', x.inByte, x.inLength], ['Q', x.outByte, x.outLength]])
      : m.kind === 'enip-adapter' || m.kind === 'profibus-slave' ? [['I', m.inByte, m.inLength], ['Q', m.outByte, m.outLength]]
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
    case 'iolink-master': {
      const inBase = nextByte(device, 'I');
      const outBase = nextByte(device, 'Q');
      return {
        kind, name: `IOL_${n}`, host: '192.168.0.30', port: 502, unit: 1, inFunction: 3,
        ports: [1, 2, 3, 4].map((p, i) => ({ port: p, inRegister: 0, inByte: inBase + i * 4, inLength: 4, outRegister: 0, outByte: outBase + i * 2, outLength: 0 })),
      };
    }
    case 'profinet-device':
      return newPnDevice(device, n, nextByte(device, 'I'), nextByte(device, 'Q'));
    case 'enip-adapter':
      return newEnipAdapter(device, nextByte(device, 'I'), nextByte(device, 'Q'));
    case 'profibus-slave':
      return newDpSlave(device, nextByte(device, 'I'), nextByte(device, 'Q'));
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
    case 'iolink-master':
      return m.ports.flatMap((p) => [p.inLength ? `P${p.port} ${range('I', p.inByte, p.inLength)}` : null, p.outLength ? `P${p.port} ${range('Q', p.outByte, p.outLength)}` : null])
        .filter((x): x is string => !!x);
    case 'profinet-device':
    case 'enip-adapter':
    case 'profibus-slave':
      return [range('I', m.inByte, m.inLength), range('Q', m.outByte, m.outLength)].filter((x): x is string => !!x);
    case 'profinet-remote': {
      const ins = m.submodules.filter((x) => x.inLength);
      const outs = m.submodules.filter((x) => x.outLength);
      return [ins.length ? range('I', Math.min(...ins.map((x) => x.inByte)), ins.reduce((a, x) => a + x.inLength, 0)) : null,
        outs.length ? range('Q', Math.min(...outs.map((x) => x.outByte)), outs.reduce((a, x) => a + x.outLength, 0)) : null].filter((x): x is string => !!x);
    }
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

/** Pinned key of the CPU: fingerprint, and "forget" (after a replacement of the CPU) */
function keyField(device: Device): HTMLElement {
  const box = h('span', { style: 'display:flex;gap:8px;align-items:center' });
  const key = device.connection.key;
  if (!key) {
    box.append(h('span', { className: 'muted' }, '(aucune — mémorisée à la prochaine liaison chiffrée)'));
    return box;
  }
  const fp = h('code', null, '…');
  void keyFingerprint(key).then((v) => { fp.textContent = v; });
  box.append(fp, h('button', { className: 'button', onclick: async () => {
    if (!(await confirmDialog('Clé de la CPU', 'Oublier la clé mémorisée ? La prochaine liaison affichera l\'empreinte de la clé de la CPU à vérifier.'))) return;
    const { key: _k, ...rest } = device.connection;
    device.connection = rest;
    store.touch();
  } }, 'Oublier'));
  return box;
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
      h('div', { className: 'm-body' }, DEVICE_TYPES[device.type].label, h('br'), h('br'), `IP ${device.connection.host}`),
      h('div', { className: 'm-foot' }, `Emplacement 1`)));
    device.io.forEach((m, i) => {
      const ok = s.connected ? s.io?.[i]?.ok : undefined;
      const diag = s.connected ? s.io?.[i]?.diag : undefined;
      const hasDiag = !!diag && /(^|\n)slot \d/.test(diag);
      row.append(h('div', {
        className: `module${selected === i ? ' selected' : ''}`,
        title: diag ?? '',
        onclick: () => { selected = i; renderRack(); renderProps(); },
        oncontextmenu: (e: Event) => contextMenu(e as MouseEvent, [{ label: t.delete, icon: 'del', run: () => { device.io.splice(i, 1); selected = -1; touch(); renderProps(); } }]),
      },
      h('div', { className: 'm-head' }, m.name),
      h('div', { className: 'm-leds' }, led(ok === true && !hasDiag, 'on-green'), led(ok === false || hasDiag, hasDiag && ok ? 'on-yellow' : 'on-red')),
      h('div', { className: 'm-body' }, MODULE_LABELS[m.kind],
        m.kind === 'modbus-tcp' || m.kind === 'iolink-master' ? h('div', null, `${m.host}:${m.port ?? 502}`)
          : m.kind === 'profinet-device' ? h('div', null, m.stationName)
            : m.kind === 'profinet-remote' ? h('div', null, `${m.stationName} (${m.ip})`)
              : m.kind === 'enip-adapter' ? h('div', null, m.catalog ? `${m.catalog.product} (${m.host})` : m.host)
                : m.kind === 'profibus-slave' ? h('div', null, `${m.catalog ? `${m.catalog.model} — ` : ''}adresse ${m.station}`) : h('div', null, `GPIO ${m.pin}`),
        ...addresses(m).map((a) => h('div', { className: 'mono' }, a))),
      h('div', { className: 'm-foot' }, `Emplacement ${i + 2}`)));
    });
    row.append(h('div', {
      className: 'module add', title: 'Ajouter un module',
      onclick: (e: Event) => contextMenu(e as MouseEvent, [...supportedModules(device).map((k) => ({
        label: MODULE_LABELS[k], icon: 'device' as const, run: () => {
          device.io.push(newModule(device, k));
          selected = device.io.length - 1;
          touch();
          renderProps();
        },
      })), ...(device.type === 'linux' ? [{
        label: 'Appareil PROFINET (fichier GSDML)...', icon: 'device' as const, run: async () => {
          const m = await addGsdmlDevice(device, nextByte(device, 'I'), nextByte(device, 'Q'));
          if (!m) return;
          device.io.push(m);
          selected = device.io.length - 1;
          touch();
          renderProps();
        },
      }, {
        label: 'Esclave PROFIBUS DP (fichier GSD)...', icon: 'device' as const, run: async () => {
          const m = await addGsdSlave(device, nextByte(device, 'I'), nextByte(device, 'Q'));
          if (!m) return;
          device.io.push(m);
          selected = device.io.length - 1;
          touch();
          renderProps();
        },
      }, {
        label: 'Rechercher des appareils EtherNet/IP...', icon: 'device' as const, run: async () => {
          const added = await discoverEnipDevices(device, () => nextByte(device, 'I'), () => nextByte(device, 'Q'));
          if (!added.length) return;
          selected = device.io.length - 1;
          touch();
          renderProps();
        },
      }, {
        label: 'Appareil EtherNet/IP (fichier EDS)...', icon: 'device' as const, run: async () => {
          const m = await addEdsDevice(device, nextByte(device, 'I'), nextByte(device, 'Q'));
          if (!m) return;
          device.io.push(m);
          selected = device.io.length - 1;
          touch();
          renderProps();
        },
      }] : [])]),
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
        field("Type d'appareil", h('input', { value: DEVICE_TYPES[device.type].label, disabled: true })),
        field(t.comment, (() => { const ta = h('textarea'); ta.value = device.comment ?? ''; ta.onchange = () => { device.comment = ta.value; store.touch(); }; return ta; })()),
        h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, isSerialPort(device.connection.host) ? 'Interface USB / série' : 'Interface Ethernet / Wi-Fi'),
        field(isSerialPort(device.connection.host) ? 'Port série' : t.ipAddress, textInput(device.connection.host, (v) => { device.connection.host = v; touch(); renderProps(); }),
          device.type === 'linux' ? 'ex. 192.168.0.10 — ou un port série (COM3, /dev/ttyUSB0) avec vplc-cpu --serial' : 'Adresse IP (Wi-Fi) ou port série USB : COM3, /dev/ttyUSB0, /dev/cu.usbserial…'),
        field(isSerialPort(device.connection.host) ? 'Vitesse (bauds)' : t.port, numInput(device.connection.port, (v) => { device.connection.port = v; store.touch(); }, 1, 4000000),
          isSerialPort(device.connection.host) ? 'Comme VPLC_SERIAL_BAUD du firmware (115200 par défaut)' : 'Protocole VirtualPLC (par défaut 20105)'),
        h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, 'Cycle'),
        field('Temps de cycle (ms)', numInput(device.cpu.cycleMs, (v) => { device.cpu.cycleMs = v; store.touch(); }, 1, 60000), 'Période d\'exécution de l\'OB de cycle de programme'),
        ...servicesProps(device, touch),
        h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, 'Protection & sécurité'),
        h('p', { className: 'muted', style: 'margin:4px 0' },
          'Comptes utilisateurs et rôles (lecture seule, opérateur, ingénieur, administrateur) : créés sur la CPU (vplc-cpu --add-user) puis gérés dans « Sécurité ». ',
          'Sans compte, un mot de passe unique (--password-file) donne tous les droits.'),
        field('Clé de la CPU', keyField(device), 'Liaison chiffrée (TLS) : la clé est mémorisée à la première connexion ; une autre CPU à cette adresse est refusée.'),
        h('p', { className: 'muted', style: 'margin:4px 0' }, h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); A.openEditor({ kind: 'security', deviceId: device.id }); } }, 'Utilisateurs et journal d\'audit…')),
      );
      return;
    }
    const m = device.io[selected];
    if (!m) return;
    props.append(h('h3', null, `${m.name} — ${MODULE_LABELS[m.kind]}`),
      field(t.name, textInput(m.name, (v) => { if (/^[A-Za-z_]\w*$/.test(v)) { m.name = v; touch(); } }), 'Utilisable dans le programme : DEVICE_OK(' + m.name + ')'),
      field('Variables API', h('button', { className: 'button', onclick: () => createTags(device, m) }, svg(icons.tagTable), ' Créer les variables'),
        'Ajoute à la table de variables standard une variable par entrée / sortie du module qui n\'en a pas encore'));
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
    } else if (m.kind === 'iolink-master') {
      props.append(...ioLinkProps(device, m, touch, () => renderProps()));
    } else if (m.kind === 'profinet-device') {
      props.append(...pnDeviceProps(device, m, touch));
    } else if (m.kind === 'profinet-remote') {
      props.append(...pnRemoteProps(device, m, touch, () => renderProps()));
    } else if (m.kind === 'profibus-slave') {
      props.append(...dpProps(device, m, touch, () => { renderRack(); renderProps(); }));
    } else if (m.kind === 'enip-adapter') {
      props.append(...enipProps(m, touch, () => { renderRack(); renderProps(); }));
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
    h('div', { className: 'subtabs' }, h('div', { className: 'tab active' }, svg(icons.device), 'Vue des appareils'),
      h('div', { className: 'tab', onclick: () => A.openEditor({ kind: 'network' }) }, svg(icons.network), 'Vue du réseau')),
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

type IoLinkMaster = Extract<IoModuleConfig, { kind: 'iolink-master' }>;

/** IO-Link master (Modbus TCP): connection, then one line per port with its process data mapping. */
function ioLinkProps(device: Device, m: IoLinkMaster, touch: () => void, rerender: () => void): HTMLElement[] {
  const num = (value: number, set: (v: number) => void, min = 0, max = 65535) => {
    const i = numInput(value, (v) => { set(v); touch(); }, min, max);
    i.style.width = '72px';
    return i;
  };
  const table = h('table', { className: 'grid', style: 'margin-top:6px' },
    h('tr', null, h('th', null, 'Port'), h('th', null, 'Appareil'), h('th', null, 'Registre PD in'), h('th', null, 'Octets in'), h('th', null, '→ %I'),
      h('th', null, 'Registre PD out'), h('th', null, 'Octets out'), h('th', null, '→ %Q'), h('th')));
  m.ports.forEach((p: IoLinkPort, i: number) => {
    const deviceName = h('input', { value: p.device ?? '', placeholder: '(libre)', style: 'width:150px' });
    deviceName.onchange = () => { p.device = deviceName.value.trim() || undefined; touch(); };
    table.append(h('tr', null,
      h('td', null, num(p.port, (v) => { p.port = v; }, 1, 16)),
      h('td', null, deviceName),
      h('td', null, num(p.inRegister, (v) => { p.inRegister = v; })),
      h('td', null, num(p.inLength, (v) => { p.inLength = v; }, 0, 32)),
      h('td', null, num(p.inByte, (v) => { p.inByte = v; })),
      h('td', null, num(p.outRegister, (v) => { p.outRegister = v; })),
      h('td', null, num(p.outLength, (v) => { p.outLength = v; }, 0, 32)),
      h('td', null, num(p.outByte, (v) => { p.outByte = v; })),
      h('td', { style: 'white-space:nowrap' },
        h('button', { className: 'button', title: 'Importer la description IODD du capteur : longueurs et variables API', onclick: () => void importIodd(device, m, p, touch, rerender) }, 'IODD...'),
        h('button', { className: 'button', style: 'margin-left:4px', title: 'Retirer le port', onclick: () => { m.ports.splice(i, 1); touch(); rerender(); } }, '×'))));
  });
  const fn = h('select', null, h('option', { value: '3' }, 'Registres de maintien (FC3)'), h('option', { value: '4' }, 'Registres d\'entrée (FC4)'));
  fn.value = String(m.inFunction ?? 3);
  fn.onchange = () => { m.inFunction = Number(fn.value) as 3 | 4; touch(); };
  return [
    field(t.ipAddress, textInput(m.host, (v) => { m.host = v; touch(); })),
    field(t.port, numInput(m.port ?? 502, (v) => { m.port = v; touch(); }, 1, 65535)),
    field('ID esclave (unit)', numInput(m.unit ?? 1, (v) => { m.unit = v; touch(); }, 0, 255)),
    field('Période de scrutation (ms)', numInput(m.pollMs ?? 0, (v) => { m.pollMs = v; touch(); }, 0, 60000), '0 = à chaque cycle'),
    field('Lecture des données process', fn, 'Selon le maître IO-Link (voir sa documentation Modbus)'),
    h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, 'Ports IO-Link'),
    h('p', { className: 'muted', style: 'margin:4px 0;line-height:1.45' },
      'Pour chaque port : registre Modbus des données process du maître (voir sa documentation), longueur en octets et adresse dans la mémoire image. '
      + 'Le bouton IODD lit la description du capteur (fichier XML du fabricant) : longueurs, et variables API créées aux bonnes adresses.'),
    table,
    h('button', { className: 'button', style: 'margin-top:6px', onclick: () => {
      const last = m.ports[m.ports.length - 1];
      m.ports.push({ port: (last?.port ?? 0) + 1, inRegister: 0, inByte: last ? last.inByte + Math.max(last.inLength, 1) : 0, inLength: 2, outRegister: 0, outByte: last ? last.outByte + last.outLength : 0, outLength: 0 });
      touch();
      rerender();
    } }, '+ Port'),
  ];
}

async function importIodd(device: Device, m: IoLinkMaster, p: IoLinkPort, touch: () => void, rerender: () => void): Promise<void> {
  const [file] = await host.openFiles('iodd');
  if (!file) return;
  try {
    const d = parseIodd(new TextDecoder().decode(file.bytes));
    p.device = `${d.vendor ? `${d.vendor} ` : ''}${d.device}`.trim();
    p.inLength = d.inLength;
    p.outLength = d.outLength;
    const { tags, skipped } = ioLinkTags(d, `${m.name}_P${p.port}`, p.inByte, p.outByte);
    let table = device.tagTables.find((x) => x.name === `IO-Link ${m.name}`);
    if (!table) {
      table = { id: `tt-${Date.now().toString(36)}`, name: `IO-Link ${m.name}`, tags: [], constants: [] };
      device.tagTables.push(table);
    }
    for (const tag of tags) {
      const i = table.tags.findIndex((x) => x.name === tag.name);
      if (i >= 0) table.tags[i] = tag;
      else table.tags.push(tag);
    }
    touch();
    rerender();
    store.addMessage({ severity: skipped.length ? 'warning' : 'ok', path: `${device.name} > ${m.name} > port ${p.port}`,
      text: `IODD « ${file.name} » : ${d.device}, ${d.inLength} octet(s) en entrée, ${d.outLength} en sortie ; ${tags.length} variable(s) dans « ${table.name} »`
        + (skipped.length ? ` (non mappées : ${skipped.join(', ')})` : '') });
  } catch (e) {
    await alertDialog('IODD', (e as Error).message, 'error');
  }
}

/** CPU properties: OPC UA server and S7 communication (HMI / SCADA access). */
function servicesProps(device: Device, touch: () => void): HTMLElement[] {
  if (device.type !== 'linux') {
    return [h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, 'Accès IHM'),
      h('p', { className: 'muted', style: 'margin:4px 0' }, 'Sur cette CPU, les IHM accèdent aux données par Modbus TCP. OPC UA et la communication S7 sont disponibles sur la CPU Linux / Raspberry Pi.')];
  }
  const sv = (device.services ??= {});
  const check = (label: string, value: boolean, set: (v: boolean) => void, hint?: string) => {
    const cb = h('input', { type: 'checkbox', checked: value, style: 'width:auto' });
    cb.onchange = () => { set(cb.checked); touch(); };
    return field(label, cb, hint);
  };
  const ua = (sv.opcua ??= { enabled: false, port: 4840, write: true, anonymous: true });
  const s7 = (sv.s7 ??= { enabled: false, port: 102, write: true });
  return [
    h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, 'Serveur OPC UA'),
    check('Activer le serveur OPC UA', ua.enabled, (v) => { ua.enabled = v; }, 'Les variables « Accessibles depuis IHM/OPC UA » sont publiées (arborescence : tables de variables, DB).'),
    field('Port', numInput(ua.port ?? 4840, (v) => { ua.port = v; touch(); }, 1, 65535), `Adresse du serveur : opc.tcp://${device.connection.host}:${ua.port ?? 4840}`),
    check('Autoriser l\'écriture', ua.write !== false, (v) => { ua.write = v; }, 'Seules les variables « Inscriptibles depuis IHM/OPC UA » peuvent être écrites.'),
    check('Accès anonyme', ua.anonymous !== false, (v) => { ua.anonymous = v; },
      'Sinon : utilisateur / mot de passe définis sur la CPU (--hmi-user, --hmi-password-file). Politique de sécurité « None » : réseau de confiance ou VPN.'),
    h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, 'Communication S7 (PUT/GET)'),
    check('Autoriser l\'accès via PUT/GET par un partenaire distant', s7.enabled, (v) => { s7.enabled = v; },
      'Pour les IHM / SCADA configurées avec une liaison S7 (ISO-on-TCP) : accès absolu à %I, %Q, %M et aux DB numérotés (ex. DB1.DBW2).'),
    field('Port', numInput(s7.port ?? 102, (v) => { s7.port = v; touch(); }, 1, 65535), 'Standard : 102 (le service a besoin de CAP_NET_BIND_SERVICE). Rack 0, emplacement 1 ou 2.'),
    check('Autoriser l\'écriture', s7.write !== false, (v) => { s7.write = v; }, 'Les variables en lecture seule pour les IHM restent protégées.'),
  ];
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
          h('tr', null, h('th', { style: 'width:60px' }, 'État'), h('th', null, 'Module'), h('th', null, 'Type'), h('th', null, 'Diagnostic')),
          ...device.io.map((m, i) => {
            const st = s.io?.[i];
            const diag = st?.diag ?? '';
            const icon = !st?.ok ? icons.error : /(^|\n)slot \d/.test(diag) ? icons.warning : icons.ok;
            return h('tr', null, h('td', null, svg(icon)), h('td', null, m.name), h('td', null, MODULE_LABELS[m.kind]),
              h('td', { style: 'white-space:pre-line' }, diag));
          }),
          device.io.length === 0 ? h('tr', null, h('td', { colSpan: '4', className: 'muted' }, 'Aucun module configuré')) : null)),
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
