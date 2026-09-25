// EtherNet/IP in the device configuration: adapters (I/O blocks, drives, cameras…) driven by
// the CPU as scanner, added from their EDS file or configured by hand (assembly instances).
import { parseEds, type Device, type EdsConnection, type IoModuleConfig } from '../../../../sdk/src/browser.ts';
import { h } from '../dom.ts';
import { call, host } from '../host.ts';
import { alertDialog, button, openDialog } from '../ui/dialogs.ts';
import { store } from '../store.ts';

export type EnipModule = Extract<IoModuleConfig, { kind: 'enip-adapter' }>;

const field = (label: string, input: HTMLElement, hint?: string) =>
  h('div', { className: 'field' }, h('label', null, label), input, hint ? h('span', { className: 'hint' }, hint) : h('span'));
const sub = (text: string) => h('div', { className: 'panel-subheader', style: 'margin:10px -14px 6px' }, text);

function num(value: number, set: (v: number) => void, min = 0, max = 65535, step = 1): HTMLInputElement {
  const i = h('input', { type: 'number', value: String(value), min: String(min), max: String(max), step: String(step), style: 'width:110px' });
  i.onchange = () => {
    const raw = Number(i.value) || 0;
    const v = Math.max(min, Math.min(max, step < 1 ? raw : Math.round(raw)));
    i.value = String(v);
    set(v);
  };
  return i;
}

function check(value: boolean, set: (v: boolean) => void): HTMLInputElement {
  const cb = h('input', { type: 'checkbox', checked: value, style: 'width:auto' });
  cb.onchange = () => set(cb.checked);
  return cb;
}

export function newEnipAdapter(device: Device, inByte: number, outByte: number): EnipModule {
  const n = device.io.filter((x) => x.kind === 'enip-adapter').length + 1;
  return {
    kind: 'enip-adapter', name: `EIP_${n}`, host: `192.168.0.${150 + n}`, rpiMs: 10,
    configInstance: 1, outInstance: 150, inInstance: 100, outLength: 4, outByte, inLength: 4, inByte,
  };
}

function pickConnection(connections: EdsConnection[]): Promise<EdsConnection | null> {
  if (connections.length <= 1) return Promise.resolve(connections[0] ?? null);
  return new Promise((resolve) => {
    let result: EdsConnection | null = null;
    openDialog('Connexion EtherNet/IP', (d) => {
      const sel = h('select', { size: Math.min(8, connections.length), style: 'width:100%' },
        ...connections.map((c, i) => h('option', { value: String(i), selected: i === 0 },
          `${c.name} — sorties ${c.outSize} o, entrées ${c.inSize} o (assemblages ${c.outInstance} / ${c.inInstance})`)));
      d.body.append(h('div', { style: 'width:560px' }, h('p', null, 'Connexions décrites par le fichier EDS :'), sel,
        h('p', { className: 'muted' }, '« Exclusive Owner » : la CPU commande les sorties ; « Input Only » / « Listen Only » : lecture seule.')));
      d.foot.append(button('OK', () => { result = connections[Number(sel.value)] ?? null; d.close(); }, true), button('Annuler', () => d.close()));
    }, { onClose: () => resolve(result) });
  });
}

export async function addEdsDevice(device: Device, nextIn: number, nextOut: number): Promise<EnipModule | null> {
  const [file] = await host.openFiles('eds');
  if (!file) return null;
  try {
    const eds = parseEds(new TextDecoder('latin1').decode(file.bytes));
    const usable = eds.connections.filter((c) => c.inInstance || c.outInstance);
    if (!usable.length) throw new Error('Le fichier EDS ne décrit aucune connexion d\'E/S (section [Connection Manager]).');
    const owner = [...usable].sort((a, b) => (a.type === 'exclusive-owner' ? 0 : 1) - (b.type === 'exclusive-owner' ? 0 : 1));
    const c = await pickConnection(owner);
    if (!c) return null;
    const m = newEnipAdapter(device, nextIn, nextOut);
    Object.assign(m, {
      name: `EIP_${device.io.filter((x) => x.kind === 'enip-adapter').length + 1}`,
      rpiMs: c.rpiMs ?? 10,
      configInstance: c.configInstance, outInstance: c.outInstance, inInstance: c.inInstance,
      outLength: c.outSize, inLength: c.inSize,
      outHeader: c.outHeader, inHeader: c.inHeader,
      multicast: !c.pointToPoint && c.multicast,
      vendorId: eds.vendorId, deviceType: eds.deviceType, productCode: eds.productCode, revision: eds.revision,
      catalog: { file: file.name, vendor: eds.vendorName, product: eds.productName || eds.catalog, connection: c.name },
    } satisfies Partial<EnipModule>);
    store.addMessage({ severity: 'ok', path: `${device.name} > ${m.name}`,
      text: `EDS « ${file.name} » : ${eds.vendorName} ${eds.productName}, connexion « ${c.name} » (sorties ${c.outSize} o, entrées ${c.inSize} o).` });
    return m;
  } catch (e) {
    await alertDialog('EDS', (e as Error).message, 'error');
    return null;
  }
}

