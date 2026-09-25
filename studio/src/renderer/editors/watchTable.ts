// "Table de visualisation et de forçage" (watch & modify / force table).
import { findSymbol, type Device, type WatchRow, type WatchTable } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import { Grid, valueClass } from './grid.ts';
import type { EditorView } from './types.ts';

function pathOf(row: WatchRow): string {
  const n = row.name.trim();
  if (/^%/.test(n) || n.startsWith('"')) return n;
  // Tag.member -> "Tag".member
  const [first, ...rest] = n.split('.');
  return [`"${first}"`, ...rest].join('.');
}

export function watchTableEditor(device: Device, table: WatchTable): EditorView {
  const symbols = () => store.symbols(device.id);
  const suggestions = () => {
    const out: string[] = [];
    const walk = (nodes: ReturnType<typeof symbols>, prefix: string, depth: number) => {
      for (const s of nodes) {
        if (s.name.startsWith('[')) continue;
        const p = prefix ? `${prefix}.${s.name}` : `"${s.name}"`;
        out.push(p);
        if (s.children && depth < 2) walk(s.children, p, depth + 1);
      }
    };
    walk(symbols(), '', 0);
    return out;
  };
  const addressOf = (row: WatchRow) => {
    const path = pathOf(row);
    if (path.startsWith('%')) return path;
    const s = findSymbol(symbols(), path);
    if (!s) return '';
    if (s.area === 'D') return '';
    return s.bit !== undefined ? `%${s.area}${s.offset}.${s.bit}` : `%${s.area}${s.size === 1 ? 'B' : s.size === 2 ? 'W' : 'D'}${s.offset}`;
  };

  const grid = new Grid<WatchRow>({
    numbered: true,
    rowIcon: () => 'watch',
    columns: [
      { title: t.name, width: '24%', kind: 'text', primary: true, get: (r) => r.name, set: (r, v) => { r.name = v.trim(); }, suggestions },
      { title: t.address, width: '9%', kind: 'readonly', mono: true, get: addressOf },
      { title: t.displayFormat, width: '11%', kind: 'select', options: ['auto', 'bool', 'dec', 'hex', 'float', 'time', 'string'], get: (r) => r.format ?? 'auto', set: (r, v) => { r.format = v as WatchRow['format']; } },
      { title: t.monitorValue, width: '14%', kind: 'monitor', get: () => '' },
      { title: t.modifyValue, width: '12%', kind: 'text', mono: true, get: (r) => r.modifyValue ?? '', set: (r, v) => { r.modifyValue = v.trim(); } },
      { title: t.comment, kind: 'text', get: (r) => r.comment ?? '', set: (r, v) => { r.comment = v; } },
    ],
    sections: () => [{ rows: table.rows, create: (name) => ({ name }) }],
    onChange: () => store.touch(),
    onRowContext: (row) => [
      { label: 'Forcer > Forcer immédiatement', icon: 'modify', run: () => void modifyRows([row]) },
      { label: 'Forçage permanent > Forcer à la valeur', icon: 'force', run: () => void forceRow(row, true) },
      { label: 'Forçage permanent > Arrêter le forçage', run: () => void forceRow(row, false) },
      { label: 'Forcer à 1', run: () => void A.modifyValue(device.id, pathOf(row), 'TRUE') },
      { label: 'Forcer à 0', run: () => void A.modifyValue(device.id, pathOf(row), 'FALSE') },
    ],
  });

  const needOnline = async () => {
    if (store.onlineOf(device.id).connected) return true;
    await A.goOnlineCmd(device);
    return store.onlineOf(device.id).connected;
  };
  const modifyRows = async (rows: WatchRow[]) => {
    if (!(await needOnline())) return;
    for (const r of rows) if (r.modifyValue) await A.modifyValue(device.id, pathOf(r), r.modifyValue);
  };
  const forceRow = async (row: WatchRow, on: boolean) => {
    if (!(await needOnline())) return;
    const v = (row.modifyValue ?? '').trim().toUpperCase();
    await A.forceValue(device.id, pathOf(row), on ? v === 'TRUE' || v === '1' : null);
  };

  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'panel-toolbar' },
      h('button', { className: 'tbtn', title: t.monitorAll, onclick: () => void A.toggleMonitorCmd() }, svg(icons.glasses)),
      h('button', { className: 'tbtn', title: 'Forcer immédiatement toutes les valeurs sélectionnées', onclick: () => void modifyRows(table.rows) }, svg(icons.modify), h('span', { className: 'label' }, 'Forcer immédiatement')),
      h('span', { className: 'sep' }),
      h('button', { className: 'tbtn', title: 'Arrêter tous les forçages permanents', onclick: async () => { if (await needOnline()) await A.call_unforce(device.id); } }, svg(icons.force), h('span', { className: 'label' }, 'Arrêter le forçage')),
    ),
    grid.element);

  const format = (row: WatchRow, value: unknown, text?: string): string => {
    const f = row.format ?? 'auto';
    if (typeof value === 'number') {
      if (f === 'hex') return `16#${(value >>> 0).toString(16).toUpperCase()}`;
      if (f === 'dec') return String(Math.trunc(value));
    }
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return text ?? String(value ?? '');
  };

  return {
    element,
    icon: 'watch',
    title: () => table.name,
    crumbs: () => [device.name, t.watchTables, table.name],
    refresh: () => grid.render(),
    monitor: {
      deviceId: device.id,
      paths: () => table.rows.filter((r) => r.name.trim()).map(pathOf),
      apply: (values) => {
        const rows = table.rows.filter((r) => r.name.trim());
        values.forEach((v, i) => {
          const row = rows[i];
          if (!row) return;
          // errors in clear: unknown operand, program not compiled or not loaded in the CPU…
          const text = !v.error ? format(row, v.value, v.text)
            : v.error === 'unknown' ? 'Opérande inconnu'
              : v.error === 'not compiled' ? 'Non compilé'
                : /no program loaded/.test(v.error) ? 'Pas de programme dans la CPU' : '#';
          grid.setMonitor(row, [{ text, cls: v.error ? 'bad' : valueClass(v.text), title: v.error && text === '#' ? A.cpuMessage(v.error) : undefined }]);
        });
      },
    },
    monitorStopped: () => grid.clearMonitor(),
  };
}
