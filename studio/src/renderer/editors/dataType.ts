// PLC data type (UDT) editor ("Types de données API").
import type { DataTypeDef, Device, Member } from '../../../../sdk/src/browser.ts';
import { h } from '../dom.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import { typeSuggestions } from './block.ts';
import { Grid } from './grid.ts';
import type { EditorView } from './types.ts';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every member list of the type: its own members, then those of each nested Struct. */
function structLists(members: Member[], path: string, out: Array<{ path: string; members: Member[] }> = []) {
  out.push({ path, members });
  for (const m of members) {
    if (/^struct$/i.test(m.dataType.trim())) structLists((m.members ??= []), path ? `${path}.${m.name}` : m.name, out);
  }
  return out;
}

export function dataTypeEditor(device: Device, type: DataTypeDef): EditorView {
  const grid = new Grid<Member>({
    numbered: true,
    rowIcon: (r) => (/^struct$/i.test(r.dataType) ? 'folder' : 'tagTable'),
    columns: [
      {
        title: t.name, width: '26%', kind: 'text', primary: true, get: (r) => r.name, set: (r, v) => { r.name = v.trim(); },
        validate: (v) => (NAME_RE.test(v.trim()) ? null : 'Nom invalide (lettres, chiffres et _)'),
      },
      {
        title: t.dataType, width: '20%', kind: 'text', get: (r) => r.dataType,
        set: (r, v) => {
          r.dataType = v.trim();
          if (/^struct$/i.test(r.dataType)) r.members ??= [];
          else delete r.members;
          grid.render();
        },
        suggestions: () => typeSuggestions(device, false).filter((x) => x !== `"${type.name}"`),
      },
      { title: t.defaultValue, width: '16%', kind: 'text', mono: true, get: (r) => r.defaultValue ?? '', set: (r, v) => { r.defaultValue = v.trim() || undefined; } },
      { title: t.comment, kind: 'text', get: (r) => r.comment ?? '', set: (r, v) => { r.comment = v || undefined; } },
    ],
    sections: () => structLists(type.members, '').map((l) => ({
      title: l.path ? `${l.path} : Struct` : `"${type.name}"`,
      icon: 'folder' as const,
      rows: l.members,
      create: (name: string) => ({ name, dataType: 'Bool' }),
    })),
    onChange: () => store.touch(),
  });
  const comment = h('input', { value: type.comment ?? '', placeholder: 'Commentaire du type de données', style: 'flex:1;height:22px' });
  comment.onchange = () => {
    type.comment = comment.value || undefined;
    store.touch();
  };
  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'panel-toolbar' }, comment),
    h('div', { className: 'muted', style: 'padding:4px 10px' },
      'Type de données API (UDT) : utilisable comme type de variable (ex. "' + type.name + '"), dans les DB, les interfaces de blocs et d\'autres types. '
      + 'Saisissez « Struct » comme type de données pour créer une structure imbriquée.'),
    grid.element);
  return {
    element, icon: 'dataType', title: () => `${type.name}`, crumbs: () => [device.name, t.dataTypes, type.name],
    refresh: () => grid.render(),
  };
}
