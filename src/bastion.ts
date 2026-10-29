// Extension Heimdia : bastions dans la barre latérale, connexion (avec première connexion
// et enrôlement du code), ouverture des serveurs et administration du bastion.
import { Bastion, BastionLoginAnswer, bastions, BastionServer, errorText, Manifest, Session } from './api';
import { h, icon } from './dom';
import { MenuItem, showMenu } from './menu';

/** Heimdia apparaît dans la page Extensions comme les protocoles. */
export const HEIMDIA_EXTENSION: Manifest = {
  id: 'heimdia',
  name: 'Heimdia (bastion)',
  version: '1.0.0',
  description: 'Serveurs protégés par un bastion Heimdia : connexion avec code, serveurs dans la barre latérale, sessions enregistrées par le bastion, administration.',
  view: 'terminal',
  builtin: true,
  fileBrowser: false,
  portForwarding: false,
  fields: [],
};

export interface BastionHost {
  toast(message: string, kind?: 'info' | 'error'): void;
  openServer(b: Bastion, s: BastionServer): void;
  sessions(): Session[];
  removeSessions(ids: string[]): Promise<void>;
  openAdmin(b: Bastion): void;
  openAudit(b: Bastion): void;
  allowsAdmin(): boolean;
  /** Extension de protocole activée (Bureau à distance pour les serveurs RDP). */
  protocolEnabled(id: string): boolean;
  filter(): string;
}

const MODE_LABEL: Record<BastionServer['mode'], string> = { coffre: 'Coffre', enregistre: 'Enregistré', rebond: 'Rebond' };
const MODE_TITLE: Record<BastionServer['mode'], string> = {
  coffre: 'Compte fourni par le bastion, session enregistrée',
  enregistre: 'Session enregistrée par le bastion ; vos identifiants sont demandés dans le terminal',
  rebond: 'Relais de bout en bout par le bastion : rien n\'est enregistré',
};
const COLLAPSED_KEY = 'portunia.bastions.replis';

