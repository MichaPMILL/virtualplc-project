// "Traçabilité": data logs of a CPU (records of tag values, local database of the CPU, then
// PostgreSQL / MySQL / MariaDB), their state online and the certificates for customers.
import {
  DEFAULT_DB_PORT, keyFingerprint, newId, secretKey,
  type DataLog, type DataLogColumn, type DataLogStatus, type Device, type SymbolNode,
} from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { call, downloadFile } from '../host.ts';
import { clear, h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';
import { Grid } from './grid.ts';
import { alertDialog, button, confirmDialog, openDialog, promptDialog } from '../ui/dialogs.ts';
import type { EditorView } from './types.ts';

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Leaf paths of the compiled symbols, and the tags, for the tag fields */
function tagPaths(device: Device): string[] {
  const out = new Set<string>(device.tagTables.flatMap((tt) => tt.tags.map((x) => x.name)));
  const walk = (n: SymbolNode, path: string) => {
    if (out.size > 2000) return;
    if (n.children) {
      for (const c of n.children) if (!c.name.startsWith('[')) walk(c, `${path}.${c.name}`);
    } else {
      out.add(path);
    }
  };
  for (const s of store.symbols(device.id)) walk(s, /^[A-Za-z_]\w*$/.test(s.name) ? s.name : `"${s.name}"`);
  return [...out];
}

export function dataLogsEditor(device: Device): EditorView {
  const logs = () => (device.dataLogs ??= []);
  let current: DataLog | undefined = logs()[0];
  let status: DataLogStatus | null = null;
  let timer: number | undefined;

  const list = h('div', { className: 'ifc-methods' });
  const form = h('div', { className: 'dl-form' });
  const online = h('div', { className: 'dl-online' });

  const touch = () => {
    store.touch();
    renderList();
  };

  const columns = new Grid<DataLogColumn>({
    numbered: true,
    rowIcon: () => 'tagTable',
    columns: [
      {
        title: 'Colonne', width: '30%', kind: 'text', primary: true, get: (r) => r.name, set: (r, v) => { r.name = v.trim(); },
        validate: (v) => (NAME_RE.test(v.trim()) ? null : 'Nom de colonne invalide (lettres, chiffres et _)'),
      },
      { title: 'Variable', width: '40%', kind: 'text', mono: true, get: (r) => r.tag, set: (r, v) => { r.tag = v.trim(); }, suggestions: () => tagPaths(device) },
      { title: t.comment, kind: 'readonly', get: () => '' },
    ],
    sections: () => current ? [{
      title: 'Colonnes (valeurs enregistrées)', icon: 'folder' as const, rows: current.columns,
      create: (name: string) => ({ name: NAME_RE.test(name) ? name : `col_${current!.columns.length + 1}`, tag: '' }),
    }] : [],
    onChange: () => store.touch(),
  });

  const renderList = () => {
    clear(list);
    for (const l of logs()) {
      const err = store.compile.get(device.id)?.diagnostics.some((d) => d.dataLogId === l.id && d.severity === 'error');
      list.append(h('div', { className: `ifc-method${l === current ? ' selected' : ''}${err ? ' error' : ''}`, onclick: () => select(l) },
        svg(icons.trace), ` ${l.name}`, h('span', { className: 'muted', style: 'margin-left:auto' }, l.destination ? l.destination.kind === 'postgresql' ? 'PostgreSQL' : 'MySQL' : 'local')));
    }
  };

  const field = (label: string, input: HTMLElement, hint?: string) =>
    h('div', { className: 'field', style: 'grid-template-columns:170px 1fr' }, h('label', null, label), input, hint ? h('span', { className: 'hint' }, hint) : null);

  const renderForm = () => {
    clear(form);
    if (!current) {
      form.append(h('div', { className: 'muted', style: 'padding:12px' }, 'Ajoutez un journal de données : ses colonnes sont des variables, enregistrées à chaque déclenchement dans la base de données de la CPU, puis copiées dans votre base PostgreSQL ou MySQL / MariaDB.'));
      return;
    }
    const log = current;
    const text = (value: string, set: (v: string) => void, attrs: Record<string, unknown> = {}) => {
      const i = h('input', { value, ...attrs });
      i.onchange = () => { set(i.value.trim()); touch(); };
      return i;
    };
    // --- trigger
    const kind = h('select', null, h('option', { value: 'program' }, 'Par le programme : DATALOG_WRITE(\'' + log.name + '\')'),
      h('option', { value: 'edge' }, 'Front montant d\'une variable Bool'), h('option', { value: 'period' }, 'Périodique'));
    kind.value = log.trigger.kind;
    const trig = h('span');
    const renderTrigger = () => {
      clear(trig);
      if (log.trigger.kind === 'edge') {
        const tr = log.trigger;
        const i = text(tr.tag, (v) => { tr.tag = v; }, { list: 'dl-tags', placeholder: 'ex. "Machine".BoxDone', className: 'mono' });
        trig.append(i);
      } else if (log.trigger.kind === 'period') {
        const tr = log.trigger;
        trig.append(text(String(tr.ms), (v) => { tr.ms = Math.max(10, Number(v) || 1000); }, { type: 'number', min: '10', style: 'width:110px' }), ' ms');
      }
    };
    kind.onchange = () => {
      log.trigger = kind.value === 'edge' ? { kind: 'edge', tag: '' } : kind.value === 'period' ? { kind: 'period', ms: 1000 } : { kind: 'program' };
      touch();
      renderTrigger();
    };
    renderTrigger();
    // --- destination
    const dest = h('select', null, h('option', { value: '' }, 'Aucune — base locale de la CPU uniquement'),
      h('option', { value: 'postgresql' }, 'PostgreSQL'), h('option', { value: 'mysql' }, 'MySQL / MariaDB'));
    dest.value = log.destination?.kind ?? '';
    const destFields = h('div');
    const renderDest = () => {
      clear(destFields);
      const d = log.destination;
      if (!d) return;
      const tls = h('select', null, h('option', { value: 'verify' }, 'TLS avec vérification du certificat (recommandé)'),
        h('option', { value: 'require' }, 'TLS sans vérification du certificat'), h('option', { value: 'disable' }, 'Sans chiffrement (réseau de confiance uniquement)'));
      tls.value = d.tls ?? 'verify';
      tls.onchange = () => { d.tls = tls.value as typeof d.tls; touch(); renderDest(); };
      destFields.append(
        field('Serveur', text(d.host, (v) => { d.host = v; }, { placeholder: 'ex. db.usine.local' })),
        field('Port', text(String(d.port ?? DEFAULT_DB_PORT[d.kind]), (v) => { d.port = Number(v) || undefined; }, { type: 'number', style: 'width:110px' })),
        field('Base de données', text(d.database, (v) => { d.database = v; })),
        field('Table', text(d.table, (v) => { d.table = v; }), 'créée par la CPU si elle n\'existe pas'),
        field('Utilisateur', text(d.user, (v) => { d.user = v; }), 'droits conseillés : CREATE, INSERT, SELECT (pas UPDATE ni DELETE)'),
        field('Chiffrement', tls),
        d.tls === 'disable' ? h('div', { className: 'dl-warning' }, 'Sans chiffrement, les valeurs et l\'authentification circulent en clair sur le réseau.') : h('span'),
        h('div', { className: 'muted', style: 'margin:4px 0 0 170px' }, 'Le mot de passe est enregistré sur la CPU (bouton « Mot de passe » en ligne), jamais dans le projet ni dans Git.'),
      );
    };
    dest.onchange = () => {
      log.destination = dest.value ? {
        kind: dest.value as 'postgresql' | 'mysql', host: log.destination?.host ?? '', port: undefined,
        database: log.destination?.database ?? 'traceability', table: log.destination?.table ?? log.name.toLowerCase(), user: log.destination?.user ?? 'plc', tls: log.destination?.tls ?? 'verify',
      } : undefined;
      touch();
      renderDest();
    };
    renderDest();
    const retention = text(String(log.retentionDays ?? 0), (v) => { log.retentionDays = Math.max(0, Number(v) || 0); }, { type: 'number', min: '0', style: 'width:110px' });
    form.append(
      h('div', { className: 'panel-subheader' }, svg(icons.trace), ` Journal « ${log.name} »`),
      field('Commentaire', text(log.comment ?? '', (v) => { log.comment = v || undefined; })),
      field('Déclenchement', h('span', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap' }, kind, trig)),
      field('Conservation dans la CPU', h('span', null, retention, ' jours'), '0 = toujours ; avec une base de données, seulement une fois les enregistrements copiés'),
      h('div', { className: 'dl-columns' }, columns.element),
      h('div', { className: 'panel-subheader' }, svg(icons.network), ' Base de données'),
      field('Destination', dest),
      destFields,
      h('datalist', { id: 'dl-tags' }, ...tagPaths(device).map((p) => h('option', { value: p }))),
    );
    columns.render();
  };

  // --- online: state, password, test, latest records, certificate
  const index = () => (current ? logs().indexOf(current) : -1);
  const poll = async () => {
    const s = store.onlineOf(device.id);
    if (!current || !s.connected) {
      status = null;
      renderOnline();
      return;
    }
    try {
      status = await call('dataLogRead', device.id, index(), 12);
    } catch (e) {
      status = { error: (e as Error).message };
    }
    renderOnline();
  };
  const renderOnline = () => {
    clear(online);
    const s = store.onlineOf(device.id);
    online.append(h('div', { className: 'panel-subheader' }, svg(icons.online), ' En ligne'));
    if (!current) return;
    if (!s.connected) {
      online.append(h('div', { className: 'muted', style: 'padding:6px 10px' }, 'Passez en ligne (ou démarrez la simulation) pour voir les enregistrements, définir le mot de passe de la base de données et exporter des certificats.'));
      return;
    }
    const st = status;
    if (!st) return;
    const d = current.destination;
    const kv = (k: string, v: string | HTMLElement) => [h('span', { className: 'muted' }, k), typeof v === 'string' ? h('span', null, v) : v];
    const stateText = !d ? 'base locale de la CPU' : st.connected ? 'connectée' : st.error ? 'non connectée' : 'connexion…';
    online.append(h('div', { className: 'kv', style: 'padding:6px 10px' },
      ...kv('Enregistrements', `${st.records ?? '—'}${st.pending ? ` (dont ${st.pending} en attente de copie)` : ''}`),
      ...(d ? kv('Base de données', h('span', { className: st.connected ? 'ok-text' : 'err-text' }, stateText)) : []),
      ...(st.lastSync ? kv('Dernière copie', st.lastSync) : []),
      ...(d ? kv('Mot de passe', st.password ? 'défini sur la CPU' : 'non défini') : []),
      ...(st.publicKey ? kv('Clé de la CPU', h('code', { className: 'dl-fp' }, '…')) : []),
    ));
    if (st.error) online.append(h('div', { className: 'dl-warning' }, st.error));
    if (st.publicKey) void keyFingerprint(st.publicKey).then((fp) => { const c = online.querySelector('.dl-fp'); if (c) c.textContent = fp; });
    online.append(h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;padding:0 10px 6px' },
      d ? button('Mot de passe…', () => void setPassword()) : null,
      d ? button('Tester la connexion', () => void call('dataLogTest', device.id, index()).then((x) => { status = x; renderOnline(); setTimeout(() => void poll(), 1500); })) : null,
      button('Certificat de traçabilité…', () => void certificate()),
      button('Exporter (CSV)', () => void exportCsv()),
    ));
    const cols = st.columns ?? [];
    const table = h('table', { className: 'grid' }, h('tr', null, h('th', null, 'N°'), h('th', null, 'Date (UTC)'), ...cols.map((c) => h('th', null, c)), h('th', null, 'Chaîne'), h('th', null, d ? 'Copié' : '')));
    for (const row of st.rows ?? []) {
      table.append(h('tr', null, h('td', null, String(row[0])), h('td', { className: 'mono' }, String(row[1])),
        ...cols.map((_, k) => h('td', { className: 'mono' }, row[2 + k] === null ? '' : String(row[2 + k]))),
        h('td', { className: 'mono muted' }, String(row[2 + cols.length] ?? '')),
        h('td', null, d ? (row[3 + cols.length] ? '✔' : '…') : '')));
    }
    online.append(h('div', { style: 'padding:0 10px 10px;overflow:auto' }, table));
  };

  const setPassword = async () => {
    const d = current?.destination;
    if (!d) return;
    openDialog('Mot de passe de la base de données', (dlg) => {
      const pw = h('input', { type: 'password', autocomplete: 'new-password', style: 'width:100%' });
      dlg.body.append(h('div', { style: 'width:460px' },
        h('p', null, `Compte : ${secretKey(d)}`),
        h('p', { className: 'muted' }, 'Le mot de passe est envoyé à la CPU, qui le conserve dans un fichier accessible à elle seule. Il n\'est enregistré ni dans le projet, ni dans le Studio.'),
        pw));
      const ok = async () => {
        try {
          await call('setSecret', device.id, secretKey(d), pw.value);
          store.addMessage({ severity: 'ok', text: `Mot de passe de ${secretKey(d)} enregistré sur la CPU.`, path: device.name });
          dlg.close();
          setTimeout(() => void poll(), 1500);
        } catch (e) {
          await alertDialog('Mot de passe', (e as Error).message, 'error');
        }
      };
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') void ok(); });
      dlg.foot.append(button(t.ok, () => void ok(), true), button(t.cancel, () => dlg.close()));
    });
  };

  const certificate = async () => {
    if (!current) return;
    const max = Number(await promptDialog('Certificat de traçabilité', 'Nombre d\'enregistrements (les plus récents)', '1000'));
    if (!max) return;
    try {
      const cert = await call('traceCertificate', device.id, index(), max);
      const fp = await keyFingerprint(cert.publicKey);
      downloadFile(`${device.name}_${current.name}_${new Date().toISOString().slice(0, 10)}.trace.json`, JSON.stringify(cert, null, 1), 'application/json');
      await alertDialog('Certificat de traçabilité', `${cert.records.length} enregistrement(s) signés par la CPU.\n\nLe client vérifie le certificat avec la page tools/trace-verifier/index.html (hors ligne) ou « vplc verify ».\nCommuniquez-lui l'empreinte de la clé de cette CPU :\n\n${fp}`);
    } catch (e) {
      await alertDialog('Certificat de traçabilité', (e as Error).message, 'error');
    }
  };

  const exportCsv = async () => {
    if (!current) return;
    const rows: Array<Array<unknown>> = [];
    let before = 0;
    let cols: string[] = [];
    for (let k = 0; k < 250; k++) {
      const page = await call('dataLogRead', device.id, index(), 40, before);
      cols = page.columns ?? cols;
      if (!page.rows?.length) break;
      rows.push(...page.rows);
      before = Number(page.rows[page.rows.length - 1][0]);
      if (before <= 1) break;
    }
    const esc = (v: unknown) => (v === null || v === undefined ? '' : /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [['id', 'time_utc', ...cols].join(';'), ...rows.reverse().map((r) => [r[0], r[1], ...cols.map((_, i) => r[2 + i])].map(esc).join(';'))].join('\n');
    downloadFile(`${device.name}_${current.name}.csv`, csv + '\n', 'text/csv');
  };

  const select = (l: DataLog | undefined) => {
    current = l;
    status = null;
    renderList();
    renderForm();
    void poll();
  };
  const add = async () => {
    let n = logs().length + 1;
    while (logs().some((x) => x.name === `Journal_${n}`)) n++;
    const name = await promptDialog('Ajouter un journal de données', t.name, `Journal_${n}`);
    if (!name) return;
    if (!NAME_RE.test(name) || logs().some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      await alertDialog('Ajouter un journal de données', 'Nom invalide ou déjà utilisé (lettres, chiffres et _).', 'error');
      return;
    }
    const log: DataLog = { id: newId('dlog'), name, trigger: { kind: 'program' }, columns: [] };
    logs().push(log);
    touch();
    select(log);
  };
  const rename = async () => {
    if (!current) return;
    const name = await promptDialog('Renommer le journal', t.name, current.name);
    if (!name || name === current.name) return;
    if (!NAME_RE.test(name)) return;
    current.name = name;
    touch();
    renderForm();
  };
  const remove = async () => {
    if (!current || !(await confirmDialog('Supprimer', `Supprimer le journal « ${current.name} » du projet ? Les enregistrements déjà écrits restent dans les bases de données.`))) return;
    device.dataLogs = logs().filter((x) => x !== current);
    touch();
    select(logs()[0]);
  };

  const element = h('div', { className: 'editor-host' },
    h('div', { className: 'panel-toolbar', style: 'gap:6px' },
      h('button', { className: 'tbtn', title: 'Ajouter un journal', onclick: () => void add() }, svg(icons.add), ' Journal'),
      h('button', { className: 'tbtn', title: 'Renommer', onclick: () => void rename() }, 'Renommer'),
      h('button', { className: 'tbtn', title: 'Supprimer', onclick: () => void remove() }, svg(icons.del)),
      h('span', { className: 'sep' }),
      h('button', { className: 'tbtn', title: t.compile, onclick: () => void A.compileCmd(device) }, svg(icons.compile)),
      h('span', { className: 'muted' }, 'Enregistrements chaînés (SHA-256) et signés par la CPU (Ed25519) : toute modification ou suppression est détectable.')),
    h('div', { style: 'flex:1;display:flex;min-height:0' },
      h('div', { style: 'width:230px;border-right:1px solid var(--border);overflow:auto' }, list),
      h('div', { style: 'flex:1;overflow:auto;display:flex;flex-direction:column' }, form, online)));

  renderList();
  renderForm();
  const unsubscribe = store.on((topic) => {
    if (topic === 'online') void poll();
    if (topic === 'compile') renderList();
  });
  return {
    element, icon: 'trace', title: () => `Traçabilité — ${device.name}`, crumbs: () => [device.name, 'Traçabilité'],
    shown: () => {
      void poll();
      timer ??= window.setInterval(() => void poll(), 2000);
    },
    refresh: () => {
      if (current && !logs().includes(current)) current = logs()[0];
      renderList();
      renderForm();
    },
    destroy: () => {
      window.clearInterval(timer);
      unsubscribe();
    },
  };
}