/** Searches the network (ListIdentity from this computer) and adds the chosen devices */
export function discoverEnipDevices(device: Device, nextIn: () => number, nextOut: () => number): Promise<EnipModule[]> {
  return new Promise((resolve) => {
    const result: EnipModule[] = [];
    openDialog('Appareils EtherNet/IP du réseau', (d) => {
      const status = h('p', { className: 'muted' }, 'Recherche en cours (ListIdentity)…');
      const table = h('table', { className: 'grid', style: 'width:100%' });
      d.body.append(h('div', { style: 'width:720px' }, status, table,
        h('p', { className: 'muted' }, 'Recherche depuis ce poste : l\'appareil doit être sur un réseau accessible. Les assemblages (instances, tailles) viennent ensuite de la documentation ou du fichier EDS.')));
      const picks: Array<{ cb: HTMLInputElement; id: Awaited<ReturnType<typeof call<'enipDiscover'>>>[number] }> = [];
      void call('enipDiscover', 1500).then((found) => {
        status.textContent = found.length ? `${found.length} appareil(s) trouvé(s).` : 'Aucun appareil n\'a répondu.';
        table.append(h('tr', null, h('th', null, ''), h('th', null, 'Adresse IP'), h('th', null, 'Produit'), h('th', null, 'Fabricant'), h('th', null, 'Code produit'), h('th', null, 'Révision'), h('th', null, 'N° de série')));
        for (const id of found) {
          const known = device.io.some((m) => m.kind === 'enip-adapter' && m.host === id.address);
          const cb = h('input', { type: 'checkbox', checked: !known, disabled: known, style: 'width:auto' });
          picks.push({ cb, id });
          table.append(h('tr', null, h('td', null, cb), h('td', { className: 'mono' }, id.address), h('td', null, id.productName, known ? ' (déjà configuré)' : ''),
            h('td', null, String(id.vendorId)), h('td', null, String(id.productCode)), h('td', null, `${id.revision.major}.${id.revision.minor}`),
            h('td', { className: 'mono' }, id.serial.toString(16).toUpperCase().padStart(8, '0'))));
        }
      }).catch((e) => { status.textContent = `Recherche impossible : ${(e as Error).message}`; });
      d.foot.append(button('Ajouter', () => {
        for (const { cb, id } of picks) {
          if (!cb.checked) continue;
          const m = newEnipAdapter(device, nextIn(), nextOut());
          Object.assign(m, {
            host: id.address, vendorId: id.vendorId, deviceType: id.deviceType, productCode: id.productCode, revision: id.revision,
            catalog: { file: 'ListIdentity', vendor: `fabricant ${id.vendorId}`, product: id.productName },
          } satisfies Partial<EnipModule>);
          device.io.push(m);
          result.push(m);
        }
        d.close();
      }, true), button('Annuler', () => d.close()));
    }, { onClose: () => resolve(result) });
  });
}

const hex = (bytes: number[] | undefined) => (bytes ?? []).map((b) => b.toString(16).padStart(2, '0')).join(' ');