function remaining(expires: string): string {
  const ms = Date.parse(expires) - Date.now();
  if (!(ms > 0)) return 'session expirée';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `expire dans ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `expire dans ${m} min`;
}

/** Sessions Portunia qui vont directement sur un serveur protégé par ce bastion. */
export function bypassing(b: Bastion, sessions: Session[]): { session: Session; server: BastionServer }[] {
  const out: { session: Session; server: BastionServer }[] = [];
  for (const s of sessions) {
    if (s.protocol !== 'ssh') continue;
    const host = String(s.values.host ?? '').trim().toLowerCase();
    const port = Number(s.values.port || 22);
    const server = b.servers.find((x) => x.hote.toLowerCase() === host && Number(x.port) === port);
    if (server && !String(s.values.jump ?? '').trim()) out.push({ session: s, server });
  }
  return out;
}

// ---------- Barre latérale ----------

export class BastionPanel {
  list: Bastion[] = [];
  private collapsed: Set<string>;
  private timer = 0;

  constructor(private root: HTMLElement, readonly host: BastionHost) {
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'); } catch { /* ignoré */ }
    this.collapsed = new Set(saved);
  }

  async load(refresh = false) {
    try {
      this.list = await bastions.list();
      if (refresh) {
        // Liste des serveurs à jour pour chaque bastion connecté (en parallèle, sans bloquer).
        await Promise.all(this.list.filter((b) => b.connected).map((b) => this.refresh(b.id, true)));
        this.list = await bastions.list();
      }
    } catch (e) {
      this.host.toast(errorText(e), 'error');
    }
    this.render();
  }

  /** Active ou coupe le panneau (extension activée ou non). */
  show(on: boolean) {
    this.root.hidden = !on;
    window.clearInterval(this.timer);
    if (on) {
      this.load(true);
      this.timer = window.setInterval(() => this.load(true), 5 * 60 * 1000);
    }
  }

  async refresh(id: string, quiet = false) {
    try {
      const b = await bastions.servers(id);
      this.list = this.list.map((x) => (x.id === id ? b : x));
    } catch (e) {
      const text = errorText(e);
      if (text === 'SESSION_EXPIREE') this.list = this.list.map((x) => (x.id === id ? { ...x, connected: false } : x));
      else if (!quiet) this.host.toast(text, 'error');
    }
    this.render();
  }

  /** Reconnexion (session expirée) ; vrai si l'utilisateur s'est reconnecté. */
  async reconnect(id: string): Promise<boolean> {
    const b = this.list.find((x) => x.id === id);
    const done = await openBastionLogin(this.host, b);
    if (done) await this.load();
    return !!done;
  }

  async add() {
    const b = await openBastionLogin(this.host);
    if (b) {
      this.host.toast(`Bastion « ${b.name} » ajouté`);
      await this.load();
    }
  }

  render() {
    const filter = this.host.filter().trim().toLowerCase();
    const head = h('div', { class: 'sidebar-head' },
      h('span', { class: 'label' }, 'Bastions'),
      h('div', { class: 'head-actions' },
        h('button', { class: 'icon-btn', 'aria-label': 'Ajouter un bastion Heimdia', title: 'Ajouter un bastion Heimdia', onclick: () => this.add() }, icon('plus'))));
    const body = h('div', { class: 'bastion-list' });
    if (!this.list.length) {
      body.append(h('div', { class: 'empty-tree' },
        h('span', { class: 'small' }, 'Aucun bastion. Un bastion Heimdia protège l\'accès à vos serveurs.'),
        h('button', { class: 'btn', onclick: () => this.add() }, 'Ajouter un bastion')));
    }
    for (const b of this.list) body.append(...this.renderBastion(b, filter));
    this.root.replaceChildren(head, body);
  }

  private menu(b: Bastion): (MenuItem | 'separator')[] {
    return [
      b.connected
        ? { label: 'Actualiser la liste', icon: 'refresh', action: () => this.refresh(b.id) }
        : { label: 'Se reconnecter', icon: 'lock', action: () => this.reconnect(b.id) },
      ...(b.role === 'admin' && b.connected ? [{ label: 'Administrer', icon: 'settings', action: () => this.host.openAdmin(b) }] : []),
      ...((b.role === 'admin' || b.role === 'auditor' || b.ownReplay) && b.connected
        ? [{ label: b.role === 'user' ? 'Mes sessions' : 'Audit', icon: 'play', action: () => this.host.openAudit(b) }] : []),
      { label: `Copier l'empreinte du certificat`, icon: 'copy', action: () => navigator.clipboard.writeText(b.apiFingerprint) },
      'separator',
      ...(b.connected ? [{ label: 'Se déconnecter', icon: 'power', action: async () => { await bastions.logout(b.id).catch(() => {}); this.load(); } }] : []),
      {
        label: 'Retirer ce bastion', icon: 'trash', danger: true, action: async () => {
          if (!confirm(`Retirer le bastion « ${b.name} » de Portunia ? Son jeton et sa liste de serveurs seront effacés de ce PC.`)) return;
          await bastions.remove(b.id).catch((e) => this.host.toast(errorText(e), 'error'));
          this.load();
        },
      },
    ];
  }

  private renderBastion(b: Bastion, filter: string): HTMLElement[] {
    const state = b.connected ? 'on' : 'off';
    const card = h('div', { class: `bastion-card ${state}` },
      h('button', {
        class: 'bastion-main', title: b.connected ? `${b.host} · ${b.login} (${roleLabel(b.role)})` : 'Se reconnecter',
        onclick: () => (b.connected ? this.toggle(b.id) : this.reconnect(b.id)),
      },
        h('span', { class: `led ${state}` }),
        h('span', { class: 'grow' },
          h('span', { class: 'bastion-name ellipsis' }, b.name),
          h('span', { class: 'bastion-sub ellipsis' }, b.connected ? `${b.login} · ${remaining(b.expires)}` : 'session expirée · cliquer pour se reconnecter'))),
      h('button', { class: 'icon-btn sm', 'aria-label': `Actions du bastion ${b.name}`, title: 'Plus d\'actions', onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY, this.menu(b)) }, icon('more', 14)));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, this.menu(b)); });
    const out: HTMLElement[] = [card];
    if (this.collapsed.has(b.id) && !filter) return out;

    const bypass = b.connected ? bypassing(b, this.host.sessions()) : [];
    if (bypass.length) {
      out.push(h('button', { class: 'bastion-warn', onclick: () => openBypass(this.host, b, bypass) },
        `${bypass.length} session(s) vont directement sur des serveurs de ce bastion`));
    }
    const servers = b.servers.filter((s) => !filter || s.nom.toLowerCase().includes(filter) || s.dossier.toLowerCase().includes(filter));
    const groups = new Map<string, BastionServer[]>();
    for (const s of servers) groups.set(s.dossier, [...(groups.get(s.dossier) ?? []), s]);
    for (const [folder, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (folder) out.push(h('div', { class: 'tree-row' }, h('span', { class: 'tree-item group-head bastion-folder' }, icon('folder', 14), h('span', { class: 'grow ellipsis' }, folder), h('span', { class: 'count' }, String(list.length)))));
      for (const s of list) out.push(this.renderServer(b, s, folder ? 1 : 0));
    }
    if (b.connected && !b.servers.length) out.push(h('p', { class: 'muted small bastion-empty' }, 'Aucun serveur ne vous est autorisé en ce moment.'));
    return out;
  }

  private renderServer(b: Bastion, s: BastionServer, depth: number): HTMLElement {
    const rdp = s.protocole === 'rdp';
    // Sans l'extension Bureau à distance, le serveur reste visible mais ne s'ouvre pas.
    const missing = rdp && !this.host.protocolEnabled('rdp');
    const open = () => {
      if (missing) return this.host.toast('Activez l’extension Bureau à distance (Extensions) pour ouvrir ce serveur', 'error');
      return b.connected ? this.host.openServer(b, s) : this.reconnect(b.id).then((ok) => ok && this.host.openServer(b, s));
    };
    const command = rdp ? `${s.hote}:${s.port}` : `ssh -p ${b.sshPort} ${b.login}%${s.nom}@${b.host}`;
    const menu = (): (MenuItem | 'separator')[] => [
      { label: 'Ouvrir', icon: 'play', action: open },
      rdp
        ? { label: 'Copier l\'adresse du serveur', icon: 'copy', action: () => navigator.clipboard.writeText(command) }
        : { label: 'Copier la commande ssh', icon: 'copy', action: () => navigator.clipboard.writeText(command) },
    ];
    const title = missing ? 'Activez l’extension Bureau à distance pour ouvrir ce serveur' : `${rdp ? 'Bureau à distance · ' : ''}${MODE_TITLE[s.mode]}\n${command}`;
    const row = h('div', { class: `tree-row${b.connected && !missing ? '' : ' disabled'}` },
      h('button', { class: 'tree-item session', style: `padding-left: ${16 + depth * 16}px`, title, onclick: open },
        h('span', { class: `dot${b.connected ? ' on' : ''}` }),
        h('span', { class: 'grow ellipsis' }, s.nom),
        rdp ? h('span', { class: 'badge proto-rdp' }, 'RDP') : null,
        h('span', { class: `badge mode-${s.mode}` }, MODE_LABEL[s.mode])));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, menu()); });
    return row;
  }

  private toggle(id: string) {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed])); } catch { /* ignoré */ }
    this.render();
  }
}

function roleLabel(role: string): string {
  return role === 'admin' ? 'administrateur' : role === 'auditor' ? 'auditeur' : 'utilisateur';
}

// ---------- Fenêtres ----------

/** Squelette commun : fenêtre modale avec en-tête, corps et boutons. */
function modal(title: string, body: HTMLElement[], buttons: HTMLElement[], wide = false) {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { method: 'dialog' },
    h('header', { class: 'dlg-head' }, h('h2', {}, title)),
    h('div', { class: 'dlg-body' }, ...body, error),
    h('footer', { class: 'dlg-foot' }, ...buttons));
  const dialog = h('dialog', { class: `dialog${wide ? ' wide' : ' narrow'}`, 'aria-label': title }, form) as HTMLDialogElement;
  document.body.append(dialog);
  return { dialog, form, error };
}

function field(label: string, input: HTMLElement, hint?: string) {
  return h('label', { class: 'fld' }, h('span', {}, label, hint ? h('span', { class: 'muted small' }, ` ${hint}`) : null), input);
}

function input(attrs: Record<string, unknown>) {
  return h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', class: 'input', ...attrs }) as HTMLInputElement;
}

/**
 * Ajout d'un bastion, ou reconnexion d'un bastion existant. Gère les étapes demandées par
 * le bastion : code, changement du mot de passe provisoire, enrôlement du code.
 */
