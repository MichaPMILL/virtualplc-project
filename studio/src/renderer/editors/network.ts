// "Vue du réseau": the CPUs of the project, how the Studio reaches them, and the devices each
// CPU talks to on the network (Modbus TCP I/O, IO-Link masters, PROFINET devices).
import { DEVICE_TYPES, isSerialPort, isSimulatorHost, type Device, type IoModuleConfig } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { store } from '../store.ts';
import type { EditorView } from './types.ts';

function peer(m: IoModuleConfig): { title: string; kind: string; address: string } | null {
  switch (m.kind) {
    case 'modbus-tcp': return { title: m.name, kind: 'E/S Modbus TCP', address: `${m.host}:${m.port ?? 502}` };
    case 'iolink-master': return { title: m.name, kind: 'Maître IO-Link', address: `${m.host}:${m.port ?? 502}` };
    case 'profinet-remote': return { title: m.stationName, kind: 'IO-Device PROFINET', address: `${m.ip} (${m.interface})` };
    case 'profinet-device': return { title: 'Automate maître', kind: `IO-Controller PROFINET → ${m.stationName}`, address: m.interface };
    default: return null;
  }
}

export function networkEditor(): EditorView {
  const body = h('div', { className: 'net-view' });

  const render = () => {
    clear(body);
    const project = store.project;
    if (!project) return;
    const bus = h('div', { className: 'net-bus' }, h('span', null, 'Ethernet / Wi-Fi'));
    const cpus = h('div', { className: 'net-row' });
    const usb = h('div', { className: 'net-row' });
    for (const d of project.devices) {
      const online = store.onlineOf(d.id);
      const sim = store.simulation.has(d.id);
      const serial = isSerialPort(d.connection.host);
      const card = h('div', {
        className: `net-card cpu${online.connected ? ' online' : ''}`,
        title: 'Double-clic : configuration des appareils',
        ondblclick: () => A.openEditor({ kind: 'device', deviceId: d.id }),
      },
      h('div', { className: 'net-title' }, svg(icons.cpu), ` ${d.name}`),
      h('div', { className: 'muted' }, DEVICE_TYPES[d.type].label),
      h('div', { className: 'mono' }, sim ? 'CPU simulée (Studio)' : serial ? `USB ${d.connection.host} — ${d.connection.port} bauds` : `${d.connection.host}:${d.connection.port}`),
      online.connected ? h('div', { className: 'net-state' }, `En ligne — ${online.state ?? ''}`) : null,
      h('div', { className: 'net-peers' }, ...d.io.map(peer).filter((p) => p !== null).map((p) => h('div', { className: 'net-card peer' },
        h('div', { className: 'net-title' }, svg(icons.device), ` ${p!.title}`), h('div', { className: 'muted' }, p!.kind), h('div', { className: 'mono' }, p!.address)))),
      d.io.some((m) => m.kind.startsWith('gpio'))
        ? h('div', { className: 'muted', style: 'margin-top:4px' }, `${d.io.filter((m) => m.kind.startsWith('gpio')).length} E/S GPIO locales`) : null);
      (serial ? usb : cpus).append(card);
    }
    const pc = h('div', { className: 'net-card pc' }, h('div', { className: 'net-title' }, svg(icons.project), ' VirtualPLC Studio'), h('div', { className: 'muted' }, 'Ce poste'));
    body.append(
      h('div', { className: 'muted', style: 'margin-bottom:10px' }, 'Vue du réseau — les CPU du projet, leur liaison avec le Studio et les appareils qu\'elles pilotent. Double-cliquez sur une CPU pour ouvrir sa configuration ; les adresses se règlent dans ses propriétés et ses modules.'),
      h('div', { className: 'net-row' }, pc),
      bus,
      cpus,
    );
    if (usb.childElementCount) body.append(h('div', { className: 'net-bus usb' }, h('span', null, 'USB / liaison série')), usb);
  };
  const unsubscribe = store.on((topic) => { if (topic === 'project' || topic === 'online') render(); });
  render();
  return {
    element: h('div', { className: 'editor-host' },
      h('div', { className: 'panel-toolbar' },
        h('button', { className: 'tbtn', title: 'Ajouter un appareil', onclick: () => A.addDeviceCmd() }, svg(icons.add), ' Ajouter un appareil')),
      body),
    icon: 'network', title: () => 'Vue du réseau', crumbs: () => [store.project?.name ?? '', 'Appareils & Réseaux'],
    refresh: render, destroy: unsubscribe,
  };
}
