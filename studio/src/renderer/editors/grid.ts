// Editable table (tag tables, interfaces, watch tables).
import { clear, h, svg } from '../dom.ts';
import { icons, type IconName } from '../icons.ts';
import { t } from '../i18n.ts';
import { contextMenu } from '../ui/chrome.ts';

export interface Column<T> {
  title: string;
  width?: string;
  /** text input, select, read-only text, or monitored value */
  kind: 'text' | 'select' | 'readonly' | 'monitor' | 'check';
  get(row: T): string;
  set?(row: T, value: string): void;
  options?: string[] | (() => string[]);
  /** datalist suggestions for text inputs */
  suggestions?: () => Array<string | { value: string; label: string }>;
  /** returns an error message, or null when valid */
  validate?(value: string, row: T): string | null;
  className?: string | ((row: T) => string);
  mono?: boolean;
  /** value used when the row is created from the <Add> line */
  primary?: boolean;
}

export interface Section<T> {
  title?: string;
  icon?: IconName;
  rows: T[];
  create?(value: string): T;
  canAdd?: boolean;
}

export interface GridOptions<T> {
  columns: Column<T>[];
  sections: () => Section<T>[];
  onChange: () => void;
  numbered?: boolean;
  rowIcon?: (row: T) => IconName | null;
  onRowContext?: (row: T, section: Section<T>) => Array<{ label: string; run: () => void } | 'sep'>;
  onRowActivate?: (row: T) => void;
}

let listCounter = 0;

export class Grid<T> {
  readonly element: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly monitorCells = new Map<T, HTMLTableCellElement[]>();
  private selected: T | null = null;

  constructor(private readonly opts: GridOptions<T>) {
    this.table = h('table', { className: 'grid' });
    this.element = h('div', { className: 'grid-wrap' }, this.table);
    this.table.addEventListener('keydown', (e) => this.onKey(e));
    this.render();
  }

  /** Re-renders after the current DOM event (never while an input is being blurred). */
  private renderLater(then?: () => void): void {
    requestAnimationFrame(() => {
      this.render();
      then?.();
    });
  }

  render(): void {
    const focused = document.activeElement as HTMLElement | null;
    const focusKey = focused && this.table.contains(focused) ? focused.dataset.cell : undefined;
    clear(this.table);
    this.monitorCells.clear();
    const { columns, numbered } = this.opts;
    const head = h('tr');
    if (numbered) head.append(h('th', { style: 'width:34px' }));
    head.append(h('th', { style: 'width:26px' }));
    for (const c of columns) head.append(h('th', { style: c.width ? `width:${c.width}` : undefined, className: c.kind === 'monitor' ? 'monitor' : undefined }, c.title));
    this.table.append(h('thead', null, head));

    const tbody = h('tbody');
    let n = 1;
    this.opts.sections().forEach((section, si) => {
      if (section.title !== undefined) {
        tbody.append(h('tr', { className: 'section' },
          h('td', { colSpan: String(columns.length + 1 + (numbered ? 1 : 0)) }, section.icon ? svg(icons[section.icon]) : null, section.title)));
      }
      section.rows.forEach((row, ri) => {
        tbody.append(this.row(row, section, `${si}:${ri}`, numbered ? n++ : 0));
      });
      if (section.canAdd !== false && section.create) tbody.append(this.addRow(section, `${si}:add`, numbered ? n : 0));
    });
    this.table.append(tbody);
    if (focusKey) (this.table.querySelector(`[data-cell="${CSS.escape(focusKey)}"]`) as HTMLElement | null)?.focus();
  }

  private row(row: T, section: Section<T>, key: string, n: number): HTMLTableRowElement {
    const tr = h('tr', {
      className: this.selected === row ? 'selected' : '',
      onmousedown: () => {
        this.selected = row;
        this.table.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
        tr.classList.add('selected');
      },
      ondblclick: () => this.opts.onRowActivate?.(row),
      oncontextmenu: (e: Event) => {
        const extra = this.opts.onRowContext?.(row, section) ?? [];
        contextMenu(e as MouseEvent, [
          ...extra,
          ...(extra.length ? ['sep' as const] : []),
          { label: 'Insérer une ligne', icon: 'add', run: () => this.insertBefore(row, section), enabled: () => !!section.create },
          { label: t.delete, icon: 'del', run: () => this.remove(row, section) },
        ]);
      },
    });
    if (this.opts.numbered) tr.append(h('td', { className: 'num' }, String(n)));
    const icon = this.opts.rowIcon?.(row);
    tr.append(h('td', { className: 'icon-cell' }, icon ? svg(icons[icon]) : ''));
    const monitors: HTMLTableCellElement[] = [];
    this.opts.columns.forEach((c, ci) => {
      const cls = typeof c.className === 'function' ? c.className(row) : c.className ?? '';
      if (c.kind === 'readonly') {
        tr.append(h('td', { className: `${cls}${c.mono ? ' mono' : ''}`, title: c.get(row) }, c.get(row)));
        return;
      }
      if (c.kind === 'monitor') {
        const td = h('td', { className: `monitor value ${cls}` });
        monitors.push(td);
        tr.append(td);
        return;
      }
      tr.append(h('td', { className: 'edit' }, this.input(c, row, `${key}:${ci}`)));
    });
    this.monitorCells.set(row, monitors);
    return tr;
  }