export function openBastionLogin(_host: BastionHost, existing?: Bastion): Promise<Bastion | null> {
  return new Promise((resolve) => {
    let target = existing ? { host: existing.host, apiPort: existing.apiPort, fingerprint: existing.apiFingerprint } : null;
    let rememberAllowed = existing?.rememberAllowed ?? false;
    let result: Bastion | null = null;

    const address = input({ id: 'b-address', placeholder: 'bastion.exemple.fr ou 192.168.1.10:8443', value: existing ? `${existing.host}:${existing.apiPort}` : '' });
    const fingerprintBox = h('div', { class: 'fp', hidden: !existing }, existing?.apiFingerprint ?? '');
    const fingerprintField = h('div', { class: 'fld', hidden: true },
      h('span', {}, 'Empreinte du certificat', h('span', { class: 'muted small' }, ' à comparer avec celle donnée à l\'installation (ou « sudo heimdia info » sur le bastion)')), fingerprintBox);
    const login = input({ id: 'b-login', value: existing?.login ?? '', autocomplete: 'username' });
    const password = input({ id: 'b-password', type: 'password', autocomplete: 'current-password', placeholder: existing?.passwordSaved ? 'Mémorisé : laisser vide' : '' });
    const code = input({ id: 'b-code', inputmode: 'numeric', placeholder: '6 chiffres', maxlength: 7 });
    const newPassword = input({ id: 'b-new', type: 'password', autocomplete: 'new-password', placeholder: '10 caractères minimum' });
    const confirmPassword = input({ id: 'b-confirm', type: 'password', autocomplete: 'new-password' });
    const remember = h('input', { type: 'checkbox', id: 'b-remember', checked: !!existing?.passwordSaved }) as HTMLInputElement;
    const rememberRow = h('label', { class: 'check-row', hidden: true }, remember, h('span', {}, 'Mémoriser mon mot de passe sur ce PC (le code reste demandé)'));
    const qr = h('div', { class: 'qr-box' });
    const secretText = h('code', { class: 'fp' });
    const enrolBox = h('div', { class: 'enrol', hidden: true },
      h('p', {}, 'Première connexion : scannez ce code avec votre application d\'authentification (Microsoft Authenticator, Google Authenticator…), puis tapez le code à 6 chiffres qu\'elle affiche.'),
      h('div', { class: 'enrol-row' }, qr, h('div', { class: 'enrol-side' }, h('span', { class: 'muted small' }, 'Ou saisissez cette clé :'), secretText)));
    const credFields = h('div', { class: 'fld-group', hidden: !existing },
      h('div', { class: 'row2' }, field('Identifiant', login), field('Mot de passe', password)));
    const codeField = field('Code de l\'application d\'authentification', code, 'si demandé ; vide à la première connexion');
    const newFields = h('div', { class: 'fld-group', hidden: true },
      h('p', { class: 'muted' }, 'Votre mot de passe est provisoire : choisissez-en un nouveau.'),
      h('div', { class: 'row2' }, field('Nouveau mot de passe', newPassword), field('Confirmation', confirmPassword)));
    const intro = h('p', { class: 'muted' }, existing ? `Session expirée : reconnectez-vous à ${existing.name}.` : 'Adresse du bastion (port 8443 par défaut).');
    const submit = h('button', { type: 'submit', class: 'btn primary' }, existing ? 'Se connecter' : 'Continuer');
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Annuler');
    const { dialog, form, error } = modal(existing ? `Reconnexion · ${existing.name}` : 'Ajouter un bastion Heimdia', [
      intro, existing ? h('span') : field('Adresse', address), fingerprintField, credFields, newFields, enrolBox, codeField, rememberRow,
    ], [cancel, submit]);
    codeField.hidden = !existing;
    rememberRow.hidden = !(existing?.rememberAllowed);
    cancel.addEventListener('click', () => dialog.close());

    let busy = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      error.textContent = '';
      busy = true;
      submit.setAttribute('disabled', '');
      try {
        // Étape 1 : adresse → empreinte du certificat à vérifier.
        if (!target) {
          const probe = await bastions.probe(address.value);
          target = { host: probe.host, apiPort: probe.apiPort, fingerprint: probe.fingerprint };
          rememberAllowed = probe.info.memo_mot_de_passe;
          fingerprintBox.textContent = probe.fingerprint;
          fingerprintBox.hidden = false;
          fingerprintField.hidden = false;
          intro.textContent = `${probe.info.nom} · Heimdia ${probe.info.version}. Vérifiez l'empreinte avant d'envoyer votre mot de passe.`;
          address.disabled = true;
          credFields.hidden = false;
          codeField.hidden = false;
          rememberRow.hidden = !rememberAllowed;
          submit.textContent = 'L\'empreinte correspond, se connecter';
          login.focus();
          return;
        }
        if (!newFields.hidden && newPassword.value !== confirmPassword.value) throw new Error('Les deux nouveaux mots de passe diffèrent');
        const answer: BastionLoginAnswer = await bastions.login({
          id: existing?.id, host: target.host, apiPort: target.apiPort, fingerprint: target.fingerprint,
          login: login.value.trim(), password: password.value || undefined, code: code.value.replace(/\s/g, '') || undefined,
          newPassword: newFields.hidden ? undefined : newPassword.value, remember: remember.checked,
        });
        if (answer.etat === 'ok') {
          result = answer.bastion;
          dialog.close();
          return;
        }
        if (answer.etat === 'code_requis') {
          error.textContent = 'Tapez le code affiché par votre application d\'authentification.';
          code.focus();
        } else if (answer.etat === 'changer_mot_de_passe') {
          newFields.hidden = false;
          newPassword.focus();
        } else if (answer.etat === 'enrolement') {
          // Le nouveau mot de passe est désormais celui du compte.
          if (!newFields.hidden) { password.value = newPassword.value; newFields.hidden = true; }
          enrolBox.hidden = false;
          secretText.textContent = answer.secret.replace(/(.{4})/g, '$1 ').trim();
          qr.innerHTML = await bastions.qr(answer.uri);
          code.value = '';
          code.focus();
        }
      } catch (err) {
        const text = errorText(err);
        error.textContent = text === 'MOT_DE_PASSE_REQUIS' ? 'Tapez votre mot de passe.' : text;
      } finally {
        busy = false;
        submit.removeAttribute('disabled');
      }
    });
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    dialog.showModal();
    (existing ? (existing.passwordSaved ? code : password) : address).focus();
  });
}

