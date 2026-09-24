// Simulation panel: sets the inputs of the simulated CPU and shows its outputs (simulation mode).
import { parseAddress, type Device, type Tag } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { call } from '../host.ts';
import { clear, h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { store } from '../store.ts';
import type { EditorView } from './types.ts';

interface IoTag {
  tag: Tag;
  path: string;
  area: 'I' | 'Q' | 'M';
  bit: boolean;
  byte: number;
}

function ioTags(device: Device): IoTag[] {
  const out: IoTag[] = [];
  for (const tt of device.tagTables) {
    for (const tag of tt.tags) {
      const a = tag.address.trim() ? parseAddress(tag.address) : null;
      if (!a) continue;
      out.push({ tag, path: `"${tag.name}"`, area: a.area, bit: a.size === 'X', byte: a.byte * 8 + a.bit });
    }
  }
  return out.sort((x, y) => x.byte - y.byte);
}

export function simulationEditor(device: Device): EditorView {
  const body = h('div', { className: 'sim-panel' });
  const status = h('span', { className: 'muted' });
  const values = new Map<string, string>();
  const cells = new Map<string, (text: string | undefined) => void>();
  let timer: number | undefined;
  let busy = false;
  // Writes are sent one after the other; a read started before a write is ignored (stale)
  let writes: Promise<void> = Promise.resolve();
  let generation = 0;

  const write = (io: IoTag, text: string): Promise<void> => {
    generation++;
    values.set(io.path, text);
    cells.get(io.path)?.(text);
    writes = writes.then(async () => {
      try {
        await call('write', device.id, io.path, text);
      } catch (e) {
        store.addMessage({ severity: 'error', text: `Simulation : ${io.tag.name} : ${(e as Error).message}`, path: device.name });
      }
      generation++;
    });
    return writes;
  };

  const render = () => {
    clear(body);
    cells.clear();
    const list = ioTags(device);
    const inputs = list.filter((x) => x.area === 'I');
    const outputs = list.filter((x) => x.area === 'Q');
    const inputRow = (io: IoTag) => {
      if (io.bit) {
        const sw = h('button', { className: 'sim-switch', title: 'Commutateur : un clic change l\'état' });
        const push = h('button', { className: 'sim-push', title: 'Bouton poussoir : TRUE tant qu\'il est appuyé' }, 'Impulsion');
        sw.onclick = () => void write(io, values.get(io.path) === 'TRUE' ? 'FALSE' : 'TRUE');
        let pressed = false;
        push.onmousedown = () => {
          pressed = true;
          void write(io, 'TRUE');
        };
        push.onmouseup = push.onmouseleave = () => {
          if (!pressed) return;
          pressed = false;
          void write(io, 'FALSE');
        };
        cells.set(io.path, (text) => {
          sw.classList.toggle('on', text === 'TRUE');
          sw.textContent = text === 'TRUE' ? '1' : '0';
        });
        return h('tr', null, h('td', null, io.tag.name), h('td', { className: 'mono' }, io.tag.address), h('td', null, sw, ' ', push), h('td', { className: 'muted' }, io.tag.comment ?? ''));
      }
      const input = h('input', { className: 'mono', style: 'width:110px' });
      input.onchange = () => void write(io, input.value.trim());
      cells.set(io.path, (text) => { if (document.activeElement !== input && text !== undefined) input.value = text; });
      return h('tr', null, h('td', null, io.tag.name), h('td', { className: 'mono' }, io.tag.address), h('td', null, input), h('td', { className: 'muted' }, io.tag.comment ?? ''));
    };
    const outputRow = (io: IoTag) => {
      const n = io.tag.name.toLowerCase();
      const color = /red|rouge/.test(n) ? ' red' : /green|vert/.test(n) ? ' green' : /amber|orange/.test(n) ? ' amber' : '';
      const cell = io.bit ? h('span', { className: `sim-lamp${color}` }) : h('span', { className: 'mono' });
      cells.set(io.path, (text) => {
        if (io.bit) cell.classList.toggle('on', text === 'TRUE');
        else cell.textContent = text ?? '';
      });
      return h('tr', null, h('td', null, io.tag.name), h('td', { className: 'mono' }, io.tag.address), h('td', null, cell), h('td', { className: 'muted' }, io.tag.comment ?? ''));
    };
    const table = (title: string, rows: HTMLElement[], empty: string) => h('div', { className: 'sim-block' },
      h('div', { className: 'panel-subheader' }, title),
      rows.length ? h('table', { className: 'grid' }, h('tr', null, h('th', null, 'Variable'), h('th', null, 'Adresse'), h('th', null, 'Valeur'), h('th', null, 'Commentaire')), ...rows)
        : h('div', { className: 'muted', style: 'padding:8px' }, empty));
    body.append(
      table('Entrées simulées (%I)', inputs.map(inputRow), 'Aucune variable API sur une entrée %I.'),
      table('Sorties (%Q)', outputs.map(outputRow), 'Aucune variable API sur une sortie %Q.'),
    );
    poll();
  };

  const poll = () => {
    if (busy || !store.onlineOf(device.id).connected) {
      status.textContent = store.onlineOf(device.id).connected ? '' : 'CPU simulée non connectée';
      return;
    }
    const paths = [...cells.keys()];
    if (!paths.length) return;
    busy = true;
    const started = generation;
    call('read', device.id, paths).then((list) => {
      if (started !== generation) return;   // a write happened meanwhile: wait for the next read
      for (const v of list) {
        if (v.text !== undefined) values.set(v.path, v.text);
        cells.get(v.path)?.(v.text);
      }
      const s = store.onlineOf(device.id);
      status.textContent = `CPU simulée : ${s.state ?? '?'}${s.scanUs !== undefined ? ` — cycle ${(s.scanUs / 1000).toFixed(2)} ms` : ''}`;
    }).catch(() => undefined).finally(() => { busy = false; });
  };

  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'panel-toolbar', style: 'gap:8px' },
      h('button', { className: 'tbtn', title: 'Charger le programme dans la CPU simulée', onclick: () => void A.downloadCmd(device) }, svg(icons.download), ' Charger'),
      h('button', { className: 'tbtn', title: 'RUN', onclick: () => void A.startCpuCmd(device) }, svg(icons.run)),
      h('button', { className: 'tbtn', title: 'STOP', onclick: () => void A.stopCpuCmd(device) }, svg(icons.stop)),
      h('span', { className: 'sep' }),
      h('button', { className: 'tbtn', title: 'Arrêter la simulation', onclick: () => void A.stopSimulationCmd(device) }, svg(icons.sim), ' Arrêter la simulation'),
      status),
    h('div', { className: 'muted', style: 'padding:4px 10px' },
      'La CPU simulée exécute le programme dans le Studio, en temps réel, comme la CPU réelle. Les entrées sont commandées ici '
      + '(commutateur ou bouton poussoir) ; la visualisation, les tables de visualisation et le forçage fonctionnent comme en ligne.'),
    body);
  return {
    element, icon: 'sim', title: () => `Simulation — ${device.name}`, crumbs: () => [device.name, 'Simulation'],
    shown: () => {
      render();
      timer ??= window.setInterval(poll, 200);
    },
    refresh: () => render(),
    destroy: () => window.clearInterval(timer),
  };
}