export function enipProps(m: EnipModule, touch: () => void, rerender: () => void): HTMLElement[] {
  const c = m.catalog;
  const cfg = h('input', { value: hex(m.configData), placeholder: '(aucune)', className: 'mono' });
  cfg.onchange = () => {
    const tokens = cfg.value.trim().split(/[\s,]+/).filter(Boolean);
    if (tokens.some((t) => !/^(0x)?[0-9a-f]{1,2}$/i.test(t))) {
      void alertDialog('Données de configuration', 'Octets en hexadécimal séparés par des espaces (ex. 01 00 FF).', 'error');
      cfg.value = hex(m.configData);
      return;
    }
    const bytes = tokens.map((t) => parseInt(t.replace(/^0x/i, ''), 16));
    m.configData = bytes.length ? bytes : undefined;
    touch();
  };
  const range = (area: string, byte: number, len: number) => (len ? `%${area}${byte}…%${area}${byte + len - 1}` : '—');
  const key = m.vendorId !== undefined && m.vendorId !== 0;
  return [
    h('p', { className: 'muted', style: 'margin:4px 0;line-height:1.45' },
      `Adaptateur EtherNet/IP piloté par cette CPU (scanner)${c ? ` — ${c.vendor} ${c.product}${c.connection ? `, connexion « ${c.connection} »` : ''} (${c.file})` : ''}. `
      + 'La CPU ouvre la connexion (Forward_Open) puis échange les assemblages d\'entrée et de sortie à chaque RPI (UDP 2222).'),
    sub('Réseau'),
    field('Adresse IP', (() => { const i = h('input', { value: m.host }); i.onchange = () => { m.host = i.value.trim(); touch(); rerender(); }; return i; })(), 'Adresse de l\'appareil (ou nom DNS)'),
    field('RPI (ms)', num(m.rpiMs ?? 10, (v) => { m.rpiMs = v; touch(); }, 0.5, 10000, 0.5), 'Intervalle de rafraîchissement des données'),
    field('Multiplicateur de temporisation', (() => {
      const sel = h('select', null, ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => h('option', { value: String(k) }, `× ${4 << k}`)));
      sel.value = String(m.timeoutMultiplier ?? 1);
      sel.onchange = () => { m.timeoutMultiplier = Number(sel.value); touch(); };
      return sel;
    })(), 'Connexion perdue après RPI × multiplicateur sans données'),
    field('Entrées en multidiffusion', check(!!m.multicast, (v) => { m.multicast = v || undefined; touch(); }), 'Sinon point à point'),
    sub('Assemblages'),
    field('Configuration (instance)', num(m.configInstance, (v) => { m.configInstance = v; touch(); }, 0, 65535)),
    field('Sorties O→T (instance)', num(m.outInstance, (v) => { m.outInstance = v; touch(); }, 0, 65535)),
    field('Entrées T→O (instance)', num(m.inInstance, (v) => { m.inInstance = v; touch(); }, 0, 65535)),
    field('Taille des sorties (octets)', num(m.outLength, (v) => { m.outLength = v; touch(); rerender(); }, 0, 500), `→ ${range('Q', m.outByte, m.outLength)}`),
    field('Adresse des sorties', num(m.outByte, (v) => { m.outByte = v; touch(); rerender(); }), 'Premier octet %Q'),
    field('Taille des entrées (octets)', num(m.inLength, (v) => { m.inLength = v; touch(); rerender(); }, 0, 500), `→ ${range('I', m.inByte, m.inLength)}`),
    field('Adresse des entrées', num(m.inByte, (v) => { m.inByte = v; touch(); rerender(); }), 'Premier octet %I'),
    field('En-tête run/idle (sorties)', check(m.outHeader ?? true, (v) => { m.outHeader = v; touch(); }), 'Format « 32-bit header » O→T (le plus courant)'),
    field('En-tête run/idle (entrées)', check(!!m.inHeader, (v) => { m.inHeader = v || undefined; touch(); })),
    field('Données de configuration', cfg, 'Envoyées avec l\'ouverture de connexion (octets hexadécimaux)'),
    sub('Clé électronique'),
    h('p', { className: 'muted', style: 'margin:4px 0' }, key
      ? `Contrôlée par l'appareil : fabricant ${m.vendorId}, type ${m.deviceType ?? 0}, produit ${m.productCode ?? 0}, révision ${m.revision?.major ?? 0}.${m.revision?.minor ?? 0} ou compatible.`
      : 'Aucune (tout appareil répondant à cette adresse est accepté). Importez le fichier EDS pour la définir.'),
    ...(key ? [field('Contrôler la clé', check(true, (v) => { if (!v) { m.vendorId = undefined; touch(); rerender(); } }))] : []),
    h('p', { className: 'muted', style: 'margin:8px 0 0' },
      'Les données EtherNet/IP sont en little-endian : utilisez SWAP() pour lire un Int / DInt de l\'appareil (ex. Valeur := SWAP(%IW10)).'),
  ];
}
