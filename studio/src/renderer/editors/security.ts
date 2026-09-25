// "Sécurité": user accounts of a CPU (roles) and its audit trail (who did what, when, from
// where), with the check of the chain and of the signatures of the CPU.
import { keyFingerprint, ROLES, verifyAudit, type AuditLog, type Device, type Role, type UserAccount } from '../../../../sdk/src/browser.ts';
import * as A from '../actions.ts';
import { call, downloadFile } from '../host.ts';
import { clear, h, svg } from '../dom.ts';
import { icons } from '../icons.ts';
import { store } from '../store.ts';
import { alertDialog, button, confirmDialog, openDialog, promptDialog } from '../ui/dialogs.ts';
import type { EditorView } from './types.ts';

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'lecture seule',
  operator: 'opérateur',
  engineer: 'ingénieur',
  admin: 'administrateur',
};

const ROLE_HINTS: Record<Role, string> = {
  viewer: 'état, visualisation des variables, diagnostics, journaux',
  operator: '+ écriture de variables, marche / arrêt de la CPU',
  engineer: '+ chargement du programme, forçage, identifiants SQL, lecture du programme',
  admin: '+ gestion des utilisateurs',
};

const ACTION_LABELS: Record<string, string> = {
  login: 'Connexion', 'login failed': 'Échec de connexion', lockout: 'Verrouillage (tentatives)', denied: 'Refusé (droits)',
  download: 'Chargement du programme', 'download rejected': 'Chargement refusé', upload: 'Lecture du programme',
  start: 'Mise en RUN', 'start (cold)': 'Mise en RUN (démarrage à froid)', stop: 'Mise en STOP', write: 'Écriture de variable',
  force: 'Forçage', 'unforce all': 'Annulation des forçages', 'set secret': 'Identifiants modifiés', 'datalog test': 'Test de connexion SQL',
  'user set': 'Utilisateur créé / modifié', 'user deleted': 'Utilisateur supprimé', 'password reset': 'Mot de passe réinitialisé',
  'password changed': 'Mot de passe changé', 'key trusted': 'Clé d\'ingénierie approuvée', 'key removed': 'Clé d\'ingénierie retirée',
  'program rejected': 'Programme refusé (signature)', 'password change failed': 'Changement de mot de passe refusé', fault: 'Défaut CPU',
};

/** Password policy of the CPU (same rule, checked again by the CPU) */
export function passwordProblem(p: string): string | null {
  if (p.length < 10) return 'au moins 10 caractères';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  return kinds < 3 ? 'au moins 3 types de caractères parmi minuscules, majuscules, chiffres, symboles' : null;
}

function userDialog(title: string, opts: { name?: string; role?: Role; askName: boolean; askRole: boolean; askOld?: boolean }): Promise<{ name: string; role: Role; password: string; old: string } | null> {
  return new Promise((resolve) => {
    let result: { name: string; role: Role; password: string; old: string } | null = null;
    openDialog(title, (d) => {
      const name = h('input', { value: opts.name ?? '', disabled: !opts.askName, autocomplete: 'off' });
      const role = h('select', null, ...ROLES.map((r) => h('option', { value: r, selected: r === (opts.role ?? 'operator') }, ROLE_LABELS[r])));
      const roleHint = h('span', { className: 'hint' });
      const syncHint = () => { roleHint.textContent = ROLE_HINTS[role.value as Role]; };
      role.onchange = syncHint;
      syncHint();
      const old = h('input', { type: 'password', autocomplete: 'current-password' });
      const pw = h('input', { type: 'password', autocomplete: 'new-password' });
      const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
      const error = h('div', { className: 'error-text', style: 'min-height:1.2em;color:var(--error, #c62828)' });
      d.body.append(h('div', { style: 'width:620px' },
        opts.askName || opts.name ? h('div', { className: 'field' }, h('label', null, 'Utilisateur'), name, h('span', { className: 'hint' }, 'lettres, chiffres, . _ -')) : '',
        opts.askRole ? h('div', { className: 'field' }, h('label', null, 'Rôle'), role, roleHint) : '',
        opts.askOld ? h('div', { className: 'field' }, h('label', null, 'Mot de passe actuel'), old) : '',
        h('div', { className: 'field' }, h('label', null, 'Nouveau mot de passe'), pw, h('span', { className: 'hint' }, '10 caractères min., 3 types parmi minuscules / majuscules / chiffres / symboles')),
        h('div', { className: 'field' }, h('label', null, 'Confirmation'), pw2),
        error));
      const ok = () => {
        if (opts.askName && !/^[A-Za-z0-9._-]{1,32}$/.test(name.value.trim())) { error.textContent = 'Nom d\'utilisateur invalide.'; return; }
        const problem = passwordProblem(pw.value);
        if (problem) { error.textContent = `Mot de passe trop faible : ${problem}.`; return; }
        if (pw.value !== pw2.value) { error.textContent = 'Les deux mots de passe sont différents.'; return; }
        result = { name: name.value.trim(), role: role.value as Role, password: pw.value, old: old.value };
        d.close();
      };
      pw2.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      d.foot.append(button('OK', ok, true), button('Annuler', () => d.close()));
    }, { onClose: () => resolve(result) });
  });
}

