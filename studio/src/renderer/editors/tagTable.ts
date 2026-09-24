// PLC tag table editor ("Variables API").
import { parseAddress, type Device, type Tag, type TagTable, type UserConstant } from '../../../../sdk/src/browser.ts';
import { store } from '../store.ts';
import { clear, h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { t } from '../i18n.ts';
import * as A from '../actions.ts';
import { DATA_TYPES, Grid, valueClass } from './grid.ts';
import type { EditorView } from './types.ts';

const ADDRESS_HELP = 'Adresse absolue : %I0.0 (entrée), %Q0.0 (sortie), %M0.0 (mémento), %IW2, %QW4, %MW10, %MD20';

/** Next free address after the last tag of the same kind. */
export function suggestAddress(tags: Tag[], dataType: string): string {
  const size = /^bool$/i.test(dataType) ? 'X' : /^(byte|sint|usint)$/i.test(dataType) ? 'B' : /^(word|int|uint)$/i.test(dataType) ? 'W' : 'D';
  const last = [...tags].reverse().map((x) => parseAddress(x.address)).find((a) => a !== null);
  const area = last?.area ?? 'M';
  let used = 0;
  for (const tag of tags) {
    const a = parseAddress(tag.address);
    if (!a || a.area !== area) continue;
    const end = a.size === 'X' ? a.byte * 8 + a.bit + 1 : (a.byte + { B: 1, W: 2, D: 4 }[a.size]) * 8;
    used = Math.max(used, end);
  }
  if (size === 'X') return `%${area}${Math.floor(used / 8)}.${used % 8}`;
  const bytes = Math.ceil(used / 8);
  const align = size === 'B' ? 1 : 2;
  return `%${area}${size}${Math.ceil(bytes / align) * align}`;
}

export function validateAddress(value: string, dataType: string): string | null {
  if (!value.trim()) return null;
  const a = parseAddress(value);
  if (!a) return ADDRESS_HELP;
  const fits = a.size === 'X' ? /^bool$/i.test(dataType)
    : a.size === 'B' ? /^(byte|sint|usint)$/i.test(dataType)
      : a.size === 'W' ? /^(word|int|uint)$/i.test(dataType)
        : /^(dword|dint|udint|real|time)$/i.test(dataType);
  return fits ? null : `L'adresse ${value} ne convient pas au type ${dataType}`;
}

function nameValidator(all: () => Array<{ name: string }>) {
  return (value: string, row: { name: string }) => {
    if (!value.trim() || /["\r\n]/.test(value)) return 'Nom invalide';
    return all().some((x) => x !== row && x.name.toLowerCase() === value.trim().toLowerCase()) ? `Le nom « ${value} » existe déjà` : null;
  };
}

export function tagTableEditor(device: Device, table: TagTable | null): EditorView {
  const tables = () => (table ? [table] : device.tagTables);
  const allTags = () => device.tagTables.flatMap((x) => x.tags);
  let tab: 'tags' | 'constants' = 'tags';

  const tagGrid = new Grid<Tag & { _table?: string }>({
    numbered: true,
    rowIcon: () => 'tagTable',
    columns: [
      { title: t.name, width: '24%', kind: 'text', primary: true, get: (r) => r.name, set: (r, v) => { r.name = v.trim(); }, validate: nameValidator(allTags) },
      ...(table ? [] : [{ title: 'Table de variables', width: '16%', kind: 'readonly' as const, get: (r: Tag & { _table?: string }) => r._table ?? '' }]),
      { title: t.dataType, width: '13%', kind: 'text', get: (r) => r.dataType, set: (r, v) => { r.dataType = v.trim(); }, suggestions: () => DATA_TYPES.filter((x) => !x.startsWith('Array')) },
      { title: t.address, width: '11%', kind: 'text', mono: true, get: (r) => r.address, set: (r, v) => { r.address = v.trim().toUpperCase(); }, validate: (v, r) => validateAddress(v, r.dataType) },
      { title: t.comment, kind: 'text', get: (r) => r.comment ?? '', set: (r, v) => { r.comment = v; } },
      { title: t.monitorValue, width: '15%', kind: 'monitor', get: () => '' },
    ],
    sections: () => table
      ? [{ rows: table.tags, create: (name) => ({ name, dataType: 'Bool', address: suggestAddress(table.tags, 'Bool') }) }]
      : device.tagTables.map((tt) => ({ rows: tt.tags.map((x) => Object.assign(x, { _table: tt.name })), create: undefined, canAdd: false })),
    onChange: () => store.touch(),
  });

  const constGrid = new Grid<UserConstant>({
    numbered: true,
    rowIcon: () => 'tagTable',
    columns: [
      { title: t.name, width: '28%', kind: 'text', primary: true, get: (r) => r.name, set: (r, v) => { r.name = v.trim(); } },
      { title: t.dataType, width: '16%', kind: 'text', get: (r) => r.dataType, set: (r, v) => { r.dataType = v.trim(); }, suggestions: () => DATA_TYPES },
      { title: t.value, width: '16%', kind: 'text', mono: true, get: (r) => r.value, set: (r, v) => { r.value = v.trim(); } },
      { title: t.comment, kind: 'text', get: (r) => r.comment ?? '', set: (r, v) => { r.comment = v; } },
    ],
    sections: () => tables().map((tt) => ({ rows: tt.constants, create: table ? (name: string) => ({ name, dataType: 'Int', value: '0' }) : undefined, canAdd: !!table })),
    onChange: () => store.touch(),
  });

  const tabs = h('div', { className: 'subtabs' });
  const host = h('div', { style: 'flex:1;display:flex;flex-direction:column;min-height:0' });
  const renderTabs = () => {
    clear(tabs);
    for (const [k, label] of [['tags', t.tags], ['constants', t.userConstants]] as const) {
      tabs.append(h('div', { className: `tab${tab === k ? ' active' : ''}`, onclick: () => { tab = k; renderTabs(); } }, svg(icons.tagTable), label));
    }
    clear(host);
    host.append(tab === 'tags' ? tagGrid.element : constGrid.element);
  };
  renderTabs();

  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'panel-toolbar' },
      h('button', { className: 'tbtn', title: t.monitorAll, onclick: () => void A.toggleMonitorCmd() }, svg(icons.glasses)),
      h('span', { className: 'sep' }),
      h('span', { className: 'muted', style: 'padding-left:6px' }, ADDRESS_HELP)),
    tabs, host);

  return {
    element,
    icon: 'tagTable',
    title: () => (table ? table.name : t.showAllTags),
    crumbs: () => [device.name, t.plcTags, table ? `${table.name} [${table.tags.length}]` : t.showAllTags],
    refresh: () => {
      tagGrid.render();
      constGrid.render();
    },
    monitor: {
      deviceId: device.id,
      paths: () => (tab === 'tags' ? tables().flatMap((x) => x.tags).map((x) => `"${x.name}"`) : []),
      apply: (values) => {
        const rows = tables().flatMap((x) => x.tags);
        values.forEach((v, i) => {
          const row = rows[i];
          if (row) tagGrid.setMonitor(row, [{ text: v.error ? '#' : v.text ?? '', cls: v.error ? 'bad' : valueClass(v.text) }]);
        });
      },
    },
    monitorStopped: () => tagGrid.clearMonitor(),
  };
}
