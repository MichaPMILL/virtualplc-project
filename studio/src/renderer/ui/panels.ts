// Inspector window (bottom) and task cards (right).
import { blockLabel, DEVICE_TYPES } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { clear, h, svg } from '../dom.ts';
import { icons, type IconName } from '../icons.ts';
import { t } from '../i18n.ts';
import { store } from '../store.ts';

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export function inspector(): HTMLElement {
  let tab: 'properties' | 'info' | 'diagnostics' = 'info';
  let infoTab: 'general' | 'xref' | 'compile' = 'general';
  let xrefQuery = '';
  const tabsEl = h('div', { className: 'tabs-right' });
  const body = h('div', { className: 'panel-body' });
  const panel = h('div', { className: 'panel inspector' },
    h('div', { className: 'panel-header onlineable', style: 'padding-right:0' }, svg(icons.properties), t.showInspector, tabsEl), body);

  const msgRows = (filter: (path?: string) => boolean) => {
    const table = h('table', { className: 'grid msg-table' },
      h('tr', null, h('th', { style: 'width:26px' }), h('th', { style: 'width:34%' }, 'Chemin'), h('th', null, 'Description'), h('th', { style: 'width:70px' }, 'Aller à'), h('th', { style: 'width:80px' }, 'Heure')));
    const list = store.messages.filter((m) => filter(m.path));
    for (const m of [...list].reverse()) {
      const icon: IconName = m.severity === 'error' ? 'error' : m.severity === 'warning' ? 'warning' : m.severity === 'ok' ? 'ok' : 'info';
      table.append(h('tr', { className: m.goto ? 'goto' : '', ondblclick: () => { if (m.goto) A.goto(m.goto); } },
        h('td', null, svg(icons[icon])), h('td', null, m.path ?? ''), h('td', { title: m.text }, m.text),
        h('td', null, m.goto ? h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); A.goto(m.goto!); } }, '→') : ''),
        h('td', null, m.time)));
    }
    return h('div', { className: 'grid-wrap' }, table);
  };

  const render = () => {
    clear(tabsEl);
    for (const [k, label, icon] of [['properties', t.properties, 'properties'], ['info', t.info, 'info'], ['diagnostics', t.diagnostics, 'diag']] as const) {
      tabsEl.append(h('div', { className: `tab${tab === k ? ' active' : ''}`, onclick: () => { tab = k; render(); } }, svg(icons[icon]), label));
    }
    clear(body);
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    if (tab === 'info') {
      const sub = h('div', { className: 'subtabs' });
      for (const [k, label] of [['general', t.general], ['xref', t.crossRef], ['compile', t.compileTab]] as const) {
        sub.append(h('div', { className: `tab${infoTab === k ? ' active' : ''}`, onclick: () => { infoTab = k; render(); } }, label));
      }
      body.append(sub);
      if (infoTab === 'general') body.append(msgRows(() => true));
      else if (infoTab === 'compile') {
        const summaries = [...store.compile.entries()].map(([id, c]) => {
          const e = c.diagnostics.filter((d) => d.severity === 'error').length;
          const w = c.diagnostics.filter((d) => d.severity === 'warning').length;
          return `${store.device(id)?.name ?? ''} : ${e} erreur(s), ${w} avertissement(s)`;
        });
        body.append(h('div', { className: 'summary' }, summaries.length ? summaries.join(' — ') : 'Aucune compilation.'));
        const compiledDevices = new Set([...store.compile.keys()].map((id) => store.device(id)?.name));
        body.append(msgRows((p) => !!p && [...compiledDevices].some((n) => n && p.startsWith(n))));
      } else {
        body.append(xref());
      }
    } else if (tab === 'properties') {
      body.append(properties());
    } else {
      body.append(diagnostics());
    }
  };

  const xref = () => {
    const input = h('input', { value: xrefQuery, placeholder: 'Nom de variable, de bloc ou adresse (ex. Motor_DB, %I0.1)', style: 'width:360px;height:22px' });
    const results = h('div', { className: 'grid-wrap' });
    const search = () => {
      xrefQuery = input.value.trim();
      clear(results);
      const d = A.currentDevice();
      if (!d || !xrefQuery) return;
      const name = xrefQuery.replace(/"/g, '').toLowerCase();
      const re = new RegExp(`("${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"|\\b${name.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}\\b|${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i');
      const table = h('table', { className: 'grid' }, h('tr', null, h('th', { style: 'width:30%' }, 'Point d\'utilisation'), h('th', { style: 'width:70px' }, 'Ligne'), h('th', { style: 'width:90px' }, 'Accès'), h('th', null, 'Code')));
      let count = 0;
      for (const b of d.blocks) {
        b.code.split('\n').forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '');
          if (!re.test(code)) return;
          const write = new RegExp(`${re.source}(\\.[\\w.]+)?\\s*(:=|\\+=|-=)`, 'i').test(code) || new RegExp(`=>\\s*${re.source}`, 'i').test(code);
          count++;
          table.append(h('tr', { className: 'goto', ondblclick: () => A.goto({ kind: 'block', deviceId: d.id, blockId: b.id, line: i + 1 }) },
            h('td', null, svg(icons[b.type === 'OB' ? 'ob' : b.type === 'FB' ? 'fb' : b.type === 'FC' ? 'fc' : 'db']), ' ', blockLabel(b)),
            h('td', null, String(i + 1)), h('td', null, write ? 'Écriture' : 'Lecture'), h('td', { className: 'mono' }, line.trim())));
        });
      }
      for (const tt of d.tagTables) for (const tag of tt.tags) {
        if (tag.name.toLowerCase() === name || tag.address.toLowerCase() === name) {
          count++;
          table.append(h('tr', { className: 'goto', ondblclick: () => A.openEditor({ kind: 'tagTable', deviceId: d.id, tableId: tt.id }) },
            h('td', null, svg(icons.tagTable), ' ', tt.name), h('td'), h('td', null, 'Déclaration'), h('td', { className: 'mono' }, `"${tag.name}" ${tag.address} : ${tag.dataType}`)));
        }
      }
      results.append(h('div', { className: 'summary' }, `${count} référence(s) trouvée(s) pour « ${xrefQuery} »`), table);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    setTimeout(search, 0);
    return h('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' },
      h('div', { className: 'panel-toolbar' }, svg(icons.search), input, h('button', { className: 'button', style: 'margin-left:6px', onclick: search }, 'Rechercher')),
      results);
  };

  const properties = () => {
    const el = h('div', { className: 'props-form' });
    const sel = store.selection;
    const d = store.device(sel?.deviceId);
    if (sel?.kind === 'block' && d) {
      const b = d.blocks.find((x) => x.id === sel.id);
      if (b) {
        el.append(h('h3', null, blockLabel(b)),
          h('div', { className: 'kv' },
            h('span', null, 'Nom'), h('span', null, b.name), h('span', null, 'Type'), h('span', null, { OB: t.organizationBlock, FB: t.functionBlock, FC: t.function, DB: t.dataBlock }[b.type]),
            h('span', null, 'Numéro'), h('span', null, String(b.number)), h('span', null, 'Langage'), h('span', null, b.type === 'DB' ? 'DB' : 'SCL'),
            ...(b.event ? [h('span', null, 'Événement'), h('span', null, b.event === 'Startup' ? t.startup : t.programCycle)] : []),
            ...(b.instanceOf ? [h('span', null, 'DB d\'instance de'), h('span', null, b.instanceOf)] : []),
            h('span', null, 'Accès optimisé au bloc'), h('span', null, 'Oui')));
      }
    } else if (d) {
      const c = store.compile.get(d.id);
      el.append(h('h3', null, `${d.name} [${DEVICE_TYPES[d.type].label}]`),
        h('div', { className: 'kv' },
          h('span', null, 'Référence'), h('span', null, DEVICE_TYPES[d.type].order),
          h('span', null, 'Adresse'), h('span', null, `${d.connection.host}:${d.connection.port}`),
          h('span', null, 'Temps de cycle'), h('span', null, `${d.cpu.cycleMs} ms`),
          h('span', null, 'Blocs'), h('span', null, String(d.blocks.length)),
          ...(c ? [h('span', null, 'Mémoire de code'), h('span', null, `${c.stats.code} octets`), h('span', null, 'Mémoire de données'), h('span', null, `${c.stats.data} octets`),
            h('span', null, 'Mémoire programme max.'), h('span', null, `${Math.round(DEVICE_TYPES[d.type].maxProgram / 1024)} Ko`)] : [])));
    }
    return el;
  };

  const diagnostics = () => {
    const table = h('table', { className: 'grid' },
      h('tr', null, h('th', { style: 'width:26px' }), h('th', { style: 'width:20%' }, 'Appareil'), h('th', { style: 'width:14%' }, 'État'), h('th', null, 'Message')));
    for (const [id, s] of store.online) {
      const d = store.device(id);
      if (!d) continue;
      const last = s.logs[s.logs.length - 1];
      table.append(h('tr', null, h('td', null, svg(s.connected ? (s.state === 'FAULT' ? icons.error : icons.ok) : icons.offline)),
        h('td', null, d.name), h('td', null, s.connected ? s.state ?? '' : t.offline), h('td', null, s.fault ? `Défaut ${s.fault.code} (ligne ${s.fault.line})` : last?.msg ?? '')));
    }
    return h('div', { className: 'grid-wrap' }, table);
  };

  window.addEventListener('studio:show-info', (e) => {
    tab = 'info';
    infoTab = (e as CustomEvent).detail === 'compile' ? 'compile' : 'general';
    store.layout.inspector = true;
    store.emit('layout');
    render();
  });
  store.on((topic) => {
    if (topic === 'messages' || topic === 'compile' || (tab !== 'info' && (topic === 'online' || topic === 'project'))) render();
    if (topic === 'project' && tab === 'properties') render();
  });
  render();
  return panel;
}

// ---------------------------------------------------------------------------
// Task cards
// ---------------------------------------------------------------------------

interface Instruction {
  name: string;
  desc: string;
  snippet?: string;
  fb?: string;
}

const INSTRUCTIONS: Array<[string, IconName, Instruction[]]> = [
  ['Opérations logiques sur bits', 'logic', [
    { name: 'R_TRIG', desc: 'Détecter un front montant', fb: 'R_TRIG' },
    { name: 'F_TRIG', desc: 'Détecter un front descendant', fb: 'F_TRIG' },
  ]],
  ['Temporisations', 'timer', [
    { name: 'TP', desc: 'Générer une impulsion', fb: 'TP' },
    { name: 'TON', desc: 'Retard à la montée', fb: 'TON' },
    { name: 'TOF', desc: 'Retard à la retombée', fb: 'TOF' },
  ]],
  ['Compteurs', 'counter', [
    { name: 'CTU', desc: 'Compteur', fb: 'CTU' },
    { name: 'CTD', desc: 'Décompteur', fb: 'CTD' },
    { name: 'CTUD', desc: 'Compteur-décompteur', fb: 'CTUD' },
  ]],
  ['Comparaison', 'compare', [
    { name: '=', desc: 'Égal', snippet: ' = ' }, { name: '<>', desc: 'Différent', snippet: ' <> ' },
    { name: '>=', desc: 'Supérieur ou égal', snippet: ' >= ' }, { name: '<=', desc: 'Inférieur ou égal', snippet: ' <= ' },
  ]],
  ['Fonctions mathématiques', 'math', [
    { name: 'ABS', desc: 'Valeur absolue', snippet: 'ABS()' }, { name: 'MIN', desc: 'Minimum', snippet: 'MIN(IN1 := , IN2 := )' },
    { name: 'MAX', desc: 'Maximum', snippet: 'MAX(IN1 := , IN2 := )' }, { name: 'LIMIT', desc: 'Limiter', snippet: 'LIMIT(MN := , IN := , MX := )' },
    { name: 'SQRT', desc: 'Racine carrée', snippet: 'SQRT()' }, { name: 'MOD', desc: 'Reste de division', snippet: ' MOD ' },
  ]],
  ['Transfert', 'move', [
    { name: ':=', desc: 'Affecter une valeur', snippet: ' := ;' },
  ]],
  ['Conversion', 'convert', [
    { name: 'CONVERT', desc: 'Convertir (ex. INT_TO_REAL)', snippet: 'INT_TO_REAL()' },
    { name: 'ROUND', desc: 'Arrondir', snippet: 'ROUND()' }, { name: 'TRUNC', desc: 'Tronquer', snippet: 'TRUNC()' },
    { name: 'SCALE_X', desc: 'Mettre à l\'échelle', snippet: 'SCALE_X(MIN := , VALUE := , MAX := )' },
    { name: 'NORM_X', desc: 'Normaliser', snippet: 'NORM_X(MIN := , VALUE := , MAX := )' },
  ]],
  ['Contrôle du programme', 'control', [
    { name: 'IF...', desc: 'Exécution conditionnelle', snippet: 'IF  THEN\n    \nEND_IF;\n' },
    { name: 'CASE...', desc: 'Sélection multiple', snippet: 'CASE  OF\n    1:\n        ;\n    ELSE\n        ;\nEND_CASE;\n' },
    { name: 'FOR...', desc: 'Boucle comptée', snippet: 'FOR #i := 0 TO 9 DO\n    \nEND_FOR;\n' },
    { name: 'WHILE...', desc: 'Boucle conditionnelle', snippet: 'WHILE  DO\n    \nEND_WHILE;\n' },
    { name: 'REPEAT...', desc: 'Boucle', snippet: 'REPEAT\n    \nUNTIL \nEND_REPEAT;\n' },
    { name: 'REGION', desc: 'Structurer le code', snippet: 'REGION \n    \nEND_REGION\n' },
    { name: 'EXIT', desc: 'Quitter la boucle', snippet: 'EXIT;' }, { name: 'RETURN', desc: 'Quitter le bloc', snippet: 'RETURN;' },
  ]],
  ['Chaînes de caractères', 'string', [
    { name: 'CONCAT', desc: 'Concaténer', snippet: 'CONCAT(IN1 := , IN2 := )' }, { name: 'LEN', desc: 'Longueur', snippet: 'LEN()' },
    { name: 'LOG', desc: 'Écrire dans le tampon de diagnostic', snippet: "LOG('');" },
  ]],
];

export function taskCards(): HTMLElement {
  let card: 'instructions' | 'online' = 'instructions';
  const open = new Set<string>(['Temporisations', 'Compteurs', 'Contrôle du programme']);
  const body = h('div', { className: 'panel-body' });
  const header = h('div', { className: 'panel-header onlineable' });
  const vtabs = h('div', { className: 'taskcard-tabs' });
  const panel = h('div', { className: 'panel taskcards' }, h('div', { style: 'display:flex;flex-direction:column;min-width:0;min-height:0' }, header, body), vtabs);

  const render = () => {
    clear(vtabs);
    for (const [k, label] of [['instructions', t.instructions], ['online', t.onlineTools]] as const) {
      vtabs.append(h('div', { className: `vtab${card === k ? ' active' : ''}`, onclick: () => { card = k; render(); } }, label));
    }
    clear(header);
    header.append(card === 'instructions' ? t.instructions : t.onlineTools, h('span', { className: 'spacer' }),
      h('button', { className: 'tbtn', title: 'Réduire', onclick: () => { store.layout.tasks = false; store.emit('layout'); } }, '▸'));
    clear(body);
    if (card === 'instructions') {
      body.append(h('div', { className: 'panel-subheader' }, t.basicInstructions));
      for (const [group, icon, items] of INSTRUCTIONS) {
        const isOpen = open.has(group);
        body.append(h('div', { className: 'palette-section' },
          h('div', { className: 'ps-head', onclick: () => { if (isOpen) open.delete(group); else open.add(group); render(); } },
            svg(isOpen ? icons.collapse : icons.expand), svg(icons[icon]), group),
          ...(isOpen ? items.map((it) => h('div', {
            className: 'palette-item', title: `${it.desc} — double-clic pour insérer`,
            draggable: 'true',
            ondragstart: (e: Event) => (e as DragEvent).dataTransfer?.setData('text/plain', it.snippet ?? it.name),
            ondblclick: () => window.dispatchEvent(new CustomEvent('studio:insert-instruction', { detail: it })),
          }, svg(icons[it.fb ? (it.fb.includes('TRIG') ? 'logic' : it.fb.startsWith('CT') ? 'counter' : 'timer') : icon]), h('b', null, it.name), h('span', { className: 'desc' }, it.desc))) : [])));
      }
    } else {
      const d = A.currentDevice();
      if (!d) return;
      const s = store.onlineOf(d.id);
      const led = (on: boolean, color: string) => h('span', { className: `led-big${on ? ` ${color}` : ''}` });
      body.append(h('div', { className: 'operator' },
        h('div', { className: 'op-title' }, 'Panneau de commande CPU'),
        h('div', { className: 'op-body' },
          h('div', { className: 'leds' },
            led(s.connected && (s.state === 'RUN' || s.state === 'STOP'), s.state === 'RUN' ? 'green' : 'yellow'), h('span', null, 'RUN / STOP'),
            led(s.connected && s.state === 'FAULT', 'red'), h('span', null, 'ERROR'),
            led(s.connected && (s.forces ?? 0) > 0, 'yellow'), h('span', null, 'MAINT')),
          h('div', { className: 'op-buttons' },
            h('button', { className: 'button', disabled: !s.connected || s.state === 'RUN', onclick: () => void A.startCpuCmd(d) }, 'RUN'),
            h('button', { className: 'button', disabled: !s.connected || s.state !== 'RUN', onclick: () => void A.stopCpuCmd(d) }, 'STOP'))),
        !s.connected ? h('div', { style: 'padding:0 10px 10px' }, h('button', { className: 'button primary', onclick: () => void A.goOnlineCmd(d) }, svg(icons.online), t.goOnline)) : null),
      h('div', { className: 'operator' },
        h('div', { className: 'op-title' }, 'Temps de cycle'),
        h('div', { className: 'kv' },
          h('span', null, 'Configuré'), h('span', null, `${d.cpu.cycleMs} ms`),
          h('span', null, 'Dernier'), h('span', null, s.connected ? `${((s.scanUs ?? 0) / 1000).toFixed(2)} ms` : '—'),
          h('span', null, 'Maximum'), h('span', null, s.connected ? `${((s.maxScanUs ?? 0) / 1000).toFixed(2)} ms` : '—'))),
      h('div', { className: 'operator' },
        h('div', { className: 'op-title' }, 'Mémoire'),
        h('div', { className: 'kv' }, ...(() => {
          const c = store.compile.get(d.id);
          return c ? [h('span', null, 'Code'), h('span', null, `${c.stats.code} o`), h('span', null, 'Données'), h('span', null, `${c.stats.data} o`),
            h('span', null, '%I / %Q / %M'), h('span', null, `${c.stats.inputs} / ${c.stats.outputs} / ${c.stats.memory} o`)] : [h('span', null, 'Compilez le programme'), h('span')];
        })())));
    }
  };
  store.on((topic) => { if (card === 'online' && ['online', 'compile', 'editors'].includes(topic)) render(); });
  render();
  return panel;
}
