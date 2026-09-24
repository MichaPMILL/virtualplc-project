// Modal dialogs.
import { DEVICE_TYPES, nextBlockNumber, type BlockType, type Device, type DeviceType } from '../../../../sdk/src/browser.ts';
import { clear, h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { t } from '../i18n.ts';

export interface DialogHandle {
  close(): void;
  body: HTMLElement;
  foot: HTMLElement;
}

export function openDialog(title: string, build: (d: DialogHandle) => void, opts: { width?: string; onClose?: () => void } = {}): DialogHandle {
  const body = h('div', { className: 'd-body' });
  const foot = h('div', { className: 'd-foot' });
  const overlay = h('div', { className: 'overlay' });
  const handle: DialogHandle = {
    body,
    foot,
    close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      opts.onClose?.();
    },
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      handle.close();
    }
  };
  const dialog = h('div', { className: 'dialog', role: 'dialog', 'aria-label': title, style: opts.width ? `width:${opts.width}` : undefined },
    h('div', { className: 'd-title' }, title, h('button', { className: 'tbtn x', title: t.close, onclick: () => handle.close() }, svg(icons.close))),
    body, foot);
  overlay.append(dialog);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  build(handle);
  setTimeout(() => (dialog.querySelector('input:not([type=checkbox]):not([disabled]), select, .button.primary') as HTMLElement | null)?.focus(), 0);
  return handle;
}

export function button(label: string, onclick: () => void, primary = false): HTMLButtonElement {
  return h('button', { className: `button${primary ? ' primary' : ''}`, onclick }, label);
}

export function alertDialog(title: string, message: string, kind: 'info' | 'error' | 'warning' = 'info'): Promise<void> {
  return new Promise((resolve) => {
    openDialog(title, (d) => {
      d.body.append(h('div', { style: 'display:flex;gap:12px;align-items:flex-start;max-width:520px;white-space:pre-wrap' }, svg(icons[kind]), message));
      d.foot.append(button(t.ok, () => d.close(), true));
    }, { onClose: resolve });
  });
}

export function confirmDialog(title: string, message: string, yes = t.yes, no = t.no): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    openDialog(title, (d) => {
      d.body.append(h('div', { style: 'display:flex;gap:12px;max-width:520px;white-space:pre-wrap' }, svg(icons.warning), message));
      d.foot.append(button(yes, () => { result = true; d.close(); }, true), button(no, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
}

export function promptDialog(title: string, label: string, value = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    openDialog(title, (d) => {
      const input = h('input', { value, style: 'width:100%' });
      const ok = () => { result = input.value.trim(); d.close(); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      d.body.append(h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, label), input));
      d.foot.append(button(t.ok, ok, true), button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
}

// ---------------------------------------------------------------------------
// Add new block ("Ajouter nouveau bloc")
// ---------------------------------------------------------------------------

export interface NewBlockSpec {
  type: BlockType;
  name: string;
  number: number;
  event?: 'ProgramCycle' | 'Startup';
  instanceOf?: string;
  returnType?: string;
}

export function addBlockDialog(device: Device, preset?: Partial<NewBlockSpec>): Promise<NewBlockSpec | null> {
  return new Promise((resolve) => {
    let result: NewBlockSpec | null = null;
    let type: BlockType = preset?.type ?? 'FB';
    const kinds: Array<[BlockType, string, string, string]> = [
      ['OB', t.organizationBlock, icons.ob, t.obDescription],
      ['FB', t.functionBlock, icons.fb, t.fbDescription],
      ['FC', t.function, icons.fc, t.fcDescription],
      ['DB', t.dataBlock, icons.db, t.dbDescription],
    ];
    openDialog(t.addBlock, (d) => {
      d.body.style.padding = '0';
      const kindsEl = h('div', { className: 'kinds' });
      const form = h('div', { className: 'form' });
      const name = h('input', { style: 'width:100%' });
      const number = h('input', { type: 'number', min: '1', max: '65535', style: 'width:90px' });
      const auto = h('input', { type: 'checkbox', checked: true });
      const extra = h('div');
      let extraValue = (): Partial<NewBlockSpec> => ({});

      const defaultName = (k: BlockType) => {
        const base = { OB: 'Cyclic interrupt', FB: 'Block', FC: 'Block', DB: 'Data_block' }[k];
        let n = 1;
        while (device.blocks.some((b) => b.name.toLowerCase() === `${base}_${n}`.toLowerCase())) n++;
        return `${base}_${n}`;
      };

      const render = () => {
        clear(kindsEl);
        for (const [k, label, icon] of kinds) {
          kindsEl.append(h('div', { className: `kind${k === type ? ' selected' : ''}`, onclick: () => { type = k; name.value = preset?.name ?? defaultName(k); render(); } },
            svg(icon), label));
        }
        const info = kinds.find((k) => k[0] === type)!;
        number.value = String(nextBlockNumber(device, type));
        number.disabled = auto.checked;
        clear(extra);
        if (type === 'OB') {
          const ev = h('select', null, h('option', { value: 'ProgramCycle' }, t.programCycle), h('option', { value: 'Startup' }, t.startup));
          ev.onchange = () => {
            if (ev.value === 'Startup' && /^Cyclic/.test(name.value)) name.value = 'Startup';
            number.value = ev.value === 'Startup' && !device.blocks.some((b) => b.type === 'OB' && b.number === 100) ? '100' : String(nextBlockNumber(device, 'OB'));
          };
          extra.append(h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, 'Événement'), ev));
          extraValue = () => ({ event: ev.value as NewBlockSpec['event'] });
        } else if (type === 'DB') {
          const kindSel = h('select', null, h('option', { value: '' }, t.globalDb),
            ...device.blocks.filter((b) => b.type === 'FB').map((b) => h('option', { value: b.name }, `${t.instanceDbOf} ${b.name} [FB${b.number}]`)),
            ...['TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG'].map((n) => h('option', { value: n }, `${t.instanceDbOf} ${n} (IEC)`)));
          if (preset?.instanceOf) kindSel.value = preset.instanceOf;
          extra.append(h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, t.type), kindSel));
          extraValue = () => ({ instanceOf: kindSel.value || undefined });
        } else if (type === 'FC') {
          const ret = h('input', { value: 'Void' });
          extra.append(h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, 'Type de retour'), ret));
          extraValue = () => ({ returnType: ret.value.trim() || 'Void' });
        }
        clear(form);
        form.append(
          h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, t.blockName), name),
          h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, t.language), h('select', { disabled: true }, h('option', null, 'SCL'))),
          h('div', { className: 'field', style: 'grid-template-columns:120px auto auto 1fr' }, h('label', null, t.number), number,
            h('label', { style: 'display:flex;gap:4px;align-items:center' }, auto, t.automatic)),
          extra,
          h('div', { className: 'desc' }, info[3]),
        );
      };
      auto.onchange = () => { number.disabled = auto.checked; };
      name.value = preset?.name ?? defaultName(type);
      render();
      d.body.append(h('div', { className: 'add-block' }, kindsEl, form));
      const ok = () => {
        const n = name.value.trim();
        if (!n) return;
        result = { type, name: n, number: Number(number.value) || nextBlockNumber(device, type), ...extraValue() };
        d.close();
      };
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      d.foot.append(button(t.ok, ok, true), button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
}