/** Sessions qui contournent le bastion : proposer de les supprimer. */
function openBypass(host: BastionHost, b: Bastion, list: { session: Session; server: BastionServer }[]) {
  const checks = list.map(({ session, server }) => {
    const box = h('input', { type: 'checkbox', checked: true, id: `bp-${session.id}` }) as HTMLInputElement;
    return { box, session, row: h('label', { class: 'check-row' }, box, h('span', {}, h('strong', {}, session.name), ` → ${server.nom} (${MODE_LABEL[server.mode]})`)) };
  });
  const remove = h('button', { type: 'button', class: 'btn danger' }, 'Supprimer les sessions cochées');
  const keep = h('button', { type: 'button', class: 'btn' }, 'Garder');
  const { dialog } = modal('Sessions qui contournent le bastion', [
    h('p', {}, `Ces sessions se connectent directement à des serveurs que « ${b.name} » protège : elles échappent au contrôle d'accès et à l'enregistrement. Ouvrez désormais ces serveurs depuis la section du bastion.`),
    h('div', { class: 'check-list' }, ...checks.map((c) => c.row)),
    h('p', { class: 'muted small' }, 'Leurs mots de passe enregistrés seront aussi effacés.'),
  ], [keep, remove]);
  keep.addEventListener('click', () => dialog.close());
  remove.addEventListener('click', async () => {
    const ids = checks.filter((c) => c.box.checked).map((c) => c.session.id);
    if (!ids.length) return dialog.close();
    await host.removeSessions(ids);
    host.toast(`${ids.length} session(s) supprimée(s)`);
    dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

// ---------- Administration ----------

type Section = 'cibles' | 'comptes' | 'groupes' | 'regles' | 'portail' | 'reglages';
const SECTIONS: { id: Section; label: string; admin: boolean }[] = [
  { id: 'cibles', label: 'Serveurs et coffre', admin: true },
  { id: 'comptes', label: 'Comptes', admin: true },
  { id: 'groupes', label: 'Groupes', admin: true },
  { id: 'regles', label: 'Règles', admin: true },
  { id: 'portail', label: 'Portail web', admin: true },
  { id: 'reglages', label: 'Réglages', admin: true },
];
const DAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const POLICIES: [string, string][] = [
  ['', 'Réglage général'],
  ['password+totp', 'Mot de passe + code'],
  ['password+totp,key+totp', 'Mot de passe ou clé, + code'],
  ['key+totp', 'Clé SSH + code'],
  ['password', 'Mot de passe seul'],
  ['key', 'Clé SSH seule'],
];

/** Page d'administration d'un bastion (onglet). */
export function renderBastionAdmin(b: Bastion, host: BastionHost): HTMLElement {
  const isAdmin = b.role === 'admin';
  const sections = SECTIONS.filter((s) => isAdmin || !s.admin);
  let current: Section = sections[0].id;
  const nav = h('div', { class: 'seg admin-nav', role: 'tablist' });
  const content = h('div', { class: 'admin-content' });
  const call = <T = any>(method: string, path: string, body?: unknown) => bastions.admin<T>(b.id, method, path, body);
  const fail = (e: unknown) => host.toast(errorText(e) === 'SESSION_EXPIREE' ? 'Session du bastion expirée : reconnectez-vous (barre latérale).' : errorText(e), 'error');

  const show = async (id: Section) => {
    current = id;
    nav.replaceChildren(...sections.map((s) => h('button', { type: 'button', role: 'tab', class: `seg-opt${s.id === current ? ' on' : ''}`, 'aria-selected': String(s.id === current), onclick: () => show(s.id) }, s.label)));
    content.replaceChildren(h('p', { class: 'muted' }, 'Chargement…'));
    try {
      content.replaceChildren(await SECTION_RENDER[id]());
    } catch (e) {
      content.replaceChildren(h('p', { class: 'form-error' }, errorText(e)));
      fail(e);
    }
  };
  const reload = () => show(current);

  // Formulaire générique en fenêtre : les erreurs du bastion s'affichent dans la fenêtre.
  const formDialog = (title: string, body: HTMLElement[], submitLabel: string, onSubmit: () => Promise<unknown>) => {
    const submit = h('button', { type: 'submit', class: 'btn primary' }, submitLabel);
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Annuler');
    const { dialog, form, error } = modal(title, body, [cancel, submit], true);
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.setAttribute('disabled', '');
      try {
        await onSubmit();
        dialog.close();
        reload();
      } catch (err) {
        error.textContent = errorText(err);
      } finally {
        submit.removeAttribute('disabled');
      }
    });
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    (dialog.querySelector('input:not([disabled]), select, textarea') as HTMLElement | null)?.focus();
  };

  const showSecret = (title: string, text: string, value: string) => {
    const ok = h('button', { type: 'button', class: 'btn primary' }, 'J\'ai noté');
    const copy = h('button', { type: 'button', class: 'btn' }, 'Copier');
    const { dialog } = modal(title, [h('p', {}, text), h('div', { class: 'fp big' }, value), h('p', { class: 'muted small' }, 'Il ne sera plus affiché.')], [copy, ok]);
    copy.addEventListener('click', () => navigator.clipboard.writeText(value).then(() => host.toast('Copié')));
    ok.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
  };

  const select = (id: string, options: [string, string][], value: string) =>
    h('select', { id, class: 'input' }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))) as HTMLSelectElement;
  const checkbox = (id: string, label: string, on: boolean) => {
    const box = h('input', { type: 'checkbox', id, checked: on }) as HTMLInputElement;
    return { box, row: h('label', { class: 'check-row' }, box, h('span', {}, label)) };
  };
  const multi = (prefix: string, all: string[], chosen: string[]) => {
    const boxes = all.map((name) => ({ name, ...checkbox(`${prefix}-${name}`, name, chosen.includes(name)) }));
    return { el: h('div', { class: 'check-list cols' }, ...boxes.map((x) => x.row)), values: () => boxes.filter((x) => x.box.checked).map((x) => x.name) };
  };
  const table = (head: string[], rows: HTMLElement[]) =>
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)));
  const actions = (...buttons: HTMLElement[]) => h('td', { class: 'acts' }, ...buttons);
  const small = (label: string, onclick: () => void, danger = false) => h('button', { type: 'button', class: `btn sm${danger ? ' danger' : ''}`, onclick }, label);
  const toolbar = (text: string, button?: HTMLElement) => h('div', { class: 'admin-bar' }, h('p', { class: 'muted' }, text), button ?? null);

  // --- Serveurs ---
  const targetDialog = (t?: any) => {
    const nom = input({ id: 't-nom', value: t?.nom ?? '' });
    const dossier = input({ id: 't-dossier', value: t?.dossier ?? '', placeholder: 'Production, Recette…' });
    const hote = input({ id: 't-hote', value: t?.hote ?? '' });
    const port = input({ id: 't-port', value: String(t?.port ?? 22), inputmode: 'numeric' });
    const mode = select('t-mode', [['coffre', 'Coffre : compte fourni par le bastion'], ['enregistre', 'Enregistré : identifiants de l\'utilisateur'], ['rebond', 'Rebond : relais de bout en bout']], t?.mode ?? 'coffre');
    const compte = input({ id: 't-compte', value: t?.compte ?? '' });
    const secretKind = select('t-secret', [
      ...(t ? [['', t.secret === 'none' ? 'Aucun' : 'Garder le secret actuel'] as [string, string]] : [['', 'Aucun'] as [string, string]]),
      ['generer', 'Générer une clé et l\'installer sur le serveur'],
      ['mot_de_passe', 'Mot de passe du compte'],
      ['cle', 'Clé privée existante'],
    ], t ? '' : 'generer');
    const secretPass = input({ id: 't-secret-pass', type: 'password' });
    const secretKey = h('textarea', { id: 't-secret-key', class: 'input', rows: 5, spellcheck: 'false', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' }) as HTMLTextAreaElement;
    const passField = field('Mot de passe actuel du compte', secretPass, 'utilisé une seule fois');
    const keyField = field('Clé privée (sans phrase de passe)', secretKey);
    const proto = select('t-proto', [['ssh', 'SSH'], ['rdp', 'Bureau à distance (RDP)']], t?.protocole ?? 'ssh');
    const rdpNote = h('p', { class: 'muted small', hidden: true }, 'Bureau à distance : mode rebond pour l\'instant. Le bastion relaie la connexion chiffrée sans la lire ; l\'utilisateur tape ses identifiants Windows à chaque ouverture. Les modes coffre et enregistré arrivent.');
    // Port par défaut du protocole, tant que l'administrateur ne l'a pas changé.
    proto.addEventListener('change', () => {
      if (['22', '3389', ''].includes(port.value.trim())) port.value = proto.value === 'rdp' ? '3389' : '22';
      if (proto.value === 'rdp') mode.value = 'rebond';
      sync();
    });
    const sync = () => {
      const rdp = proto.value === 'rdp';
      for (const o of mode.options) o.disabled = rdp && o.value !== 'rebond';
      rdpNote.hidden = !rdp;
      const vault = mode.value === 'coffre';
      secretKind.closest('label')!.hidden = !vault;
      passField.hidden = !vault || !['generer', 'mot_de_passe'].includes(secretKind.value);
      keyField.hidden = !vault || secretKind.value !== 'cle';
      (passField.querySelector('span') as HTMLElement).firstChild!.textContent = secretKind.value === 'generer' ? 'Mot de passe actuel du compte' : 'Mot de passe du compte';
    };
    mode.addEventListener('change', sync);
    secretKind.addEventListener('change', sync);
    const body = [
      field('Protocole', proto),
      h('div', { class: 'row2' }, field('Nom', nom, 'sans espace'), field('Dossier', dossier)),
      h('div', { class: 'quick-row' }, field('Adresse', hote), field('Port', port)),
      field('Mode', mode), rdpNote, field('Compte sur le serveur', compte, 'obligatoire en mode coffre ; en Bureau à distance : DOMAINE\\compte, proposé à l\'ouverture'),
      field('Secret du coffre', secretKind), passField, keyField,
      h('p', { class: 'muted small' }, 'Le secret est chiffré par le bastion et ne se relit jamais. « Générer » crée une clé, l\'installe avec le mot de passe donné une seule fois, puis vérifie qu\'elle fonctionne.'),
    ];
    setTimeout(sync);
    formDialog(t ? `Modifier ${t.nom}` : 'Ajouter un serveur', body, t ? 'Enregistrer' : 'Ajouter', async () => {
      const kind = mode.value === 'coffre' ? secretKind.value : '';
      const secret = kind === 'generer' ? { type: 'generer', mot_de_passe: secretPass.value }
        : kind === 'mot_de_passe' ? { type: 'mot_de_passe', valeur: secretPass.value }
        : kind === 'cle' ? { type: 'cle', valeur: secretKey.value } : undefined;
      const payload = {
        nom: nom.value.trim(), dossier: dossier.value.trim(), hote: hote.value.trim(), port: Number(port.value) || (proto.value === 'rdp' ? 3389 : 22),
        mode: mode.value, compte: compte.value.trim() || null, secret, protocole: proto.value,
      };
      await (t ? call('PUT', `/admin/cibles/${t.id}`, payload) : call('POST', '/admin/cibles', payload));
      host.toast(t ? 'Serveur modifié' : 'Serveur ajouté');
    });
  };

  const SECTION_RENDER: Record<Section, () => Promise<HTMLElement>> = {
    cibles: async () => {
      const { cibles } = await call<{ cibles: any[] }>('GET', '/admin/cibles');
      const rows = cibles.map((t) => h('tr', {},
        h('td', {}, h('strong', {}, t.nom)), h('td', {}, t.dossier), h('td', {}, h('code', {}, `${t.hote}:${t.port}`)),
        h('td', {}, t.protocole === 'rdp' ? h('span', { class: 'badge proto-rdp' }, 'RDP') : null, h('span', { class: `badge mode-${t.mode}` }, MODE_LABEL[t.mode as BastionServer['mode']])), h('td', {}, t.compte ?? '—'),
        h('td', {}, t.secret === 'key' ? 'Clé SSH' : t.secret === 'password' ? 'Mot de passe' : '—'),
        h('td', { title: t.empreinte ?? '' }, t.empreinte ? 'connue' : 'à la 1ʳᵉ connexion'),
        actions(small('Modifier', () => targetDialog(t)),
          small('Oublier l\'empreinte', async () => {
            if (!confirm(`Oublier l'empreinte de ${t.nom} ? À faire seulement après la réinstallation du serveur.`)) return;
            await call('POST', `/admin/cibles/${t.id}/oublier-empreinte`).catch(fail); reload();
          }),
          small('Supprimer', async () => {
            if (!confirm(`Supprimer le serveur ${t.nom} ? Son secret est effacé ; l'historique des sessions est gardé.`)) return;
            await call('DELETE', `/admin/cibles/${t.id}`).catch(fail); reload();
          }, true))));
      return h('div', { class: 'admin-section' },
        toolbar(`${cibles.length} serveur(s). Chaque modification est tracée dans le journal.`, h('button', { class: 'btn primary', onclick: () => targetDialog() }, 'Ajouter un serveur')),
        table(['Serveur', 'Dossier', 'Adresse', 'Mode', 'Compte', 'Secret', 'Empreinte', ''], rows));
    },

    comptes: async () => {
      const [{ comptes, politique_generale }, { groupes }] = await Promise.all([call<{ comptes: any[]; politique_generale: string }>('GET', '/admin/comptes'), call<{ groupes: any[] }>('GET', '/admin/groupes')]);
      const groupNames = groupes.map((g) => g.nom);
      const userDialog = (u?: any) => {
        const login = input({ id: 'u-login', value: u?.login ?? '', disabled: !!u });
        const role = select('u-role', [['user', 'Utilisateur'], ['auditor', 'Auditeur (lecture du journal)'], ['admin', 'Administrateur']], u?.role ?? 'user');
        const known = POLICIES.some(([v]) => v === (u?.politique ?? ''));
        const policy = select('u-policy', known ? POLICIES : [...POLICIES, [u.politique, u.politique]], u?.politique ?? '');
        const groups = multi('u-g', groupNames, u?.groupes ?? []);
        const disabled = checkbox('u-disabled', 'Compte désactivé', !!u?.desactive);
        formDialog(u ? `Modifier ${u.login}` : 'Créer un compte', [
          h('div', { class: 'row2' }, field('Identifiant', login), field('Rôle', role)),
          field('Connexion', policy, `général : ${politique_generale}`),
          h('div', { class: 'fld' }, h('span', {}, 'Groupes'), groupNames.length ? groups.el : h('p', { class: 'muted small' }, 'Aucun groupe : créez-en dans l\'onglet Groupes.')),
          u ? disabled.row : h('p', { class: 'muted small' }, 'Un mot de passe provisoire sera affiché une fois. Le code sera enrôlé par l\'utilisateur à sa première connexion dans Portunia.'),
        ], u ? 'Enregistrer' : 'Créer', async () => {
          const payload = { login: login.value.trim(), role: role.value, politique: policy.value || null, groupes: groups.values(), desactive: disabled.box.checked };
          if (u) {
            await call('PUT', `/admin/comptes/${u.id}`, payload);
            host.toast('Compte modifié');
          } else {
            const r = await call<{ mot_de_passe_provisoire: string }>('POST', '/admin/comptes', payload);
            setTimeout(() => showSecret('Compte créé', `Mot de passe provisoire de ${payload.login}, à lui transmettre :`, r.mot_de_passe_provisoire));
          }
        });
      };
      const keyDialog = (u: any) => {
        const key = h('textarea', { id: 'k-key', class: 'input', rows: 3, spellcheck: 'false', placeholder: 'ssh-ed25519 AAAA… commentaire' }) as HTMLTextAreaElement;
        formDialog(`Clé SSH de ${u.login}`, [field('Clé publique', key)], 'Ajouter', async () => {
          const r = await call<{ empreinte: string }>('POST', `/admin/comptes/${u.id}/cles`, { cle: key.value });
          host.toast(`Clé ajoutée : ${r.empreinte}`);
        });
      };
      const rows = comptes.map((u) => h('tr', { class: u.desactive ? 'off' : '' },
        h('td', {}, h('strong', {}, u.login)), h('td', {}, roleLabel(u.role)), h('td', {}, u.groupes.join(', ') || '—'),
        h('td', {}, POLICIES.find(([v]) => v === (u.politique ?? ''))?.[1] ?? u.politique),
        h('td', {}, u.mot_de_passe_provisoire ? h('span', { class: 'chip warn' }, 'mot de passe provisoire') : u.code_enrole ? h('span', { class: 'chip ok' }, 'code enrôlé') : h('span', { class: 'chip warn' }, 'à la 1ʳᵉ connexion'),
          u.desactive ? h('span', { class: 'chip off' }, 'désactivé') : null),
        actions(small('Modifier', () => userDialog(u)),
          small('Mot de passe provisoire', async () => {
            if (!confirm(`Donner un nouveau mot de passe provisoire à ${u.login} ? Ses sessions Portunia seront fermées.`)) return;
            try { const r = await call<{ mot_de_passe_provisoire: string }>('POST', `/admin/comptes/${u.id}/mot-de-passe-provisoire`); showSecret('Nouveau mot de passe provisoire', `Pour ${u.login} :`, r.mot_de_passe_provisoire); } catch (e) { fail(e); }
            reload();
          }),
          small('Réinitialiser le code', async () => {
            if (!confirm(`Réinitialiser le code de ${u.login} ? Il l'enrôlera de nouveau à sa prochaine connexion.`)) return;
            await call('POST', `/admin/comptes/${u.id}/reinitialiser-code`).catch(fail); reload();
          }),
          small('Clé SSH', () => keyDialog(u)),
          small('Supprimer', async () => {
            if (!confirm(`Supprimer le compte ${u.login} ? L'historique de ses sessions est gardé.`)) return;
            await call('DELETE', `/admin/comptes/${u.id}`).catch(fail); reload();
          }, true))));
      return h('div', { class: 'admin-section' },
        toolbar(`${comptes.length} compte(s).`, h('button', { class: 'btn primary', onclick: () => userDialog() }, 'Créer un compte')),
        table(['Compte', 'Rôle', 'Groupes', 'Connexion', 'État', ''], rows));
    },

    groupes: async () => {
      const { groupes } = await call<{ groupes: any[] }>('GET', '/admin/groupes');
      const add = () => {
        const nom = input({ id: 'g-nom' });
        formDialog('Créer un groupe', [field('Nom', nom)], 'Créer', async () => { await call('POST', '/admin/groupes', { nom: nom.value }); });
      };
      const rows = groupes.map((g) => h('tr', {},
        h('td', {}, h('strong', {}, g.nom)), h('td', {}, g.membres.join(', ') || '—'),
        actions(small('Supprimer', async () => {
          if (!confirm(`Supprimer le groupe ${g.nom} ? Ses règles seront supprimées aussi.`)) return;
          await call('DELETE', `/admin/groupes/${g.id}`).catch(fail); reload();
        }, true))));
      return h('div', { class: 'admin-section' },
        toolbar('Les membres se choisissent dans la fiche de chaque compte.', h('button', { class: 'btn primary', onclick: add }, 'Créer un groupe')),
        table(['Groupe', 'Membres', ''], rows));
    },

    regles: async () => {
      const [{ regles }, { groupes }, { cibles }] = await Promise.all([call<{ regles: any[] }>('GET', '/admin/regles'), call<{ groupes: any[] }>('GET', '/admin/groupes'), call<{ cibles: any[] }>('GET', '/admin/cibles')]);
      const ruleDialog = (r?: any) => {
        const nom = input({ id: 'r-nom', value: r?.nom ?? '' });
        const groupe = select('r-groupe', groupes.map((g) => [g.nom, g.nom] as [string, string]), r?.groupe ?? groupes[0]?.nom ?? '');
        const servers = multi('r-c', cibles.map((c) => c.nom), r?.cibles ?? []);
        const days = DAYS.map((d, i) => {
          const box = h('input', { type: 'checkbox', id: `r-d${i}`, checked: (((r?.jours ?? 127) >> i) & 1) === 1 }) as HTMLInputElement;
          return { box, el: h('label', { class: 'day', title: DAY_NAMES[i] }, box, h('span', {}, d)) };
        });
        const from = input({ id: 'r-from', type: 'number', min: 0, max: 23, value: r?.heure_debut ?? '', placeholder: 'toute la journée' });
        const to = input({ id: 'r-to', type: 'number', min: 1, max: 24, value: r?.heure_fin ?? '' });
        const sftp = checkbox('r-sftp', 'Transferts de fichiers (SFTP, scp)', r?.sftp ?? false);
        const tunnels = checkbox('r-tunnels', 'Tunnels (redirection de ports)', r?.tunnels ?? false);
        const keys = checkbox('r-frappe', 'Enregistrer aussi la frappe (capte les mots de passe tapés)', r?.frappe ?? false);
        const expire = input({ id: 'r-expire', type: 'date', lang: 'fr', value: r?.expire ? String(r.expire).slice(0, 10) : '' });
        if (!groupes.length) return host.toast('Créez d\'abord un groupe (onglet Groupes)', 'error');
        formDialog(r ? `Modifier la règle ${r.nom}` : 'Nouvelle règle', [
          h('div', { class: 'row2' }, field('Nom', nom), field('Groupe', groupe)),
          h('div', { class: 'fld' }, h('span', {}, 'Serveurs'), servers.el),
          h('div', { class: 'fld' }, h('span', {}, 'Jours'), h('div', { class: 'days' }, ...days.map((d) => d.el))),
          h('div', { class: 'row2' }, field('De (heure)', from), field('À (heure)', to)),
          sftp.row, tunnels.row, keys.row,
          field('Expire le', expire, 'vide = jamais'),
        ], r ? 'Enregistrer' : 'Créer', async () => {
          const mask = days.reduce((m, d, i) => m | (d.box.checked ? 1 << i : 0), 0);
          const payload = {
            nom: nom.value.trim(), groupe: groupe.value, cibles: servers.values(), sftp: sftp.box.checked, tunnels: tunnels.box.checked, frappe: keys.box.checked,
            jours: mask, heure_debut: from.value === '' ? null : Number(from.value), heure_fin: to.value === '' ? null : Number(to.value), expire: expire.value || null,
          };
          await (r ? call('PUT', `/admin/regles/${r.id}`, payload) : call('POST', '/admin/regles', payload));
        });
      };
      const when = (r: any) => {
        const d = r.jours === 127 ? 'Tous les jours' : DAY_NAMES.filter((_, i) => (r.jours >> i) & 1).map((x) => x.slice(0, 3)).join(', ');
        return r.heure_debut != null ? `${d} · ${r.heure_debut} h-${r.heure_fin} h` : d;
      };
      const stateChip = (s: string) => h('span', { class: `chip ${s === 'active' ? 'ok' : s === 'expiree' ? 'off' : 'warn'}` }, s === 'active' ? 'active' : s === 'expiree' ? 'expirée' : 'hors plage');
      const rows = regles.map((r) => h('tr', {},
        h('td', {}, h('strong', {}, r.nom)), h('td', {}, r.groupe), h('td', {}, r.cibles.join(', ')), h('td', {}, when(r)),
        h('td', {}, [r.sftp && 'SFTP', r.tunnels && 'tunnels', r.frappe && 'frappe'].filter(Boolean).join(', ') || '—'),
        h('td', {}, stateChip(r.etat), r.expire ? h('span', { class: 'muted small' }, ` jusqu'au ${new Date(r.expire).toLocaleDateString('fr-FR')}`) : null),
        actions(small('Modifier', () => ruleDialog(r)), small('Supprimer', async () => {
          if (!confirm(`Supprimer la règle ${r.nom} ?`)) return;
          await call('DELETE', `/admin/regles/${r.id}`).catch(fail); reload();
        }, true))));
      return h('div', { class: 'admin-section' },
        toolbar('Tout ce qu\'aucune règle ne permet est refusé. Une modification s\'applique à la prochaine ouverture de session.', h('button', { class: 'btn primary', onclick: () => ruleDialog() }, 'Nouvelle règle')),
        table(['Règle', 'Groupe', 'Serveurs', 'Quand', 'Options', 'État', ''], rows));
    },

    portail: async () => {
      let p: any;
      try {
        p = await call<any>('GET', '/admin/portail');
      } catch (e) {
        // Bastion antérieur à la 0.7 : pas de portail.
        if (/404|Not Found/i.test(errorText(e))) return h('div', { class: 'admin-section' }, toolbar('Le portail web demande Heimdia 0.7 ou plus récent : mettez le bastion à jour (sudo bash installer.sh mise-a-jour).'));
        throw e;
      }
      const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(p.actif), 'aria-label': 'Portail web' });
      const state = h('strong', { class: p.actif ? 'ok-text' : 'muted' }, p.actif ? 'activé' : 'désactivé');
      sw.addEventListener('click', async () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        if (!on && p.sessions_en_cours > 0 && !confirm(`Désactiver le portail ferme les ${p.sessions_en_cours} session(s) web en cours. Continuer ?`)) return;
        if (on && !p.url) host.toast('Indiquez d\'abord l\'adresse publique du portail, puis enregistrez.', 'info');
        try { await call('PUT', '/admin/portail', { actif: on }); host.toast(on ? 'Portail web activé' : 'Portail web désactivé'); reload(); } catch (e) { fail(e); }
      });
      const tunnel = { relie: ['ok', 'relié'], deconnecte: ['warn', 'installé, non relié'], absent: ['off', 'non installé'] }[p.tunnel as string] ?? ['off', p.tunnel];
      const stat = (value: string | number, label: string) => h('div', { class: 'portal-stat' }, h('b', {}, String(value)), h('span', {}, label));
      const closeAll = small('Fermer toutes les sessions web', async () => {
        if (!confirm('Fermer toutes les sessions web en cours ? Les utilisateurs devront se reconnecter.')) return;
        try { const r = await call<any>('POST', '/admin/portail/fermer-sessions'); host.toast(`${r.fermees} terminal(aux) fermé(s)`); reload(); } catch (e) { fail(e); }
      }, true);

      const url = input({ id: 'p-url', value: p.url, placeholder: 'https://acces.votre-domaine.fr' });
      const groupe = select('p-groupe', [...new Set([p.groupe, ...p.groupes])].filter(Boolean).map((g: string) => [g, g] as [string, string]), p.groupe);
      const duree = select('p-duree', [['1', '1 heure'], ['4', '4 heures'], ['8', '8 heures']].concat([1, 4, 8].includes(p.duree_h) ? [] : [[String(p.duree_h), `${p.duree_h} heures`]]) as [string, string][], String(p.duree_h));
      const idle = select('p-idle', [['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 heure']].concat([15, 30, 60].includes(p.inactivite_min) ? [] : [[String(p.inactivite_min), `${p.inactivite_min} minutes`]]) as [string, string][], String(p.inactivite_min));
      const clip = checkbox('p-clip', 'Copier-coller du texte dans le terminal', p.presse_papiers);
      const site = input({ id: 'p-site', value: p.turnstile_site, placeholder: '0x4AAAAAA…' });
      const secret = input({ id: 'p-secret', type: 'password', placeholder: p.turnstile_secret_defini ? 'Garder la clé secrète actuelle' : '0x4AAAAAA…' });
      const groupMissing = !p.groupes.includes(p.groupe);
      const save = h('button', { class: 'btn primary', onclick: async () => {
        const body: Record<string, unknown> = {
          url: url.value.trim(), groupe: groupe.value, duree_h: Number(duree.value), inactivite_min: Number(idle.value),
          presse_papiers: clip.box.checked, turnstile_site: site.value.trim(),
        };
        if (secret.value.trim()) body.turnstile_secret = secret.value.trim();
        if (!site.value.trim() && p.turnstile_secret_defini) body.turnstile_secret = '';
        try { await call('PUT', '/admin/portail', body); host.toast('Portail web enregistré'); reload(); } catch (e) { fail(e); }
      } }, 'Enregistrer');

      return h('div', { class: 'admin-section form-narrow' },
        h('div', { class: 'portal-head' }, sw, h('div', {},
          h('div', {}, h('b', {}, 'Portail web'), ' · ', state),
          h('p', { class: 'muted small' }, 'Accès aux serveurs SSH depuis un navigateur, sans Portunia, derrière Cloudflare. Désactivé : la page affiche « Portail fermé » et les sessions web en cours se ferment.'))),
        h('div', { class: 'portal-stats' },
          stat(p.sessions_en_cours, 'sessions web en cours'), stat(p.connexions_jour, 'connexions aujourd\'hui'), stat(p.echecs_jour, 'échecs aujourd\'hui'),
          h('div', { class: 'portal-stat' }, h('b', { class: `chip ${tunnel[0]}` }, tunnel[1]), h('span', {}, 'tunnel Cloudflare'))),
        h('div', {}, closeAll),
        h('h3', {}, 'Adresse'),
        field('Adresse publique', url, 'celle que Cloudflare publie ; vérifiée à chaque connexion'),
        h('p', { class: 'muted small' }, `Le bastion sert le portail sur ${p.ecoute.tunnel} (Cloudflare Tunnel)${p.ecoute.proxy ? ` et ${p.ecoute.proxy} en HTTPS (proxy Cloudflare, adresses de Cloudflare seulement)` : ''}. Installer le tunnel : sudo bash installer.sh portail.`),
        h('h3', {}, 'Qui et combien de temps'),
        field('Groupe autorisé', groupe, groupMissing ? `le groupe « ${p.groupe} » n'existe pas encore : créez-le dans Groupes et ajoutez-y les comptes` : 'seuls ses membres peuvent se connecter au portail'),
        h('div', { class: 'row2' }, field('Durée d\'une session web', duree), field('Fermeture après inactivité', idle)),
        clip.row,
        h('p', { class: 'muted small' }, 'Toujours exigés sur le portail : mot de passe et code. Première connexion et code perdu se font dans Portunia. Serveurs en mode rebond et Bureau à distance : seulement avec Portunia pour l\'instant.'),
        h('h3', {}, 'Anti-robots (Cloudflare Turnstile)'),
        h('div', { class: 'row2' }, field('Clé du site', site), field('Clé secrète', secret, 'gardée chiffrée par le bastion')),
        h('div', {}, save));
    },

    reglages: async () => {
      const r = await call<any>('GET', '/admin/reglages');
      const nom = input({ id: 's-nom', value: r.nom });
      const banner = h('textarea', { id: 's-banner', class: 'input', rows: 3 }, r.banniere) as HTMLTextAreaElement;
      const policy = select('s-policy', POLICIES.slice(1).some(([v]) => v === r.politique) ? POLICIES.slice(1) : [...POLICIES.slice(1), [r.politique, r.politique]], r.politique);
      const hours = input({ id: 's-hours', type: 'number', min: 1, max: 168, value: r.duree_session_h });
      const memo = checkbox('s-memo', 'Autoriser Portunia à mémoriser le mot de passe (le code reste demandé)', r.memo_mot_de_passe);
      const own = checkbox('s-own', 'Chaque compte peut relire ses propres sessions (menu « Mes sessions » du bastion)', !!r.relecture_propres);
      const sensitive = h('textarea', { id: 's-sensitive', class: 'input', rows: 4, spellcheck: 'false' }, (r.commandes_sensibles ?? []).join('\n')) as HTMLTextAreaElement;
      const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
        try {
          await call('PUT', '/admin/reglages', {
            nom: nom.value, banniere: banner.value, politique: policy.value, duree_session_h: Number(hours.value), memo_mot_de_passe: memo.box.checked,
            relecture_propres: own.box.checked, commandes_sensibles: sensitive.value.split('\n').map((x) => x.trim()).filter(Boolean),
          });
          host.toast('Réglages enregistrés');
        } catch (e) { fail(e); }
      } }, 'Enregistrer');
      return h('div', { class: 'admin-section form-narrow' },
        field('Nom du bastion', nom, 'affiché dans Portunia et l\'application d\'authentification'),
        field('Bannière de connexion', banner, 'avertissement légal affiché avant l\'identification'),
        field('Connexion par défaut des comptes', policy),
        field('Durée d\'une session dans Portunia (heures)', hours),
        memo.row,
        h('h3', {}, 'Relecture des sessions'),
        own.row,
        field('Commandes sensibles', sensitive, 'une par ligne ; repérées en rouge sur la barre de temps du lecteur'),
        h('div', {}, saveBtn));
    },
  };

  show(current);
  return h('div', { class: 'ext-page bastion-admin' },
    h('header', {}, h('h2', {}, `Administration · ${b.name}`), h('p', { class: 'muted' }, `${b.host} · connecté en tant que ${b.login} (${roleLabel(b.role)})`)),
    nav, content);
}