  private input(c: Column<T>, row: T, cellKey: string): HTMLElement {
    if (c.kind === 'select') {
      const opts = typeof c.options === 'function' ? c.options() : c.options ?? [];
      const sel = h('select', { 'data-cell': cellKey }, ...opts.map((o) => h('option', { value: o }, o)));
      sel.value = c.get(row);
      sel.onchange = () => {
        c.set?.(row, sel.value);
        this.opts.onChange();
      };
      return sel;
    }
    if (c.kind === 'check') {
      const cb = h('input', { type: 'checkbox', 'data-cell': cellKey, checked: c.get(row) === 'true' });
      cb.onchange = () => {
        c.set?.(row, String(cb.checked));
        this.opts.onChange();
      };
      return cb;
    }
    const input = h('input', { value: c.get(row), spellcheck: 'false', 'data-cell': cellKey, className: c.mono ? 'mono' : '' });
    if (c.suggestions) {
      const id = `dl-${++listCounter}`;
      input.setAttribute('list', id);
      input.addEventListener('focus', () => {
        document.getElementById(id)?.remove();
        document.body.append(h('datalist', { id }, ...c.suggestions!().map((s) => (typeof s === 'string'
          ? h('option', { value: s })
          : h('option', { value: s.value, label: s.label })))));
      }, { once: false });
    }
    const commit = () => {
      if (input.value === c.get(row)) return;
      const error = c.validate?.(input.value, row) ?? null;
      input.classList.toggle('invalid', !!error);
      input.title = error ?? '';
      c.set?.(row, input.value);
      this.opts.onChange();
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        commit();
        this.moveFocus(input, 1);
      } else if (e.key === 'Escape') {
        input.value = c.get(row);
        input.blur();
      }
    });
    const error = c.validate?.(c.get(row), row);
    if (error) {
      input.classList.add('invalid');
      input.title = error;
    }
    return input;
  }

  private addRow(section: Section<T>, key: string, n: number): HTMLTableRowElement {
    const tr = h('tr', { className: 'add' });
    if (this.opts.numbered) tr.append(h('td', { className: 'num' }, String(n)));
    tr.append(h('td', { className: 'icon-cell' }));
    this.opts.columns.forEach((c, ci) => {
      if (c.primary) {
        const input = h('input', { placeholder: t.addNew, 'data-cell': `${key}:${ci}`, spellcheck: 'false', className: c.mono ? 'mono' : '' });
        const create = () => {
          const v = input.value.trim();
          if (!v) return;
          input.value = ''; // the blur that follows must not create the row twice
          section.rows.push(section.create!(v));
          this.opts.onChange();
          this.renderLater(() => {
            // focus the next cell of the new row
            const cells = [...this.table.querySelectorAll<HTMLElement>(`[data-cell^="${key.split(':')[0]}:${section.rows.length - 1}:"]`)];
            cells[1]?.focus();
          });
        };
        input.addEventListener('change', create);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
        tr.append(h('td', { className: 'edit' }, input));
      } else {
        tr.append(h('td'));
      }
    });
    return tr;
  }

  private insertBefore(row: T, section: Section<T>): void {
    const i = section.rows.indexOf(row);
    let k = 1;
    const name = () => `Tag_${k}`;
    while (section.rows.some((r) => this.opts.columns.find((c) => c.primary)?.get(r) === name())) k++;
    section.rows.splice(i, 0, section.create!(name()));
    this.opts.onChange();
    this.renderLater();
  }

  private remove(row: T, section: Section<T>): void {
    const i = section.rows.indexOf(row);
    if (i < 0) return;
    section.rows.splice(i, 1);
    if (this.selected === row) this.selected = null;
    this.opts.onChange();
    this.renderLater();
  }

  private moveFocus(from: HTMLElement, dRow: number): void {
    const cells = [...this.table.querySelectorAll<HTMLElement>('[data-cell]')];
    const [s, r, c] = (from.dataset.cell ?? '').split(':');
    const sameCol = cells.filter((x) => x.dataset.cell!.endsWith(`:${c}`));
    const i = sameCol.findIndex((x) => x.dataset.cell === `${s}:${r}:${c}`);
    sameCol[Math.max(0, Math.min(sameCol.length - 1, i + dRow))]?.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (target.tagName === 'SELECT' || target.getAttribute('list')) return;
      e.preventDefault();
      this.moveFocus(target, e.key === 'ArrowDown' ? 1 : -1);
    }
    if (e.key === 'Delete' && e.ctrlKey && this.selected) {
      for (const s of this.opts.sections()) {
        if (s.rows.includes(this.selected)) {
          this.remove(this.selected, s);
          break;
        }
      }
    }
  }

  /** Updates the monitor columns of a row: values in column order. */
  setMonitor(row: T, values: Array<{ text: string; cls?: string } | null>): void {
    const cells = this.monitorCells.get(row);
    if (!cells) return;
    values.forEach((v, i) => {
      const td = cells[i];
      if (!td) return;
      td.textContent = v?.text ?? '';
      td.className = `monitor value ${v?.cls ?? ''}`;
    });
  }

  clearMonitor(): void {
    for (const cells of this.monitorCells.values()) {
      for (const td of cells) {
        td.textContent = '';
        td.className = 'monitor value';
      }
    }
  }
}

export const DATA_TYPES = [
  'Bool', 'Byte', 'Word', 'DWord', 'LWord', 'SInt', 'Int', 'DInt', 'LInt', 'USInt', 'UInt', 'UDInt', 'ULInt', 'Real', 'LReal',
  'Time', 'LTime', 'Date', 'Time_Of_Day', 'LTime_Of_Day', 'Date_And_Time', 'LDT', 'DTL', 'Char', 'WChar', 'String', 'WString',
  'Array[0..9] of Int', 'Array[0..9] of Bool', 'Array[0..9] of Real',
];
export const FB_TYPES = ['TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG'];

export function valueClass(text: string | undefined): string {
  return text === 'TRUE' ? 'true' : text === 'FALSE' ? 'false' : '';
}