export function securityEditor(device: Device): EditorView {
  const usersBox = h('div');
  const keysBox = h('div');
  const auditBox = h('div', { style: 'flex:1;overflow:auto' });
  const verdict = h('span', { className: 'muted' });
  let audit: AuditLog = { records: [] };
  let users: UserAccount[] = [];
  let self = '';

  const online = () => store.onlineOf(device.id).connected;
  const role = () => store.onlineOf(device.id).role ?? (store.onlineOf(device.id).user ? 'viewer' : 'admin');
  const fail = (e: unknown) => alertDialog('Sécurité', A.cpuMessage((e as Error).message), 'error');

  const renderUsers = () => {
    clear(usersBox);
    if (!online()) {
      usersBox.append(h('p', { className: 'muted', style: 'padding:8px 10px' },
        'Passez en ligne pour gérer les utilisateurs de la CPU. ',
        h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); void A.goOnlineCmd(device); } }, 'Liaison en ligne'),
        h('br'), 'Premier administrateur : sur la CPU, ', h('code', null, `vplc-cpu --data <dossier> --add-user admin --role admin`),
        ' (mot de passe saisi au clavier, jamais sur la ligne de commande).'));
      return;
    }
    const s = store.onlineOf(device.id);
    const admin = role() === 'admin';
    if (!s.user && !users.length) {
      usersBox.append(h('p', { className: 'muted', style: 'padding:8px 10px' },
        store.simulation.has(device.id)
          ? 'CPU simulée : pas de comptes utilisateurs.'
          : 'Cette CPU n\'a pas de comptes utilisateurs (mot de passe unique ou aucune protection). Créez le premier administrateur sur la CPU : ',
        store.simulation.has(device.id) ? '' : h('code', null, 'vplc-cpu --add-user admin --role admin')));
      return;
    }
    usersBox.append(
      h('div', { className: 'panel-toolbar', style: 'gap:6px' },
        admin ? h('button', { className: 'tbtn', onclick: () => void addUser() }, svg(icons.add), ' Utilisateur') : '',
        h('button', { className: 'tbtn', onclick: () => void changeOwn() }, 'Changer mon mot de passe'),
        h('span', { className: 'muted' }, `Connecté : ${s.user ?? '?'} (${ROLE_LABELS[role()]})`)),
      h('table', { className: 'grid', style: 'margin:6px 10px;width:auto' },
        h('tr', null, h('th', null, 'Utilisateur'), h('th', null, 'Rôle'), h('th', null, 'Droits'), h('th', null, 'Mot de passe changé le'), admin ? h('th', null, '') : ''),
        ...users.map((u) => h('tr', null,
          h('td', null, u.name, u.name === self ? ' (vous)' : ''),
          h('td', null, ROLE_LABELS[u.role]),
          h('td', { className: 'muted', style: 'white-space:normal;max-width:280px' }, ROLE_HINTS[u.role]),
          h('td', null, u.changed ? new Date(u.changed * 1000).toLocaleString() : ''),
          admin ? h('td', null,
            h('button', { className: 'tbtn', title: 'Rôle / mot de passe', onclick: () => void editUser(u) }, 'Modifier'),
            h('button', { className: 'tbtn', title: 'Supprimer', onclick: () => void removeUser(u) }, svg(icons.del))) : ''))));
  };

  /** Signed programs: key of this workstation, keys trusted by the CPU */
  const renderKeys = async () => {
    clear(keysBox);
    let mine: { publicKey: string; fingerprint: string } | null = null;
    try {
      mine = await call('engineeringKey');
    } catch {
      mine = null;
    }
    const line = h('p', { style: 'margin:6px 10px' }, 'Clé d\'ingénierie de ce poste : ', h('code', null, mine?.fingerprint ?? '?'),
      h('span', { className: 'muted' }, ' — chaque programme chargé est signé avec cette clé.'));
    keysBox.append(line);
    if (!online() || store.simulation.has(device.id)) return;
    let trusted: { required: boolean; keys: Array<{ name: string; key: string }> };
    try {
      trusted = await call('trustedKeys', device.id);
    } catch {
      return;
    }
    const admin = role() === 'admin';
    const trustedMine = mine && trusted.keys.some((k) => k.key === mine!.publicKey);
    keysBox.append(
      h('p', { style: 'margin:4px 10px' }, trusted.required
        ? h('span', null, svg(icons.info), ' La CPU n\'accepte que les programmes signés par une clé de confiance (--signed-programs).')
        : h('span', { className: 'muted' }, 'La CPU accepte aussi les programmes non signés (option --signed-programs pour l\'interdire).')),
      h('table', { className: 'grid', style: 'margin:6px 10px;width:auto' },
        h('tr', null, h('th', null, 'Clé de confiance'), h('th', null, 'Empreinte'), admin ? h('th', null, '') : ''),
        ...trusted.keys.map((k) => {
          const fp = h('code', null, '…');
          void keyFingerprint(k.key).then((v) => { fp.textContent = v; });
          return h('tr', null, h('td', null, k.name, mine && k.key === mine.publicKey ? ' (ce poste)' : ''), h('td', null, fp),
            admin ? h('td', null, h('button', { className: 'tbtn', title: 'Retirer', onclick: async () => {
              if (!(await confirmDialog('Clés de confiance', `Retirer la clé « ${k.name} » ? Les programmes signés avec elle seront refusés.`))) return;
              await call('untrustKey', device.id, k.name).then(reload, fail);
            } }, svg(icons.del))) : '');
        })),
      admin && mine && !trustedMine ? h('button', { className: 'button', style: 'margin:0 10px 6px', onclick: async () => {
        const name = await promptDialog('Clés de confiance', 'Nom de la clé (ingénieur ou poste)', store.onlineOf(device.id).user ?? 'engineering');
        if (!name) return;
        await call('trustKey', device.id, name.trim(), mine!.publicKey).then(reload, fail);
      } }, 'Faire confiance à la clé de ce poste') : '');
  };

  const auditActions = (a: string) => ACTION_LABELS[a] ?? a;

  const renderAudit = () => {
    clear(auditBox);
    if (!online()) return;
    const rows = [...audit.records].reverse();
    auditBox.append(h('table', { className: 'grid', style: 'margin:6px 10px;width:auto' },
      h('tr', null, h('th', null, 'N°'), h('th', null, 'Date'), h('th', null, 'Utilisateur'), h('th', null, 'Poste'), h('th', null, 'Action'), h('th', null, 'Détail')),
      ...rows.map((r) => h('tr', { className: /failed|denied|lockout|rejected|fault/.test(r.action) ? 'warn' : '' },
        h('td', null, String(r.seq)),
        h('td', null, new Date(r.ts).toLocaleString()),
        h('td', null, r.user),
        h('td', null, r.peer),
        h('td', null, auditActions(r.action)),
        h('td', { className: 'muted' }, r.detail)))));
  };

  const loadUsers = async () => {
    if (!online()) return;
    try {
      const r = await call('users', device.id);
      users = r.users;
      self = r.self;
    } catch {
      users = [];
    }
    renderUsers();
  };

  const loadAudit = async () => {
    if (!online()) return;
    try {
      audit = await call('auditRead', device.id, 200, 0);
      verdict.textContent = `${audit.records.length} dernier(s) événement(s) sur ${audit.last ?? 0}`;
    } catch (e) {
      audit = { records: [] };
      verdict.textContent = (e as Error).message;
    }
    renderAudit();
  };

  const reload = async () => {
    renderUsers();
    await Promise.all([loadUsers(), loadAudit(), renderKeys()]);
  };

  const addUser = async () => {
    const r = await userDialog('Nouvel utilisateur', { askName: true, askRole: true });
    if (!r) return;
    await call('setUser', device.id, r.name, r.password, r.role).then(reload, fail);
  };
  const editUser = async (u: UserAccount) => {
    const r = await userDialog(`Utilisateur ${u.name}`, { name: u.name, role: u.role, askName: false, askRole: true });
    if (!r) return;
    await call('setUser', device.id, u.name, r.password, r.role).then(reload, fail);
  };
  const removeUser = async (u: UserAccount) => {
    if (!(await confirmDialog('Supprimer', `Supprimer l'utilisateur « ${u.name} » ?`))) return;
    await call('deleteUser', device.id, u.name).then(reload, fail);
  };
  const changeOwn = async () => {
    const r = await userDialog('Changer mon mot de passe', { askName: false, askRole: false, askOld: true });
    if (!r) return;
    await call('changePassword', device.id, r.old, r.password).then(async () => {
      await alertDialog('Sécurité', 'Mot de passe changé. Il sera demandé à la prochaine liaison en ligne.');
      await reload();
    }, fail);
  };

  /** Whole trail from record 1: chain and signatures */
  const verify = async () => {
    try {
      const all: AuditLog = await call('auditReadAll', device.id);
      const first = all.records[0];
      const plc = all.plc ?? device.name;
      // the oldest records may have been rotated out of memory: the check starts at the first one kept
      const result = await verifyAudit(first && first.seq > 1
        ? { plc, records: all.records.slice(1), previous: first.chain, publicKey: all.key }
        : { plc, records: all.records, publicKey: all.key });
      const fp = all.key ? await keyFingerprint(all.key) : '(pas de clé)';
      await alertDialog('Journal d\'audit', result.ok
        ? `Journal intègre : ${all.records.length} événement(s) vérifié(s) (chaînage SHA-256 et signatures Ed25519).\n\nEmpreinte de la clé de la CPU : ${fp}\nComparez-la à celle relevée à la mise en service.`
        : `Journal ALTÉRÉ à l'événement ${result.brokenAt} : ${result.reason}.`, result.ok ? 'info' : 'error');
    } catch (e) {
      await fail(e);
    }
  };

  const exportAudit = async () => {
    try {
      const all: AuditLog = await call('auditReadAll', device.id);
      downloadFile(`${device.name}-audit.jsonl`, all.records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'application/x-ndjson');
    } catch (e) {
      await fail(e);
    }
  };

  const element = h('div', { className: 'editor-host', style: 'display:flex;flex-direction:column' },
    h('div', { className: 'panel-toolbar', style: 'gap:6px' },
      h('button', { className: 'tbtn', title: 'Actualiser', onclick: () => void reload() }, svg(icons.refresh)),
      h('span', { className: 'muted' }, 'Accès par rôle (moindre privilège), verrouillage après 5 échecs, journal d\'audit chaîné et signé par la CPU.')),
    h('div', { className: 'panel-subheader' }, 'Utilisateurs de la CPU'),
    usersBox,
    h('div', { className: 'panel-subheader' }, 'Programmes signés'),
    keysBox,
    h('div', { className: 'panel-subheader', style: 'display:flex;gap:8px;align-items:center' }, 'Journal d\'audit',
      h('button', { className: 'tbtn', onclick: () => void verify() }, 'Vérifier l\'intégrité'),
      h('button', { className: 'tbtn', onclick: () => void exportAudit() }, 'Exporter (JSONL)'),
      verdict),
    auditBox);

  // 'online' is emitted at every poll: only the transitions count
  let wasOnline = online();
  const unsubscribe = store.on((topic) => {
    if (topic === 'online' && online() !== wasOnline) {
      wasOnline = online();
      if (!online()) {
        users = [];
        audit = { records: [] };
        verdict.textContent = '';
        renderAudit();
      }
      void reload();
    }
  });
  renderUsers();
  return {
    element, icon: 'security', title: () => `Sécurité — ${device.name}`, crumbs: () => [device.name, 'Sécurité'],
    shown: () => void reload(),
    destroy: unsubscribe,
  };
}