// ---------------------------------------------------------------------------
// Add device
// ---------------------------------------------------------------------------

export function addDeviceDialog(defaultName: string): Promise<{ type: DeviceType; name: string } | null> {
  return new Promise((resolve) => {
    let result: { type: DeviceType; name: string } | null = null;
    let type: DeviceType = 'linux';
    openDialog(t.addDevice, (d) => {
      const list = h('div', { style: 'border:1px solid var(--border);min-height:180px;background:#fff' });
      const name = h('input', { value: defaultName, style: 'width:220px' });
      const info = h('div', { className: 'kv', style: 'margin-top:8px' });
      const render = () => {
        clear(list);
        list.append(h('div', { className: 'panel-subheader' }, 'Contrôleurs'));
        for (const [k, v] of Object.entries(DEVICE_TYPES) as Array<[DeviceType, (typeof DEVICE_TYPES)[DeviceType]]>) {
          list.append(h('div', { className: `tree` },
            h('div', { className: `node${k === type ? ' selected' : ''}`, style: 'padding-left:12px', onclick: () => { type = k; render(); } },
              svg(icons.cpu), h('span', { className: 'label' }, `${v.label}  (${v.order})`))));
        }
        const v = DEVICE_TYPES[type];
        clear(info);
        info.append(h('span', null, 'Référence :'), h('span', null, v.order), h('span', null, 'Description :'), h('span', null, v.description),
          h('span', null, 'Mémoire programme :'), h('span', null, `${Math.round(v.maxProgram / 1024)} Ko`));
      };
      render();
      d.body.append(h('div', { style: 'display:grid;grid-template-columns:1fr;gap:10px;width:560px' },
        h('div', { className: 'field', style: 'grid-template-columns:120px 1fr' }, h('label', null, "Nom d'appareil"), name), list, info));
      d.foot.append(button(t.ok, () => { result = { type, name: name.value.trim() || defaultName }; d.close(); }, true), button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
}

// ---------------------------------------------------------------------------
// Connection ("Liaison en ligne" / "Chargement étendu")
// ---------------------------------------------------------------------------

export interface ConnectionSpec {
  host: string;
  port: number;
  password: string;
}

export function connectionDialog(device: Device, title: string, action: string): Promise<ConnectionSpec | null> {
  return new Promise((resolve) => {
    let result: ConnectionSpec | null = null;
    openDialog(title, (d) => {
      const host = h('input', { value: device.connection.host });
      const port = h('input', { type: 'number', value: String(device.connection.port), style: 'width:100px' });
      const password = h('input', { type: 'password', placeholder: '(aucun)' });
      d.body.append(h('div', { style: 'width:560px' },
        h('div', { className: 'panel-subheader', style: 'margin:-2px 0 8px' }, 'Appareils dans le projet'),
        h('table', { className: 'grid', style: 'margin-bottom:12px' },
          h('tr', null, h('th', null, 'Appareil'), h('th', null, "Type d'appareil"), h('th', null, 'Emplacement'), h('th', null, 'Type'), h('th', null, 'Adresse')),
          h('tr', null, h('td', null, device.name), h('td', null, DEVICE_TYPES[device.type].label), h('td', null, '1'),
            h('td', null, device.type === 'arduino' ? 'USB' : 'PN/IE'), h('td', null, `${device.connection.host}`))),
        h('div', { className: 'field' }, h('label', null, t.interfaceType), h('select', null, h('option', null, t.interfaceTcp))),
        h('div', { className: 'field' }, h('label', null, t.ipAddress), host, h('span', { className: 'hint' }, 'ex. 192.168.0.10, plc.local')),
        h('div', { className: 'field' }, h('label', null, t.port), port),
        h('div', { className: 'field' }, h('label', null, t.password), password, h('span', { className: 'hint' }, 'si la CPU est protégée')),
      ));
      const ok = () => {
        result = { host: host.value.trim(), port: Number(port.value) || 20105, password: password.value };
        d.close();
      };
      password.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      d.foot.append(button(action, ok, true), button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
}

/** "Aperçu du chargement": what will happen, with the options the user can change. */
export function loadPreviewDialog(device: Device, info: { cpuState: string; willStop: boolean; differs: boolean; stats: string }): Promise<{ startAfter: boolean } | null> {
  return new Promise((resolve) => {
    let result: { startAfter: boolean } | null = null;
    openDialog(t.loadPreview, (d) => {
      const stopCb = h('input', { type: 'checkbox', checked: true });
      const startCb = h('input', { type: 'checkbox', checked: true });
      const row = (status: string, target: string, message: string, action: Node | string) =>
        h('tr', null, h('td', null, svg(status === 'ok' ? icons.ok : icons.warning)), h('td', null, target), h('td', null, message), h('td', null, action));
      d.body.append(h('div', { style: 'width:720px' },
        h('p', { className: 'muted', style: 'margin-top:0' }, 'Vérifier avant le chargement'),
        h('table', { className: 'grid preview-table' },
          h('tr', null, h('th', { style: 'width:30px' }, 'État'), h('th', { style: 'width:150px' }, 'Cible'), h('th', null, 'Message'), h('th', { style: 'width:190px' }, 'Action')),
          row('ok', device.name, 'Prêt pour le chargement.', ''),
          info.willStop ? row('warn', '  Modules', `La CPU est à l'état ${info.cpuState}. Le chargement nécessite l'arrêt de la CPU.`,
            h('label', { style: 'display:flex;gap:4px;align-items:center' }, stopCb, 'Arrêter tout')) : null,
          row('ok', '  Logiciel', info.differs ? 'Le logiciel est chargé dans l\'appareil (' + info.stats + ').' : 'Le logiciel en ligne est identique. Il sera rechargé.', 'Charger'),
          row('ok', '  Après chargement', 'Démarrer les modules après le chargement.', h('label', { style: 'display:flex;gap:4px;align-items:center' }, startCb, 'Démarrer module'))),
      ));
      const load = h('button', { className: 'button primary', onclick: () => { result = { startAfter: startCb.checked }; d.close(); } }, t.load);
      stopCb.onchange = () => { load.disabled = !stopCb.checked; };
      d.foot.append(load, button(t.cancel, () => d.close()));
    }, { onClose: () => resolve(result) });
  });
}

export function progressDialog(title: string, label: string): { set(fraction: number, text?: string): void; close(): void } {
  let bar!: HTMLDivElement;
  let text!: HTMLDivElement;
  const d = openDialog(title, (dlg) => {
    bar = h('div');
    text = h('div', { className: 'muted', style: 'margin-bottom:6px' }, label);
    dlg.body.append(h('div', { style: 'width:420px' }, text, h('div', { className: 'progress' }, bar)));
  });
  return {
    set(fraction, message) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      if (message) text.textContent = message;
    },
    close: () => d.close(),
  };
}
