// Extension Heimdia : bastions dans la barre latérale, connexion (avec première connexion
// et enrôlement du code), ouverture des serveurs et administration du bastion.
import { Bastion, BastionLoginAnswer, bastions, BastionServer, errorText, Manifest, Session } from './api';
import { h, icon } from './dom';
import { MenuItem, showMenu } from './menu';
import { LOCALE, t } from './i18n';

/** Heimdia apparaît dans la page Extensions comme les protocoles. */
export const HEIMDIA_EXTENSION: Manifest = {
  id: 'heimdia',
  name: 'Heimdia (bastion)',
  version: '1.0.0',
  description: t('Servers protected by a Heimdia bastion: sign-in with a code, servers in the sidebar, sessions recorded by the bastion, administration.', 'Serveurs protégés par un bastion Heimdia : connexion avec code, serveurs dans la barre latérale, sessions enregistrées par le bastion, administration.'),
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

const MODE_LABEL: Record<BastionServer['mode'], string> = { coffre: t('Vault', 'Coffre'), enregistre: t('Recorded', 'Enregistré'), rebond: t('Jump', 'Rebond') };
const MODE_TITLE: Record<BastionServer['mode'], string> = {
  coffre: t('Account provided by the bastion, session recorded', 'Compte fourni par le bastion, session enregistrée'),
  enregistre: t('Session recorded by the bastion; your credentials are asked in the terminal', 'Session enregistrée par le bastion ; vos identifiants sont demandés dans le terminal'),
  rebond: t('End-to-end relay through the bastion: nothing is recorded', 'Relais de bout en bout par le bastion : rien n\'est enregistré'),
};
const COLLAPSED_KEY = 'portunia.bastions.replis';

function remaining(expires: string): string {
  const ms = Date.parse(expires) - Date.now();
  if (!(ms > 0)) return t('session expired', 'session expirée');
  const m = Math.round(ms / 60000);
  return m >= 60 ? t(`expires in ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`, `expire dans ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`) : t(`expires in ${m} min`, `expire dans ${m} min`);
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
      this.host.toast(t(`Bastion « ${b.name} » added`, `Bastion « ${b.name} » ajouté`));
      await this.load();
    }
  }

  render() {
    const filter = this.host.filter().trim().toLowerCase();
    const head = h('div', { class: 'sidebar-head' },
      h('span', { class: 'label' }, 'Bastions'),
      h('div', { class: 'head-actions' },
        h('button', { class: 'icon-btn', 'aria-label': t('Add a Heimdia bastion', 'Ajouter un bastion Heimdia'), title: t('Add a Heimdia bastion', 'Ajouter un bastion Heimdia'), onclick: () => this.add() }, icon('plus'))));
    const body = h('div', { class: 'bastion-list' });
    if (!this.list.length) {
      body.append(h('div', { class: 'empty-tree' },
        h('span', { class: 'small' }, t('No bastion. A Heimdia bastion protects access to your servers.', 'Aucun bastion. Un bastion Heimdia protège l\'accès à vos serveurs.')),
        h('button', { class: 'btn', onclick: () => this.add() }, t('Add a bastion', 'Ajouter un bastion'))));
    }
    for (const b of this.list) body.append(...this.renderBastion(b, filter));
    this.root.replaceChildren(head, body);
  }

  private menu(b: Bastion): (MenuItem | 'separator')[] {
    return [
      b.connected
        ? { label: t('Refresh the list', 'Actualiser la liste'), icon: 'refresh', action: () => this.refresh(b.id) }
        : { label: t('Sign in again', 'Se reconnecter'), icon: 'lock', action: () => this.reconnect(b.id) },
      ...(b.role === 'admin' && b.connected ? [{ label: t('Administer', 'Administrer'), icon: 'settings', action: () => this.host.openAdmin(b) }] : []),
      ...((b.role === 'admin' || b.role === 'auditor' || b.ownReplay) && b.connected
        ? [{ label: b.role === 'user' ? t('My sessions', 'Mes sessions') : 'Audit', icon: 'play', action: () => this.host.openAudit(b) }] : []),
      { label: t(`Copy the certificate fingerprint`, `Copier l'empreinte du certificat`), icon: 'copy', action: () => navigator.clipboard.writeText(b.apiFingerprint) },
      'separator',
      ...(b.connected ? [{ label: t('Sign out', 'Se déconnecter'), icon: 'power', action: async () => { await bastions.logout(b.id).catch(() => {}); this.load(); } }] : []),
      {
        label: t('Remove this bastion', 'Retirer ce bastion'), icon: 'trash', danger: true, action: async () => {
          if (!confirm(t(`Remove the bastion « ${b.name} » from Portunia? Its token and server list will be erased from this PC.`, `Retirer le bastion « ${b.name} » de Portunia ? Son jeton et sa liste de serveurs seront effacés de ce PC.`))) return;
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
        class: 'bastion-main', title: b.connected ? `${b.host} · ${b.login} (${roleLabel(b.role)})` : t('Sign in again', 'Se reconnecter'),
        onclick: () => (b.connected ? this.toggle(b.id) : this.reconnect(b.id)),
      },
        h('span', { class: `led ${state}` }),
        h('span', { class: 'grow' },
          h('span', { class: 'bastion-name ellipsis' }, b.name),
          h('span', { class: 'bastion-sub ellipsis' }, b.connected ? `${b.login} · ${remaining(b.expires)}` : t('session expired · click to sign in again', 'session expirée · cliquer pour se reconnecter')))),
      h('button', { class: 'icon-btn sm', 'aria-label': t(`Actions for bastion ${b.name}`, `Actions du bastion ${b.name}`), title: t('More actions', 'Plus d\'actions'), onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY, this.menu(b)) }, icon('more', 14)));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, this.menu(b)); });
    const out: HTMLElement[] = [card];
    if (this.collapsed.has(b.id) && !filter) return out;

    const bypass = b.connected ? bypassing(b, this.host.sessions()) : [];
    if (bypass.length) {
      out.push(h('button', { class: 'bastion-warn', onclick: () => openBypass(this.host, b, bypass) },
        t(`${bypass.length} session(s) go directly to servers of this bastion`, `${bypass.length} session(s) vont directement sur des serveurs de ce bastion`)));
    }
    const servers = b.servers.filter((s) => !filter || s.nom.toLowerCase().includes(filter) || s.dossier.toLowerCase().includes(filter));
    const groups = new Map<string, BastionServer[]>();
    for (const s of servers) groups.set(s.dossier, [...(groups.get(s.dossier) ?? []), s]);
    for (const [folder, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (folder) out.push(h('div', { class: 'tree-row' }, h('span', { class: 'tree-item group-head bastion-folder' }, icon('folder', 14), h('span', { class: 'grow ellipsis' }, folder), h('span', { class: 'count' }, String(list.length)))));
      for (const s of list) out.push(this.renderServer(b, s, folder ? 1 : 0));
    }
    if (b.connected && !b.servers.length) out.push(h('p', { class: 'muted small bastion-empty' }, t('No server is allowed for you at the moment.', 'Aucun serveur ne vous est autorisé en ce moment.')));
    return out;
  }

  private renderServer(b: Bastion, s: BastionServer, depth: number): HTMLElement {
    const rdp = s.protocole === 'rdp';
    // Sans l'extension Bureau à distance, le serveur reste visible mais ne s'ouvre pas.
    const missing = rdp && !this.host.protocolEnabled('rdp');
    const open = () => {
      if (missing) return this.host.toast(t('Enable the Remote Desktop extension (Extensions) to open this server', 'Activez l’extension Bureau à distance (Extensions) pour ouvrir ce serveur'), 'error');
      return b.connected ? this.host.openServer(b, s) : this.reconnect(b.id).then((ok) => ok && this.host.openServer(b, s));
    };
    const command = rdp ? `${s.hote}:${s.port}` : `ssh -p ${b.sshPort} ${b.login}%${s.nom}@${b.host}`;
    const menu = (): (MenuItem | 'separator')[] => [
      { label: t('Open', 'Ouvrir'), icon: 'play', action: open },
      rdp
        ? { label: t('Copy the server address', 'Copier l\'adresse du serveur'), icon: 'copy', action: () => navigator.clipboard.writeText(command) }
        : { label: t('Copy the ssh command', 'Copier la commande ssh'), icon: 'copy', action: () => navigator.clipboard.writeText(command) },
    ];
    const title = missing ? t('Enable the Remote Desktop extension to open this server', 'Activez l’extension Bureau à distance pour ouvrir ce serveur') : t(`${rdp ? 'Remote Desktop · ' : ''}${MODE_TITLE[s.mode]}\n${command}`, `${rdp ? 'Bureau à distance · ' : ''}${MODE_TITLE[s.mode]}\n${command}`);
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

    const address = input({ id: 'b-address', placeholder: t('bastion.example.com or 192.168.1.10:8443', 'bastion.exemple.fr ou 192.168.1.10:8443'), value: existing ? `${existing.host}:${existing.apiPort}` : '' });
    const fingerprintBox = h('div', { class: 'fp', hidden: !existing }, existing?.apiFingerprint ?? '');
    const fingerprintField = h('div', { class: 'fld', hidden: true },
      h('span', {}, t('Certificate fingerprint', 'Empreinte du certificat'), h('span', { class: 'muted small' }, t(' to compare with the one given at install (or « sudo heimdia info » on the bastion)', ' à comparer avec celle donnée à l\'installation (ou « sudo heimdia info » sur le bastion)'))), fingerprintBox);
    const login = input({ id: 'b-login', value: existing?.login ?? '', autocomplete: 'username' });
    const password = input({ id: 'b-password', type: 'password', autocomplete: 'current-password', placeholder: existing?.passwordSaved ? t('Remembered: leave empty', 'Mémorisé : laisser vide') : '' });
    const code = input({ id: 'b-code', inputmode: 'numeric', placeholder: '6 chiffres', maxlength: 7 });
    const newPassword = input({ id: 'b-new', type: 'password', autocomplete: 'new-password', placeholder: t('10 characters minimum', '10 caractères minimum') });
    const confirmPassword = input({ id: 'b-confirm', type: 'password', autocomplete: 'new-password' });
    const remember = h('input', { type: 'checkbox', id: 'b-remember', checked: !!existing?.passwordSaved }) as HTMLInputElement;
    const rememberRow = h('label', { class: 'check-row', hidden: true }, remember, h('span', {}, t('Remember my password on this PC (the code is still asked)', 'Mémoriser mon mot de passe sur ce PC (le code reste demandé)')));
    const qr = h('div', { class: 'qr-box' });
    const secretText = h('code', { class: 'fp' });
    const enrolBox = h('div', { class: 'enrol', hidden: true },
      h('p', {}, t('First sign-in: scan this code with your authenticator app (Microsoft Authenticator, Google Authenticator…), then type the 6-digit code it shows.', 'Première connexion : scannez ce code avec votre application d\'authentification (Microsoft Authenticator, Google Authenticator…), puis tapez le code à 6 chiffres qu\'elle affiche.')),
      h('div', { class: 'enrol-row' }, qr, h('div', { class: 'enrol-side' }, h('span', { class: 'muted small' }, t('Or type this key:', 'Ou saisissez cette clé :')), secretText)));
    const credFields = h('div', { class: 'fld-group', hidden: !existing },
      h('div', { class: 'row2' }, field(t('Login', 'Identifiant'), login), field(t('Password', 'Mot de passe'), password)));
    const codeField = field(t('Authenticator app code', 'Code de l\'application d\'authentification'), code, t('if asked; empty at first sign-in', 'si demandé ; vide à la première connexion'));
    const newFields = h('div', { class: 'fld-group', hidden: true },
      h('p', { class: 'muted' }, t('Your password is temporary: choose a new one.', 'Votre mot de passe est provisoire : choisissez-en un nouveau.')),
      h('div', { class: 'row2' }, field(t('New password', 'Nouveau mot de passe'), newPassword), field(t('Confirmation', 'Confirmation'), confirmPassword)));
    const intro = h('p', { class: 'muted' }, existing ? t(`Session expired: sign in to ${existing.name} again.`, `Session expirée : reconnectez-vous à ${existing.name}.`) : t('Bastion address (port 8443 by default).', 'Adresse du bastion (port 8443 par défaut).'));
    const submit = h('button', { type: 'submit', class: 'btn primary' }, existing ? t('Connect', 'Se connecter') : t('Continue', 'Continuer'));
    const cancel = h('button', { type: 'button', class: 'btn' }, t('Cancel', 'Annuler'));
    const { dialog, form, error } = modal(existing ? `Reconnexion · ${existing.name}` : t('Add a Heimdia bastion', 'Ajouter un bastion Heimdia'), [
      intro, existing ? h('span') : field(t('Address', 'Adresse'), address), fingerprintField, credFields, newFields, enrolBox, codeField, rememberRow,
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
          intro.textContent = t(`${probe.info.nom} · Heimdia ${probe.info.version}. Check the fingerprint before sending your password.`, `${probe.info.nom} · Heimdia ${probe.info.version}. Vérifiez l'empreinte avant d'envoyer votre mot de passe.`);
          address.disabled = true;
          credFields.hidden = false;
          codeField.hidden = false;
          rememberRow.hidden = !rememberAllowed;
          submit.textContent = 'L\'empreinte correspond, se connecter';
          login.focus();
          return;
        }
        if (!newFields.hidden && newPassword.value !== confirmPassword.value) throw new Error(t('The two new passwords differ', 'Les deux nouveaux mots de passe diffèrent'));
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
          error.textContent = t('Type the code shown by your authenticator app.', 'Tapez le code affiché par votre application d\'authentification.');
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
        error.textContent = text === 'MOT_DE_PASSE_REQUIS' ? t('Type your password.', 'Tapez votre mot de passe.') : text;
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
  const remove = h('button', { type: 'button', class: 'btn danger' }, t('Delete the checked sessions', 'Supprimer les sessions cochées'));
  const keep = h('button', { type: 'button', class: 'btn' }, t('Keep', 'Garder'));
  const { dialog } = modal(t('Sessions that bypass the bastion', 'Sessions qui contournent le bastion'), [
    h('p', {}, t(`These sessions connect directly to servers that « ${b.name} » protects: they escape access control and recording. From now on, open these servers from the bastion's section.`, `Ces sessions se connectent directement à des serveurs que « ${b.name} » protège : elles échappent au contrôle d'accès et à l'enregistrement. Ouvrez désormais ces serveurs depuis la section du bastion.`)),
    h('div', { class: 'check-list' }, ...checks.map((c) => c.row)),
    h('p', { class: 'muted small' }, t('Their saved passwords will also be erased.', 'Leurs mots de passe enregistrés seront aussi effacés.')),
  ], [keep, remove]);
  keep.addEventListener('click', () => dialog.close());
  remove.addEventListener('click', async () => {
    const ids = checks.filter((c) => c.box.checked).map((c) => c.session.id);
    if (!ids.length) return dialog.close();
    await host.removeSessions(ids);
    host.toast(t(`${ids.length} session(s) deleted`, `${ids.length} session(s) supprimée(s)`));
    dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

// ---------- Administration ----------

type Section = 'cibles' | 'comptes' | 'groupes' | 'regles' | 'portail' | 'assistance' | 'reglages';
const SECTIONS: { id: Section; label: string; admin: boolean }[] = [
  { id: 'cibles', label: t('Servers and vault', 'Serveurs et coffre'), admin: true },
  { id: 'comptes', label: t('Accounts', 'Comptes'), admin: true },
  { id: 'groupes', label: t('Groups', 'Groupes'), admin: true },
  { id: 'regles', label: t('Rules', 'Règles'), admin: true },
  { id: 'portail', label: t('Web portal', 'Portail web'), admin: true },
  { id: 'assistance', label: t('Assistance', 'Assistance'), admin: true },
  { id: 'reglages', label: t('Settings', 'Réglages'), admin: true },
];
const DAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const POLICIES: [string, string][] = [
  ['', t('Global setting', 'Réglage général')],
  ['password+totp', t('Password + code', 'Mot de passe + code')],
  ['password+totp,key+totp', t('Password or key, + code', 'Mot de passe ou clé, + code')],
  ['key+totp', t('SSH key + code', 'Clé SSH + code')],
  ['password', t('Password only', 'Mot de passe seul')],
  ['key', t('SSH key only', 'Clé SSH seule')],
];

/** Page d'administration d'un bastion (onglet). */
export function renderBastionAdmin(b: Bastion, host: BastionHost): HTMLElement {
  const isAdmin = b.role === 'admin';
  const sections = SECTIONS.filter((s) => isAdmin || !s.admin);
  let current: Section = sections[0].id;
  const nav = h('div', { class: 'seg admin-nav', role: 'tablist' });
  const content = h('div', { class: 'admin-content' });
  const call = <T = any>(method: string, path: string, body?: unknown) => bastions.admin<T>(b.id, method, path, body);
  const fail = (e: unknown) => host.toast(errorText(e) === 'SESSION_EXPIREE' ? t('Bastion session expired: sign in again (sidebar).', 'Session du bastion expirée : reconnectez-vous (barre latérale).') : errorText(e), 'error');

  const show = async (id: Section) => {
    current = id;
    nav.replaceChildren(...sections.map((s) => h('button', { type: 'button', role: 'tab', class: `seg-opt${s.id === current ? ' on' : ''}`, 'aria-selected': String(s.id === current), onclick: () => show(s.id) }, s.label)));
    content.replaceChildren(h('p', { class: 'muted' }, t('Loading…', 'Chargement…')));
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
    const cancel = h('button', { type: 'button', class: 'btn' }, t('Cancel', 'Annuler'));
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
    const ok = h('button', { type: 'button', class: 'btn primary' }, t('I wrote it down', 'J\'ai noté'));
    const copy = h('button', { type: 'button', class: 'btn' }, t('Copy', 'Copier'));
    const { dialog } = modal(title, [h('p', {}, text), h('div', { class: 'fp big' }, value), h('p', { class: 'muted small' }, t('It will not be shown again.', 'Il ne sera plus affiché.'))], [copy, ok]);
    copy.addEventListener('click', () => navigator.clipboard.writeText(value).then(() => host.toast(t('Copied', 'Copié'))));
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
  const targetDialog = (cur?: any) => {
    const nom = input({ id: 't-nom', value: cur?.nom ?? '' });
    const dossier = input({ id: 't-dossier', value: cur?.dossier ?? '', placeholder: t('Production, Staging…', 'Production, Recette…') });
    const hote = input({ id: 't-hote', value: cur?.hote ?? '' });
    const port = input({ id: 't-port', value: String(cur?.port ?? 22), inputmode: 'numeric' });
    const mode = select('t-mode', [['coffre', t('Vault: account provided by the bastion', 'Coffre : compte fourni par le bastion')], ['enregistre', t('Recorded: the user\'s credentials', 'Enregistré : identifiants de l\'utilisateur')], ['rebond', t('Jump: end-to-end relay', 'Rebond : relais de bout en bout')]], cur?.mode ?? 'coffre');
    const compte = input({ id: 't-compte', value: cur?.compte ?? '' });
    const secretKind = select('t-secret', [
      ...(cur ? [['', cur.secret === 'none' ? t('None', 'Aucun') : t('Keep the current secret', 'Garder le secret actuel')] as [string, string]] : [['', t('None', 'Aucun')] as [string, string]]),
      ['generer', t('Generate a key and install it on the server', 'Générer une clé et l\'installer sur le serveur')],
      ['mot_de_passe', t('Account password', 'Mot de passe du compte')],
      ['cle', t('Existing private key', 'Clé privée existante')],
    ], cur ? '' : 'generer');
    const secretPass = input({ id: 't-secret-pass', type: 'password' });
    const secretKey = h('textarea', { id: 't-secret-key', class: 'input', rows: 5, spellcheck: 'false', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' }) as HTMLTextAreaElement;
    const passField = field(t('Account\'s current password', 'Mot de passe actuel du compte'), secretPass, t('used only once', 'utilisé une seule fois'));
    const keyField = field(t('Private key (without passphrase)', 'Clé privée (sans phrase de passe)'), secretKey);
    const proto = select('t-proto', [['ssh', 'SSH'], ['rdp', t('Remote Desktop (RDP)', 'Bureau à distance (RDP)')]], cur?.protocole ?? 'ssh');
    const rdpNote = h('p', { class: 'muted small', hidden: true }, t('Remote Desktop: the user types their Windows credentials at each opening. Jump: the bastion relays the encrypted connection without reading it (Portunia only). Recorded: the bastion relays and records the session, without seeing the password; also opens from the web portal. Vault mode is coming.', 'Bureau à distance : l\'utilisateur tape ses identifiants Windows à chaque ouverture. Rebond : le bastion relaie la connexion chiffrée sans la lire (Portunia seulement). Enregistré : le bastion relaie et enregistre la session, sans voir le mot de passe ; s\'ouvre aussi depuis le portail web. Le mode coffre arrive.'));
    // Port par défaut du protocole, tant que l'administrateur ne l'a pas changé.
    proto.addEventListener('change', () => {
      if (['22', '3389', ''].includes(port.value.trim())) port.value = proto.value === 'rdp' ? '3389' : '22';
      if (proto.value === 'rdp' && mode.value === 'coffre') mode.value = 'enregistre';
      sync();
    });
    const sync = () => {
      const rdp = proto.value === 'rdp';
      for (const o of mode.options) o.disabled = rdp && o.value === 'coffre';
      rdpNote.hidden = !rdp;
      const vault = mode.value === 'coffre';
      secretKind.closest('label')!.hidden = !vault;
      passField.hidden = !vault || !['generer', 'mot_de_passe'].includes(secretKind.value);
      keyField.hidden = !vault || secretKind.value !== 'cle';
      (passField.querySelector('span') as HTMLElement).firstChild!.textContent = secretKind.value === 'generer' ? t('Account\'s current password', 'Mot de passe actuel du compte') : t('Account password', 'Mot de passe du compte');
    };
    mode.addEventListener('change', sync);
    secretKind.addEventListener('change', sync);
    const body = [
      field(t('Protocol', 'Protocole'), proto),
      h('div', { class: 'row2' }, field(t('Name', 'Nom'), nom, t('no spaces', 'sans espace')), field(t('Folder', 'Dossier'), dossier)),
      h('div', { class: 'quick-row' }, field(t('Address', 'Adresse'), hote), field('Port', port)),
      field('Mode', mode), rdpNote, field(t('Account on the server', 'Compte sur le serveur'), compte, t('required in vault mode; for Remote Desktop: DOMAIN\\account, offered at opening', 'obligatoire en mode coffre ; en Bureau à distance : DOMAINE\\compte, proposé à l\'ouverture')),
      field(t('Vault secret', 'Secret du coffre'), secretKind), passField, keyField,
      h('p', { class: 'muted small' }, t('The secret is encrypted by the bastion and can never be read back. « Generate » creates a key, installs it with the password given only once, then checks that it works.', 'Le secret est chiffré par le bastion et ne se relit jamais. « Générer » crée une clé, l\'installe avec le mot de passe donné une seule fois, puis vérifie qu\'elle fonctionne.')),
    ];
    setTimeout(sync);
    formDialog(cur ? t(`Edit ${cur.nom}`, `Modifier ${cur.nom}`) : t('Add a server', 'Ajouter un serveur'), body, cur ? t('Save', 'Enregistrer') : t('Add', 'Ajouter'), async () => {
      const kind = mode.value === 'coffre' ? secretKind.value : '';
      const secret = kind === 'generer' ? { type: 'generer', mot_de_passe: secretPass.value }
        : kind === 'mot_de_passe' ? { type: 'mot_de_passe', valeur: secretPass.value }
        : kind === 'cle' ? { type: 'cle', valeur: secretKey.value } : undefined;
      const payload = {
        nom: nom.value.trim(), dossier: dossier.value.trim(), hote: hote.value.trim(), port: Number(port.value) || (proto.value === 'rdp' ? 3389 : 22),
        mode: mode.value, compte: compte.value.trim() || null, secret, protocole: proto.value,
      };
      await (cur ? call('PUT', `/admin/cibles/${cur.id}`, payload) : call('POST', '/admin/cibles', payload));
      host.toast(cur ? t('Server updated', 'Serveur modifié') : t('Server added', 'Serveur ajouté'));
    });
  };

  const SECTION_RENDER: Record<Section, () => Promise<HTMLElement>> = {
    cibles: async () => {
      const { cibles } = await call<{ cibles: any[] }>('GET', '/admin/cibles');
      const rows = cibles.map((tg) => h('tr', {},
        h('td', {}, h('strong', {}, tg.nom)), h('td', {}, tg.dossier), h('td', {}, h('code', {}, `${tg.hote}:${tg.port}`)),
        h('td', {}, tg.protocole === 'rdp' ? h('span', { class: 'badge proto-rdp' }, 'RDP') : null, h('span', { class: `badge mode-${tg.mode}` }, MODE_LABEL[tg.mode as BastionServer['mode']])), h('td', {}, tg.compte ?? '—'),
        h('td', {}, tg.secret === 'key' ? t('SSH key', 'Clé SSH') : tg.secret === 'password' ? t('Password', 'Mot de passe') : '—'),
        h('td', { title: tg.empreinte ?? '' }, tg.empreinte ? t('known', 'connue') : t('at first connection', 'à la 1ʳᵉ connexion')),
        actions(small(t('Edit', 'Modifier'), () => targetDialog(tg)),
          small(t('Forget the fingerprint', 'Oublier l\'empreinte'), async () => {
            if (!confirm(t(`Forget the fingerprint of ${tg.nom}? Only do this after the server was reinstalled.`, `Oublier l'empreinte de ${tg.nom} ? À faire seulement après la réinstallation du serveur.`))) return;
            await call('POST', `/admin/cibles/${tg.id}/oublier-empreinte`).catch(fail); reload();
          }),
          small(t('Delete', 'Supprimer'), async () => {
            if (!confirm(t(`Delete server ${tg.nom}? Its secret is erased; the session history is kept.`, `Supprimer le serveur ${tg.nom} ? Son secret est effacé ; l'historique des sessions est gardé.`))) return;
            await call('DELETE', `/admin/cibles/${tg.id}`).catch(fail); reload();
          }, true))));
      return h('div', { class: 'admin-section' },
        toolbar(t(`${cibles.length} server(s). Every change is traced in the log.`, `${cibles.length} serveur(s). Chaque modification est tracée dans le journal.`), h('button', { class: 'btn primary', onclick: () => targetDialog() }, t('Add a server', 'Ajouter un serveur'))),
        table([t('Server', 'Serveur'), t('Folder', 'Dossier'), t('Address', 'Adresse'), 'Mode', t('Account', 'Compte'), 'Secret', t('Fingerprint', 'Empreinte'), ''], rows));
    },

    comptes: async () => {
      const [{ comptes, politique_generale }, { groupes }] = await Promise.all([call<{ comptes: any[]; politique_generale: string }>('GET', '/admin/comptes'), call<{ groupes: any[] }>('GET', '/admin/groupes')]);
      const groupNames = groupes.map((g) => g.nom);
      const userDialog = (u?: any) => {
        const login = input({ id: 'u-login', value: u?.login ?? '', disabled: !!u });
        const role = select('u-role', [['user', t('User', 'Utilisateur')], ['auditor', t('Auditor (reads the log)', 'Auditeur (lecture du journal)')], ['admin', t('Administrator', 'Administrateur')]], u?.role ?? 'user');
        const known = POLICIES.some(([v]) => v === (u?.politique ?? ''));
        const policy = select('u-policy', known ? POLICIES : [...POLICIES, [u.politique, u.politique]], u?.politique ?? '');
        const groups = multi('u-g', groupNames, u?.groupes ?? []);
        const disabled = checkbox('u-disabled', t('Account disabled', 'Compte désactivé'), !!u?.desactive);
        formDialog(u ? t(`Edit ${u.login}`, `Modifier ${u.login}`) : t('Create an account', 'Créer un compte'), [
          h('div', { class: 'row2' }, field(t('Login', 'Identifiant'), login), field(t('Role', 'Rôle'), role)),
          field(t('Sign-in', 'Connexion'), policy, t(`global: ${politique_generale}`, `général : ${politique_generale}`)),
          h('div', { class: 'fld' }, h('span', {}, t('Groups', 'Groupes')), groupNames.length ? groups.el : h('p', { class: 'muted small' }, t('No group: create some in the Groups tab.', 'Aucun groupe : créez-en dans l\'onglet Groupes.'))),
          u ? disabled.row : h('p', { class: 'muted small' }, t('A temporary password will be shown once. The user will enrol their code at their first sign-in in Portunia.', 'Un mot de passe provisoire sera affiché une fois. Le code sera enrôlé par l\'utilisateur à sa première connexion dans Portunia.')),
        ], u ? t('Save', 'Enregistrer') : t('Create', 'Créer'), async () => {
          const payload = { login: login.value.trim(), role: role.value, politique: policy.value || null, groupes: groups.values(), desactive: disabled.box.checked };
          if (u) {
            await call('PUT', `/admin/comptes/${u.id}`, payload);
            host.toast(t('Account updated', 'Compte modifié'));
          } else {
            const r = await call<{ mot_de_passe_provisoire: string }>('POST', '/admin/comptes', payload);
            setTimeout(() => showSecret(t('Account created', 'Compte créé'), t(`Temporary password of ${payload.login}, to give them:`, `Mot de passe provisoire de ${payload.login}, à lui transmettre :`), r.mot_de_passe_provisoire));
          }
        });
      };
      const keyDialog = (u: any) => {
        const key = h('textarea', { id: 'k-key', class: 'input', rows: 3, spellcheck: 'false', placeholder: 'ssh-ed25519 AAAA… commentaire' }) as HTMLTextAreaElement;
        formDialog(t(`SSH key of ${u.login}`, `Clé SSH de ${u.login}`), [field(t('Public key', 'Clé publique'), key)], t('Add', 'Ajouter'), async () => {
          const r = await call<{ empreinte: string }>('POST', `/admin/comptes/${u.id}/cles`, { cle: key.value });
          host.toast(t(`Key added: ${r.empreinte}`, `Clé ajoutée : ${r.empreinte}`));
        });
      };
      const rows = comptes.map((u) => h('tr', { class: u.desactive ? 'off' : '' },
        h('td', {}, h('strong', {}, u.login)), h('td', {}, roleLabel(u.role)), h('td', {}, u.groupes.join(', ') || '—'),
        h('td', {}, POLICIES.find(([v]) => v === (u.politique ?? ''))?.[1] ?? u.politique),
        h('td', {}, u.mot_de_passe_provisoire ? h('span', { class: 'chip warn' }, t('temporary password', 'mot de passe provisoire')) : u.code_enrole ? h('span', { class: 'chip ok' }, t('code enrolled', 'code enrôlé')) : h('span', { class: 'chip warn' }, t('at first connection', 'à la 1ʳᵉ connexion')),
          u.desactive ? h('span', { class: 'chip off' }, t('disabled', 'désactivé')) : null),
        actions(small(t('Edit', 'Modifier'), () => userDialog(u)),
          small(t('Temporary password', 'Mot de passe provisoire'), async () => {
            if (!confirm(t(`Give ${u.login} a new temporary password? Their Portunia sessions will be closed.`, `Donner un nouveau mot de passe provisoire à ${u.login} ? Ses sessions Portunia seront fermées.`))) return;
            try { const r = await call<{ mot_de_passe_provisoire: string }>('POST', `/admin/comptes/${u.id}/mot-de-passe-provisoire`); showSecret(t('New temporary password', 'Nouveau mot de passe provisoire'), t(`For ${u.login}:`, `Pour ${u.login} :`), r.mot_de_passe_provisoire); } catch (e) { fail(e); }
            reload();
          }),
          small(t('Reset the code', 'Réinitialiser le code'), async () => {
            if (!confirm(t(`Reset the code of ${u.login}? They will enrol it again at their next sign-in.`, `Réinitialiser le code de ${u.login} ? Il l'enrôlera de nouveau à sa prochaine connexion.`))) return;
            await call('POST', `/admin/comptes/${u.id}/reinitialiser-code`).catch(fail); reload();
          }),
          small(t('SSH key', 'Clé SSH'), () => keyDialog(u)),
          small(t('Delete', 'Supprimer'), async () => {
            if (!confirm(t(`Delete the account ${u.login}? Their session history is kept.`, `Supprimer le compte ${u.login} ? L'historique de ses sessions est gardé.`))) return;
            await call('DELETE', `/admin/comptes/${u.id}`).catch(fail); reload();
          }, true))));
      return h('div', { class: 'admin-section' },
        toolbar(t(`${comptes.length} account(s).`, `${comptes.length} compte(s).`), h('button', { class: 'btn primary', onclick: () => userDialog() }, t('Create an account', 'Créer un compte'))),
        table([t('Account', 'Compte'), t('Role', 'Rôle'), t('Groups', 'Groupes'), t('Sign-in', 'Connexion'), t('Status', 'État'), ''], rows));
    },

    groupes: async () => {
      const { groupes } = await call<{ groupes: any[] }>('GET', '/admin/groupes');
      const add = () => {
        const nom = input({ id: 'g-nom' });
        formDialog(t('Create a group', 'Créer un groupe'), [field(t('Name', 'Nom'), nom)], t('Create', 'Créer'), async () => { await call('POST', '/admin/groupes', { nom: nom.value }); });
      };
      const rows = groupes.map((g) => h('tr', {},
        h('td', {}, h('strong', {}, g.nom)), h('td', {}, g.membres.join(', ') || '—'),
        actions(small(t('Delete', 'Supprimer'), async () => {
          if (!confirm(t(`Delete the group ${g.nom}? Its rules will be deleted too.`, `Supprimer le groupe ${g.nom} ? Ses règles seront supprimées aussi.`))) return;
          await call('DELETE', `/admin/groupes/${g.id}`).catch(fail); reload();
        }, true))));
      return h('div', { class: 'admin-section' },
        toolbar(t('Members are chosen in each account\'s settings.', 'Les membres se choisissent dans la fiche de chaque compte.'), h('button', { class: 'btn primary', onclick: add }, t('Create a group', 'Créer un groupe'))),
        table([t('Group', 'Groupe'), t('Members', 'Membres'), ''], rows));
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
        const from = input({ id: 'r-from', type: 'number', min: 0, max: 23, value: r?.heure_debut ?? '', placeholder: t('all day', 'toute la journée') });
        const to = input({ id: 'r-to', type: 'number', min: 1, max: 24, value: r?.heure_fin ?? '' });
        const sftp = checkbox('r-sftp', t('File transfers (SFTP, scp)', 'Transferts de fichiers (SFTP, scp)'), r?.sftp ?? false);
        const tunnels = checkbox('r-tunnels', t('Tunnels (port forwarding)', 'Tunnels (redirection de ports)'), r?.tunnels ?? false);
        const keys = checkbox('r-frappe', t('Also record keystrokes (captures typed passwords)', 'Enregistrer aussi la frappe (capte les mots de passe tapés)'), r?.frappe ?? false);
        const expire = input({ id: 'r-expire', type: 'date', lang: 'fr', value: r?.expire ? String(r.expire).slice(0, 10) : '' });
        if (!groupes.length) return host.toast(t('First create a group (Groups tab)', 'Créez d\'abord un groupe (onglet Groupes)'), 'error');
        formDialog(r ? t(`Edit rule ${r.nom}`, `Modifier la règle ${r.nom}`) : t('New rule', 'Nouvelle règle'), [
          h('div', { class: 'row2' }, field(t('Name', 'Nom'), nom), field(t('Group', 'Groupe'), groupe)),
          h('div', { class: 'fld' }, h('span', {}, t('Servers', 'Serveurs')), servers.el),
          h('div', { class: 'fld' }, h('span', {}, t('Days', 'Jours')), h('div', { class: 'days' }, ...days.map((d) => d.el))),
          h('div', { class: 'row2' }, field(t('From (hour)', 'De (heure)'), from), field(t('To (hour)', 'À (heure)'), to)),
          sftp.row, tunnels.row, keys.row,
          field(t('Expires on', 'Expire le'), expire, 'vide = jamais'),
        ], r ? t('Save', 'Enregistrer') : t('Create', 'Créer'), async () => {
          const mask = days.reduce((m, d, i) => m | (d.box.checked ? 1 << i : 0), 0);
          const payload = {
            nom: nom.value.trim(), groupe: groupe.value, cibles: servers.values(), sftp: sftp.box.checked, tunnels: tunnels.box.checked, frappe: keys.box.checked,
            jours: mask, heure_debut: from.value === '' ? null : Number(from.value), heure_fin: to.value === '' ? null : Number(to.value), expire: expire.value || null,
          };
          await (r ? call('PUT', `/admin/regles/${r.id}`, payload) : call('POST', '/admin/regles', payload));
        });
      };
      const when = (r: any) => {
        const d = r.jours === 127 ? t('Every day', 'Tous les jours') : DAY_NAMES.filter((_, i) => (r.jours >> i) & 1).map((x) => x.slice(0, 3)).join(', ');
        return r.heure_debut != null ? `${d} · ${r.heure_debut} h-${r.heure_fin} h` : d;
      };
      const stateChip = (s: string) => h('span', { class: `chip ${s === 'active' ? 'ok' : s === 'expiree' ? 'off' : 'warn'}` }, s === 'active' ? 'active' : s === 'expiree' ? t('expired', 'expirée') : 'hors plage');
      const rows = regles.map((r) => h('tr', {},
        h('td', {}, h('strong', {}, r.nom)), h('td', {}, r.groupe), h('td', {}, r.cibles.join(', ')), h('td', {}, when(r)),
        h('td', {}, [r.sftp && 'SFTP', r.tunnels && 'tunnels', r.frappe && t('keystrokes', 'frappe')].filter(Boolean).join(', ') || '—'),
        h('td', {}, stateChip(r.etat), r.expire ? h('span', { class: 'muted small' }, t(` until ${new Date(r.expire).toLocaleDateString(LOCALE)}`, ` jusqu'au ${new Date(r.expire).toLocaleDateString(LOCALE)}`)) : null),
        actions(small(t('Edit', 'Modifier'), () => ruleDialog(r)), small(t('Delete', 'Supprimer'), async () => {
          if (!confirm(t(`Delete rule ${r.nom}?`, `Supprimer la règle ${r.nom} ?`))) return;
          await call('DELETE', `/admin/regles/${r.id}`).catch(fail); reload();
        }, true))));
      return h('div', { class: 'admin-section' },
        toolbar(t('Anything no rule allows is refused. A change applies at the next session opening.', 'Tout ce qu\'aucune règle ne permet est refusé. Une modification s\'applique à la prochaine ouverture de session.'), h('button', { class: 'btn primary', onclick: () => ruleDialog() }, t('New rule', 'Nouvelle règle'))),
        table([t('Rule', 'Règle'), t('Group', 'Groupe'), t('Servers', 'Serveurs'), t('When', 'Quand'), t('Options', 'Options'), t('Status', 'État'), ''], rows));
    },

    portail: async () => {
      let p: any;
      try {
        p = await call<any>('GET', '/admin/portail');
      } catch (e) {
        // Bastion antérieur à la 0.7 : pas de portail.
        if (/404|Not Found/i.test(errorText(e))) return h('div', { class: 'admin-section' }, toolbar(t('The web portal needs Heimdia 0.7 or later: update the bastion (sudo bash installer.sh update).', 'Le portail web demande Heimdia 0.7 ou plus récent : mettez le bastion à jour (sudo bash installer.sh mise-a-jour).')));
        throw e;
      }
      const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(p.actif), 'aria-label': t('Web portal', 'Portail web') });
      const state = h('strong', { class: p.actif ? 'ok-text' : 'muted' }, p.actif ? t('enabled', 'activé') : t('disabled', 'désactivé'));
      sw.addEventListener('click', async () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        if (!on && p.sessions_en_cours > 0 && !confirm(t(`Disabling the portal closes the ${p.sessions_en_cours} open web session(s). Continue?`, `Désactiver le portail ferme les ${p.sessions_en_cours} session(s) web en cours. Continuer ?`))) return;
        if (on && !p.url) host.toast(t('First give the portal\'s public address, then save.', 'Indiquez d\'abord l\'adresse publique du portail, puis enregistrez.'), 'info');
        try { await call('PUT', '/admin/portail', { actif: on }); host.toast(on ? t('Web portal enabled', 'Portail web activé') : t('Web portal disabled', 'Portail web désactivé')); reload(); } catch (e) { fail(e); }
      });
      const tunnel = { relie: ['ok', t('connected', 'relié')], deconnecte: ['warn', t('installed, not connected', 'installé, non relié')], absent: ['off', t('not installed', 'non installé')] }[p.tunnel as string] ?? ['off', p.tunnel];
      const stat = (value: string | number, label: string) => h('div', { class: 'portal-stat' }, h('b', {}, String(value)), h('span', {}, label));
      const closeAll = small(t('Close all web sessions', 'Fermer toutes les sessions web'), async () => {
        if (!confirm(t('Close all open web sessions? Users will have to sign in again.', 'Fermer toutes les sessions web en cours ? Les utilisateurs devront se reconnecter.'))) return;
        try { const r = await call<any>('POST', '/admin/portail/fermer-sessions'); host.toast(t(`${r.fermees} terminal(s) closed`, `${r.fermees} terminal(aux) fermé(s)`)); reload(); } catch (e) { fail(e); }
      }, true);

      const url = input({ id: 'p-url', value: p.url, placeholder: t('https://access.your-domain.com', 'https://acces.votre-domaine.fr') });
      const groupe = select('p-groupe', [...new Set([p.groupe, ...p.groupes])].filter(Boolean).map((g: string) => [g, g] as [string, string]), p.groupe);
      const duree = select('p-duree', [['1', '1 heure'], ['4', '4 heures'], ['8', '8 heures']].concat([1, 4, 8].includes(p.duree_h) ? [] : [[String(p.duree_h), `${p.duree_h} heures`]]) as [string, string][], String(p.duree_h));
      const idle = select('p-idle', [['15', '15 minutes'], ['30', '30 minutes'], ['60', '1 heure']].concat([15, 30, 60].includes(p.inactivite_min) ? [] : [[String(p.inactivite_min), `${p.inactivite_min} minutes`]]) as [string, string][], String(p.inactivite_min));
      const clip = checkbox('p-clip', t('Copy-paste text in the terminal', 'Copier-coller du texte dans le terminal'), p.presse_papiers);
      const site = input({ id: 'p-site', value: p.turnstile_site, placeholder: '0x4AAAAAA…' });
      const secret = input({ id: 'p-secret', type: 'password', placeholder: p.turnstile_secret_defini ? t('Keep the current secret key', 'Garder la clé secrète actuelle') : '0x4AAAAAA…' });
      const groupMissing = !p.groupes.includes(p.groupe);
      const save = h('button', { class: 'btn primary', onclick: async () => {
        const body: Record<string, unknown> = {
          url: url.value.trim(), groupe: groupe.value, duree_h: Number(duree.value), inactivite_min: Number(idle.value),
          presse_papiers: clip.box.checked, turnstile_site: site.value.trim(),
        };
        if (secret.value.trim()) body.turnstile_secret = secret.value.trim();
        if (!site.value.trim() && p.turnstile_secret_defini) body.turnstile_secret = '';
        try { await call('PUT', '/admin/portail', body); host.toast(t('Web portal saved', 'Portail web enregistré')); reload(); } catch (e) { fail(e); }
      } }, t('Save', 'Enregistrer'));

      return h('div', { class: 'admin-section form-narrow' },
        h('div', { class: 'portal-head' }, sw, h('div', {},
          h('div', {}, h('b', {}, t('Web portal', 'Portail web')), ' · ', state),
          h('p', { class: 'muted small' }, t('Access to SSH servers from a browser, without Portunia, behind Cloudflare. Disabled: the page shows « Portal closed » and open web sessions close.', 'Accès aux serveurs SSH depuis un navigateur, sans Portunia, derrière Cloudflare. Désactivé : la page affiche « Portail fermé » et les sessions web en cours se ferment.')))),
        h('div', { class: 'portal-stats' },
          stat(p.sessions_en_cours, 'sessions web en cours'), stat(p.connexions_jour, 'connexions aujourd\'hui'), stat(p.echecs_jour, t('failures today', 'échecs aujourd\'hui')),
          h('div', { class: 'portal-stat' }, h('b', { class: `chip ${tunnel[0]}` }, tunnel[1]), h('span', {}, 'tunnel Cloudflare'))),
        h('div', {}, closeAll),
        h('h3', {}, t('Address', 'Adresse')),
        field(t('Public address', 'Adresse publique'), url, t('the one Cloudflare publishes; checked at every connection', 'celle que Cloudflare publie ; vérifiée à chaque connexion')),
        h('p', { class: 'muted small' }, t(
          `The bastion serves the portal on ${p.ecoute.tunnel} (Cloudflare Tunnel)${p.ecoute.proxy ? ` and ${p.ecoute.proxy} over HTTPS (Cloudflare proxy, Cloudflare addresses only)` : ''}. Install the tunnel: sudo bash installer.sh portal.`,
          `Le bastion sert le portail sur ${p.ecoute.tunnel} (Cloudflare Tunnel)${p.ecoute.proxy ? ` et ${p.ecoute.proxy} en HTTPS (proxy Cloudflare, adresses de Cloudflare seulement)` : ''}. Installer le tunnel : sudo bash installer.sh portail.`)),
        h('h3', {}, t('Who and for how long', 'Qui et combien de temps')),
        field(t('Allowed group', 'Groupe autorisé'), groupe, groupMissing ? t(`the group « ${p.groupe} » does not exist yet: create it in Groups and add the accounts to it`, `le groupe « ${p.groupe} » n'existe pas encore : créez-le dans Groupes et ajoutez-y les comptes`) : t('only its members can sign in to the portal', 'seuls ses membres peuvent se connecter au portail')),
        h('div', { class: 'row2' }, field(t('Web session duration', 'Durée d\'une session web'), duree), field(t('Close after inactivity', 'Fermeture après inactivité'), idle)),
        clip.row,
        h('p', { class: 'muted small' }, t('Always required on the portal: password and code. First sign-in and lost code are handled in Portunia. Servers in jump mode: only with Portunia for now.', 'Toujours exigés sur le portail : mot de passe et code. Première connexion et code perdu se font dans Portunia. Serveurs en mode rebond et Bureau à distance : seulement avec Portunia pour l\'instant.')),
        h('h3', {}, t('Anti-bot (Cloudflare Turnstile)', 'Anti-robots (Cloudflare Turnstile)')),
        h('div', { class: 'row2' }, field(t('Site key', 'Clé du site'), site), field(t('Secret key', 'Clé secrète'), secret, t('kept encrypted by the bastion', 'gardée chiffrée par le bastion'))),
        h('div', {}, save));
    },

    assistance: async () => {
      let a: any;
      try {
        a = await call<any>('GET', '/admin/assistance');
      } catch (e) {
        // Bastion antérieur à la 0.11 : pas de relais d'assistance.
        if (/404|Not Found/i.test(errorText(e))) return h('div', { class: 'admin-section' }, toolbar(t('Remote assistance needs Heimdia 0.11 or later: update the bastion (sudo bash installer.sh update).', 'L\'assistance à distance demande Heimdia 0.11 ou plus récent : mettez le bastion à jour (sudo bash installer.sh mise-a-jour).')));
        throw e;
      }
      const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(a.actif), 'aria-label': t('Assistance relay', 'Relais d\'assistance') });
      const stateText = h('strong', { class: a.actif ? 'ok-text' : 'muted' }, a.actif ? t('enabled', 'activé') : t('disabled', 'désactivé'));
      sw.addEventListener('click', async () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        if (!on && !confirm(t('Disabling the relay ends the assistance sessions in progress. Continue?', 'Couper le relais met fin aux assistances en cours. Continuer ?'))) return;
        try { await call('PUT', '/admin/assistance', { actif: on }); host.toast(on ? t('Assistance relay enabled', 'Relais d\'assistance activé') : t('Assistance relay disabled', 'Relais d\'assistance coupé')); reload(); } catch (e) { fail(e); }
      });
      const stat = (value: string | number, label: string) => h('div', { class: 'portal-stat' }, h('b', {}, String(value)), h('span', {}, label));
      const groupe = select('a-groupe', [...new Set([a.groupe, ...a.groupes])].filter(Boolean).map((g: string) => [g, g] as [string, string]), a.groupe);
      const duree = select('a-duree', [['1', t('1 hour', '1 heure')], ['4', t('4 hours', '4 heures')], ['8', t('8 hours', '8 heures')]].concat([1, 4, 8].includes(a.duree_h) ? [] : [[String(a.duree_h), `${a.duree_h} h`]]) as [string, string][], String(a.duree_h));
      const groupMissing = !a.groupes.includes(a.groupe);
      const save = h('button', { class: 'btn primary', onclick: async () => {
        try { await call('PUT', '/admin/assistance', { groupe: groupe.value, duree_h: Number(duree.value) }); host.toast(t('Assistance saved', 'Assistance enregistrée')); reload(); } catch (e) { fail(e); }
      } }, t('Save', 'Enregistrer'));
      return h('div', { class: 'admin-section form-narrow' },
        h('div', { class: 'portal-head' }, sw, h('div', {},
          h('div', {}, h('b', {}, t('Assistance relay', 'Relais d\'assistance')), ' · ', stateText),
          h('p', { class: 'muted small' }, t('Lets helpers take control of a PC with Portunia Assist: the person downloads it from the page below and reads a code. The relay only passes on encrypted data.', 'Permet aux dépanneurs de prendre la main sur un PC avec Portunia Assist : la personne le télécharge sur la page ci-dessous et lit un code. Le relais ne fait que transmettre des données chiffrées.')))),
        h('div', { class: 'portal-stats' },
          stat(a.en_attente, t('people waiting', 'personnes en attente')), stat(a.aujourd_hui, t('assistance today', 'assistances aujourd\'hui')), stat(a.total, t('in total', 'en tout')),
          h('div', { class: 'portal-stat' }, h('b', { class: `chip ${a.programme ? 'ok' : 'warn'}` }, a.programme ? t('ready', 'prêt') : t('missing', 'absent')), h('span', {}, 'Portunia Assist'))),
        h('h3', {}, t('Page for the person helped', 'Page de la personne aidée')),
        a.adresse
          ? h('div', { class: 'assist-url' }, h('code', {}, a.adresse), small(t('Copy', 'Copier'), () => { navigator.clipboard.writeText(a.adresse).then(() => host.toast(t('Copied', 'Copié'))).catch(() => {}); }))
          : h('p', { class: 'muted small' }, t('Set the public address in Web portal first: the page and the relay use it (Cloudflare Tunnel).', 'Réglez d\'abord l\'adresse publique dans Portail web : la page et le relais l\'utilisent (Cloudflare Tunnel).')),
        a.programme ? null : h('p', { class: 'muted small' }, t('The bastion downloads Portunia Assist from the Portunia releases when the relay is enabled (Internet access needed).', 'Le bastion télécharge Portunia Assist depuis les versions de Portunia à l\'activation du relais (accès Internet nécessaire).')),
        h('h3', {}, t('Who and for how long', 'Qui et combien de temps')),
        field(t('Group of helpers', 'Groupe des dépanneurs'), groupe, groupMissing ? t(`the group « ${a.groupe} » does not exist yet: create it in Groups and add the accounts to it`, `le groupe « ${a.groupe} » n'existe pas encore : créez-le dans Groupes et ajoutez-y les comptes`) : t('only its members can start an assistance from Portunia', 'seuls ses membres peuvent lancer une assistance depuis Portunia')),
        field(t('Maximum duration of an assistance', 'Durée maximale d\'une assistance'), duree),
        h('div', {}, save));
    },

    reglages: async () => {
      const r = await call<any>('GET', '/admin/reglages');
      const nom = input({ id: 's-nom', value: r.nom });
      const banner = h('textarea', { id: 's-banner', class: 'input', rows: 3 }, r.banniere) as HTMLTextAreaElement;
      const policy = select('s-policy', POLICIES.slice(1).some(([v]) => v === r.politique) ? POLICIES.slice(1) : [...POLICIES.slice(1), [r.politique, r.politique]], r.politique);
      const hours = input({ id: 's-hours', type: 'number', min: 1, max: 168, value: r.duree_session_h });
      const memo = checkbox('s-memo', t('Allow Portunia to remember the password (the code is still asked)', 'Autoriser Portunia à mémoriser le mot de passe (le code reste demandé)'), r.memo_mot_de_passe);
      const own = checkbox('s-own', t('Each account can replay its own sessions (bastion\'s « My sessions » menu)', 'Chaque compte peut relire ses propres sessions (menu « Mes sessions » du bastion)'), !!r.relecture_propres);
      const sensitive = h('textarea', { id: 's-sensitive', class: 'input', rows: 4, spellcheck: 'false' }, (r.commandes_sensibles ?? []).join('\n')) as HTMLTextAreaElement;
      // Langue du bastion (Heimdia 0.9 et suivants) : menu SSH, bannière par défaut, journaux.
      const langue = r.langue === undefined ? null : select('s-langue', [['', t('System language', 'Langue du système')], ['en', 'English'], ['fr', 'Français']], r.langue);
      const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
        try {
          await call('PUT', '/admin/reglages', {
            nom: nom.value, banniere: banner.value, politique: policy.value, duree_session_h: Number(hours.value), memo_mot_de_passe: memo.box.checked,
            relecture_propres: own.box.checked, commandes_sensibles: sensitive.value.split('\n').map((x) => x.trim()).filter(Boolean),
            ...(langue ? { langue: langue.value } : {}),
          });
          host.toast(t('Settings saved', 'Réglages enregistrés'));
        } catch (e) { fail(e); }
      } }, t('Save', 'Enregistrer'));
      return h('div', { class: 'admin-section form-narrow' },
        field(t('Bastion name', 'Nom du bastion'), nom, t('shown in Portunia and the authenticator app', 'affiché dans Portunia et l\'application d\'authentification')),
        field(t('Sign-in banner', 'Bannière de connexion'), banner, t('legal warning shown before sign-in', 'avertissement légal affiché avant l\'identification')),
        field(t('Default sign-in for accounts', 'Connexion par défaut des comptes'), policy),
        field(t('Session duration in Portunia (hours)', 'Durée d\'une session dans Portunia (heures)'), hours),
        langue ? field(t('Bastion language', 'Langue du bastion'), langue, t('SSH menu and messages, default banner, logs; Portunia and the web portal follow each user\'s language', 'menu et messages SSH, bannière par défaut, journaux ; Portunia et le portail web suivent la langue de chacun')) : null,
        memo.row,
        h('h3', {}, t('Session replay', 'Relecture des sessions')),
        own.row,
        field(t('Sensitive commands', 'Commandes sensibles'), sensitive, t('one per line; marked in red on the player\'s timeline', 'une par ligne ; repérées en rouge sur la barre de temps du lecteur')),
        h('div', {}, saveBtn));
    },
  };

  show(current);
  return h('div', { class: 'ext-page bastion-admin' },
    h('header', {}, h('h2', {}, `Administration · ${b.name}`), h('p', { class: 'muted' }, t(`${b.host} · signed in as ${b.login} (${roleLabel(b.role)})`, `${b.host} · connecté en tant que ${b.login} (${roleLabel(b.role)})`))),
    nav, content);
}
