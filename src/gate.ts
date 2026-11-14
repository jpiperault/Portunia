// Extension Portunia Gate : Gates dans la barre latérale, connexion (avec première connexion
// et enrôlement du code), ouverture des serveurs et administration de la Gate.
import { Gate, GateLoginAnswer, gates, GateServer, errorText, Manifest, Session } from './api';
import { h, icon } from './dom';
import { MenuItem, showMenu } from './menu';
import { LOCALE, t } from './i18n';

/** Portunia Gate apparaît dans la page Extensions comme les protocoles. */
export const GATE_EXTENSION: Manifest = {
  id: 'gate',
  name: 'Portunia Gate',
  version: '1.0.0',
  description: t('Servers protected by a Gate: sign-in with a code, servers in the sidebar, sessions recorded by the Gate, administration.', 'Serveurs protégés par une Gate : connexion avec code, serveurs dans la barre latérale, sessions enregistrées par la Gate, administration.'),
  view: 'terminal',
  builtin: true,
  catalog: false,
  fileBrowser: false,
  portForwarding: false,
  fields: [],
};

export interface GateHost {
  toast(message: string, kind?: 'info' | 'error'): void;
  openServer(b: Gate, s: GateServer): void;
  /** Sortie web : navigation en cours pour ce serveur, ouverture d'une adresse, arrêt. */
  browsing(b: Gate, s: GateServer): { id: string; open: number; total: number; bytes: number } | undefined;
  browseTo(b: Gate, s: GateServer): void;
  stopBrowsing(id: string): void;
  sessions(): Session[];
  removeSessions(ids: string[]): Promise<void>;
  openAdmin(b: Gate): void;
  openAudit(b: Gate): void;
  /** Page des approbations (Gate 0.38 et suivantes). */
  openApprovals(b: Gate): void;
  /** Demandes d'accès à décider sur cette Gate (badge du menu). */
  pendingApprovals(b: Gate): number;
  allowsAdmin(): boolean;
  /** Page « État de la Gate » (Gate 0.39 et suivantes). */
  openStatus(b: Gate): void;
  /** Mise à jour d'une Gate depuis Portunia (Pro). */
  allowsUpdate(): boolean;
  /** Santé lue sur la Gate (ok, alerte, erreur), pour la pastille. */
  health(b: Gate): string | undefined;
  setHealth(id: string, level: string): void;
  /** Extension de protocole activée (Bureau à distance pour les serveurs RDP). */
  protocolEnabled(id: string): boolean;
  filter(): string;
  /** Efface le filtre des sessions, qui s'applique aussi aux Gates. */
  clearFilter(): void;
}

const MODE_LABEL: Record<GateServer['mode'], string> = { coffre: t('Vault', 'Coffre'), enregistre: t('Recorded', 'Enregistré'), rebond: t('Jump', 'Rebond') };
const MODE_TITLE: Record<GateServer['mode'], string> = {
  coffre: t('Account provided by the Gate, session recorded', 'Compte fourni par la Gate, session enregistrée'),
  enregistre: t('Session recorded by the Gate; your credentials are asked in the terminal', 'Session enregistrée par la Gate ; vos identifiants sont demandés dans le terminal'),
  rebond: t('End-to-end relay through the Gate: nothing is recorded', 'Relais de bout en bout par la Gate : rien n\'est enregistré'),
};
const COLLAPSED_KEY = 'portunia.gates.replis';
const HEALTH_TITLE: Record<string, string> = {
  ok: t('Gate healthy', 'Gate en bonne santé'),
  alerte: t('Gate needs attention: see Gate status', 'Gate à surveiller : voir État de la Gate'),
  erreur: t('Gate problem: see Gate status', 'Problème sur la Gate : voir État de la Gate'),
};

function remaining(expires: string): string {
  const ms = Date.parse(expires) - Date.now();
  if (!(ms > 0)) return t('session expired', 'session expirée');
  const m = Math.round(ms / 60000);
  return m >= 60 ? t(`expires in ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`, `expire dans ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`) : t(`expires in ${m} min`, `expire dans ${m} min`);
}

/** Sessions Portunia qui vont directement sur un serveur protégé par cette Gate. */
export function bypassing(b: Gate, sessions: Session[]): { session: Session; server: GateServer }[] {
  const out: { session: Session; server: GateServer }[] = [];
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

export class GatePanel {
  list: Gate[] = [];
  private collapsed: Set<string>;
  private timer = 0;

  constructor(private root: HTMLElement, readonly host: GateHost) {
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'); } catch { /* ignoré */ }
    this.collapsed = new Set(saved);
  }

  async load(refresh = false) {
    try {
      this.list = await gates.list();
      if (refresh) {
        // Liste des serveurs à jour pour chaque Gate connecté (en parallèle, sans bloquer).
        await Promise.all(this.list.filter((b) => b.connected).map((b) => this.refresh(b.id, true)));
        this.list = await gates.list();
        void this.loadHealth();
      }
    } catch (e) {
      this.host.toast(errorText(e), 'error');
    }
    this.render();
  }

  /** Santé des Gates administrées (Gate 0.39 et suivantes ; les autres n'ont pas de pastille). */
  private async loadHealth() {
    const { gateLevel } = await import('./gatestatus');
    await Promise.all(this.list.filter((b) => b.connected && b.role === 'admin').map(async (b) => {
      const level = await gateLevel(b);
      if (level) this.host.setHealth(b.id, level);
    }));
    this.render();
  }

  /** Serveurs des Gates connectées que le filtre retient. */
  countMatches(filter: string): number {
    return this.list.filter((b) => b.connected).reduce((n, b) => n + b.servers.filter((s) => s.nom.toLowerCase().includes(filter) || s.dossier.toLowerCase().includes(filter) || (s.description ?? '').toLowerCase().includes(filter)).length, 0);
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
      const b = await gates.servers(id);
      this.list = this.list.map((x) => (x.id === id ? b : x));
    } catch (e) {
      const text = errorText(e);
      if (text === 'SESSION_EXPIREE') this.list = this.list.map((x) => (x.id === id ? { ...x, connected: false } : x));
      else if (!quiet) this.host.toast(text, 'error');
    }
    this.render();
  }

  /** Reconnexion (session expirée) ; vrai si l'utilisateur s'est reconnecté. */
  /** Entrée RDP native (Gate 0.31) : fichier .rdp à usage unique dans le client RDP du système.
   *  Mode enregistré : identifiants Windows demandés ici, confiés à la Gate le temps du jeton. */
  async openNative(b: Gate, s: GateServer) {
    if (!b.connected && !(await this.reconnect(b.id))) return;
    const launch = async (account?: string, password?: string) => {
      const address = await gates.nativeRdp(b.id, s.nom, account, password);
      this.host.toast(t(`${s.nom}: opening in the RDP client (${address})`, `${s.nom} : ouverture dans le client RDP (${address})`));
    };
    if (s.mode !== 'enregistre') {
      try { await launch(); } catch (e) { this.host.toast(errorText(e), 'error'); }
      return;
    }
    const account = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', placeholder: t('DOMAIN\\account or account', 'DOMAINE\\compte ou compte') }) as HTMLInputElement;
    const password = h('input', { class: 'input', type: 'password', autocomplete: 'off' }) as HTMLInputElement;
    const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Open', 'Ouvrir'));
    const cancel = h('button', { type: 'button', class: 'btn' }, t('Cancel', 'Annuler'));
    const { dialog, form, error } = modal(t(`${s.nom} · Windows account`, `${s.nom} · compte Windows`), [
      h('p', { class: 'muted small' }, t('The Gate opens the Windows session with this account, then relays and records it. It keeps it in memory only until the RDP client connects (a few minutes at most), never on disk.', 'La Gate ouvre la session Windows avec ce compte, puis la relaie et l\'enregistre. Elle ne le garde qu\'en mémoire, jusqu\'à la connexion du client RDP (quelques minutes au plus), jamais sur disque.')),
      field(t('Account', 'Compte'), account),
      field(t('Password', 'Mot de passe'), password),
      h('p', { class: 'muted small' }, t('Leave both empty for a server that shows its own sign-in screen (without NLA).', 'Laissez les deux vides pour un serveur qui affiche son propre écran de connexion (sans NLA).')),
    ], [cancel, submit]);
    cancel.addEventListener('click', () => dialog.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.setAttribute('disabled', '');
      try {
        await launch(account.value.trim() || undefined, password.value || undefined);
        dialog.close();
      } catch (err) {
        error.textContent = errorText(err);
      } finally {
        submit.removeAttribute('disabled');
        password.value = '';
      }
    });
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    account.focus();
  }

  async reconnect(id: string): Promise<boolean> {
    const b = this.list.find((x) => x.id === id);
    const done = await openGateLogin(this.host, b);
    if (done) await this.load();
    return !!done;
  }

  async add() {
    const b = await openGateLogin(this.host);
    if (b) {
      this.host.toast(t(`Gate « ${b.name} » added`, `Gate « ${b.name} » ajouté`));
      await this.load();
    }
  }

  render() {
    const filter = this.host.filter().trim().toLowerCase();
    const head = h('div', { class: 'sidebar-head' },
      h('span', { class: 'label' }, 'Gates'),
      h('div', { class: 'head-actions' },
        h('button', { class: 'icon-btn', 'aria-label': t('Add a Gate', 'Ajouter une Gate'), title: t('Add a Gate', 'Ajouter une Gate'), onclick: () => this.add() }, icon('plus'))));
    const body = h('div', { class: 'gate-list' });
    if (filter) {
      body.append(h('p', { class: 'gate-filter muted small' }, t(`Filtered by « ${filter} »`, `Filtrées par « ${filter} »`), ' ',
        h('button', { class: 'link-btn', onclick: () => this.host.clearFilter() }, t('Clear', 'Effacer'))));
    }
    if (!this.list.length) {
      body.append(h('div', { class: 'empty-tree' },
        h('span', { class: 'small' }, t('No Gate. A Gate protects access to your servers.', 'Aucune Gate. Une Gate protège l\'accès à vos serveurs.')),
        h('button', { class: 'btn', onclick: () => this.add() }, t('Add a Gate', 'Ajouter une Gate'))));
    }
    for (const b of this.list) body.append(...this.renderGate(b, filter));
    this.root.replaceChildren(head, body);
  }

  private menu(b: Gate): (MenuItem | 'separator')[] {
    return [
      b.connected
        ? { label: t('Refresh the list', 'Actualiser la liste'), icon: 'refresh', action: () => this.refresh(b.id) }
        : { label: t('Sign in again', 'Se reconnecter'), icon: 'lock', action: () => this.reconnect(b.id) },
      ...(b.role === 'admin' && b.connected ? [{ label: t('Administer', 'Administrer'), icon: 'settings', action: () => this.host.openAdmin(b) }] : []),
      ...(b.role === 'admin' && b.connected ? [{ label: t('Gate status', 'État de la Gate'), icon: 'chart' as const, action: () => this.host.openStatus(b) }] : []),
      ...((b.role === 'admin' || b.role === 'auditor' || b.ownReplay) && b.connected
        ? [{ label: b.role === 'user' ? t('My sessions', 'Mes sessions') : 'Audit', icon: 'play', action: () => this.host.openAudit(b) }] : []),
      ...(b.connected ? [{ label: this.host.pendingApprovals(b) ? t(`Approvals (${this.host.pendingApprovals(b)} waiting)`, `Approbations (${this.host.pendingApprovals(b)} en attente)`) : t('Approvals', 'Approbations'), icon: 'check', action: () => this.host.openApprovals(b) }] : []),
      { label: t(`Copy the certificate fingerprint`, `Copier l'empreinte du certificat`), icon: 'copy', action: () => navigator.clipboard.writeText(b.apiFingerprint) },
      'separator',
      ...(b.connected ? [{ label: t('Sign out', 'Se déconnecter'), icon: 'power', action: async () => { await gates.logout(b.id).catch(() => {}); this.load(); } }] : []),
      {
        label: t('Remove this Gate', 'Retirer cette Gate'), icon: 'trash', danger: true, action: async () => {
          if (!confirm(t(`Remove the Gate « ${b.name} » from Portunia? Its token and server list will be erased from this PC.`, `Retirer la Gate « ${b.name} » de Portunia ? Son jeton et sa liste de serveurs seront effacés de ce PC.`))) return;
          await gates.remove(b.id).catch((e) => this.host.toast(errorText(e), 'error'));
          this.load();
        },
      },
    ];
  }

  private renderGate(b: Gate, filter: string): HTMLElement[] {
    const state = b.connected ? 'on' : 'off';
    const card = h('div', { class: `gate-card ${state}` },
      h('button', {
        class: 'gate-main', title: b.connected ? `${b.host} · ${b.login} (${roleLabel(b.role)})` : t('Sign in again', 'Se reconnecter'),
        onclick: () => (b.connected ? this.toggle(b.id) : this.reconnect(b.id)),
      },
        h('span', { class: `led ${state}${b.connected && this.host.health(b) ? ` h-${this.host.health(b)}` : ''}`, title: b.connected && this.host.health(b) ? HEALTH_TITLE[this.host.health(b)!] ?? '' : '' }),
        h('span', { class: 'grow' },
          h('span', { class: 'gate-name ellipsis' }, b.name),
          h('span', { class: 'gate-sub ellipsis' }, b.connected ? `${b.login} · ${remaining(b.expires)}` : t('session expired · click to sign in again', 'session expirée · cliquer pour se reconnecter')))),
      h('button', { class: 'icon-btn sm', 'aria-label': t(`Actions for Gate ${b.name}`, `Actions de la Gate ${b.name}`), title: t('More actions', 'Plus d\'actions'), onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY, this.menu(b)) }, icon('more', 14)));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, this.menu(b)); });
    const out: HTMLElement[] = [card];
    if (this.collapsed.has(b.id) && !filter) return out;

    const bypass = b.connected ? bypassing(b, this.host.sessions()) : [];
    if (bypass.length) {
      out.push(h('button', { class: 'gate-warn', onclick: () => openBypass(this.host, b, bypass) },
        t(`${bypass.length} session(s) go directly to servers of this Gate`, `${bypass.length} session(s) vont directement sur des serveurs de cette Gate`)));
    }
    const servers = b.servers.filter((s) => !filter || s.nom.toLowerCase().includes(filter) || s.dossier.toLowerCase().includes(filter) || (s.description ?? '').toLowerCase().includes(filter));
    const groups = new Map<string, GateServer[]>();
    for (const s of servers) groups.set(s.dossier, [...(groups.get(s.dossier) ?? []), s]);
    for (const [folder, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (folder) out.push(h('div', { class: 'tree-row' }, h('span', { class: 'tree-item group-head gate-folder' }, icon('folder', 14), h('span', { class: 'grow ellipsis' }, folder), h('span', { class: 'count' }, String(list.length)))));
      for (const s of list) out.push(this.renderServer(b, s, folder ? 1 : 0));
    }
    if (b.connected && !b.servers.length) out.push(h('p', { class: 'muted small gate-empty' }, t('No server is allowed for you at the moment.', 'Aucun serveur ne vous est autorisé en ce moment.')));
    return out;
  }

  /** Sortie web : ouvre le navigateur dédié ; la ligne montre la navigation en cours. */
  private renderEgress(b: Gate, s: GateServer, depth: number): HTMLElement {
    const open = () => (b.connected ? this.host.openServer(b, s) : this.reconnect(b.id).then((ok) => ok && this.host.openServer(b, s)));
    const now = this.host.browsing(b, s);
    const filter = s.sortie?.domaines ? t(`Allowed sites: ${s.sortie.domaines.split(',').join(', ')}`, `Sites autorisés : ${s.sortie.domaines.split(',').join(', ')}`) : t('All of Internet (internal networks refused)', 'Tout Internet (réseaux internes refusés)');
    const title = t(`Browse the Internet through the Gate, in a dedicated browser. Sites see the Gate's address; sites visited are logged.\n${filter}`, `Naviguer sur Internet par la Gate, dans un navigateur dédié. Les sites voient l'adresse de la Gate ; les sites visités sont journalisés.\n${filter}`);
    const menu = (): (MenuItem | 'separator')[] => [
      { label: now ? t('New window', 'Nouvelle fenêtre') : t('Browse', 'Naviguer'), icon: 'play', action: open },
      { label: t('Open an address…', 'Ouvrir une adresse…'), icon: 'search', action: () => (b.connected ? this.host.browseTo(b, s) : this.reconnect(b.id).then((ok) => ok && this.host.browseTo(b, s))) },
      ...(now ? [{ label: t('Stop browsing', 'Arrêter la navigation'), icon: 'power' as const, action: () => this.host.stopBrowsing(now.id) }] : []),
    ];
    const row = h('div', { class: `tree-row${b.connected ? '' : ' disabled'}` },
      h('button', { class: 'tree-item session', style: `padding-left: ${16 + depth * 16}px`, title: s.description ? `${s.description}\n${title}` : title, onclick: open },
        h('span', { class: `dot${now ? ' on' : ''}` }),
        h('span', { class: 'grow ellipsis' }, s.nom),
        now ? h('span', { class: 'muted small', title: t(`${now.total} connection(s) since the start`, `${now.total} connexion(s) depuis le début`) }, `${now.open} · ${bytesText(now.bytes)}`) : null,
        h('span', { class: 'badge proto-rdp' }, t('BROWSE', 'NAVIGUER'))),
      now ? h('button', { class: 'icon-btn sm', title: t('Stop browsing', 'Arrêter la navigation'), 'aria-label': t(`Stop browsing through ${s.nom}`, `Arrêter la navigation par ${s.nom}`), onclick: () => this.host.stopBrowsing(now.id) }, icon('close', 12)) : null);
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, menu()); });
    return row;
  }

  private renderServer(b: Gate, s: GateServer, depth: number): HTMLElement {
    if (s.protocole === 'sortie') return this.renderEgress(b, s, depth);
    const rdp = s.protocole === 'rdp';
    const web = s.protocole === 'http' || s.protocole === 'https';
    // Sans l'extension Bureau à distance (ou Interface web), le serveur reste visible mais ne s'ouvre pas.
    const missing = (rdp && !this.host.protocolEnabled('rdp')) || (web && !this.host.protocolEnabled('web'));
    const open = () => {
      if (missing) return this.host.toast(web ? t('Enable the Web interface extension (Extensions) to open this server', 'Activez l’extension Interface web (Extensions) pour ouvrir ce serveur') : t('Enable the Remote Desktop extension (Extensions) to open this server', 'Activez l’extension Bureau à distance (Extensions) pour ouvrir ce serveur'), 'error');
      return b.connected ? this.host.openServer(b, s) : this.reconnect(b.id).then((ok) => ok && this.host.openServer(b, s));
    };
    const command = web ? `${s.protocole}://${s.hote}:${s.port}` : rdp ? `${s.hote}:${s.port}` : `ssh -p ${b.sshPort} ${b.login}%${s.nom}@${b.host}`;
    const menu = (): (MenuItem | 'separator')[] => [
      { label: t('Open', 'Ouvrir'), icon: 'play', action: open },
      ...(rdp && s.rdp_natif ? [{ label: navigator.userAgent.includes('Mac') ? t('Open in Windows App', 'Ouvrir dans Windows App') : t('Open in the Windows client (mstsc)', 'Ouvrir dans le client Windows (mstsc)'), icon: 'desktop' as const, action: () => this.openNative(b, s) }] : []),
      rdp || web
        ? { label: t('Copy the server address', 'Copier l\'adresse du serveur'), icon: 'copy', action: () => navigator.clipboard.writeText(command) }
        : { label: t('Copy the ssh command', 'Copier la commande ssh'), icon: 'copy', action: () => navigator.clipboard.writeText(command) },
    ];
    const title = web && !missing ? t(`Web interface through the Gate; pages visited are logged
${command}`, `Interface web par la Gate ; pages visitées journalisées
${command}`) : missing ? t('Enable the Remote Desktop extension to open this server', 'Activez l’extension Bureau à distance pour ouvrir ce serveur') : t(`${rdp ? 'Remote Desktop · ' : ''}${MODE_TITLE[s.mode]}\n${command}`, `${rdp ? 'Bureau à distance · ' : ''}${MODE_TITLE[s.mode]}\n${command}`);
    const row = h('div', { class: `tree-row${b.connected && !missing ? '' : ' disabled'}` },
      h('button', { class: 'tree-item session', style: `padding-left: ${16 + depth * 16}px`, title: s.description ? `${s.description}\n${title}` : title, onclick: open },
        h('span', { class: `dot${b.connected ? ' on' : ''}` }),
        h('span', { class: 'grow ellipsis' }, s.nom),
        rdp ? h('span', { class: 'badge proto-rdp' }, 'RDP') : null,
        web ? h('span', { class: 'badge proto-rdp' }, 'WEB') : null,
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

/** Octets lisibles : 812 o, 3,4 Mo… */
function bytesText(n: number): string {
  const units = [t('B', 'o'), t('KB', 'Ko'), t('MB', 'Mo'), t('GB', 'Go')];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : n} ${units[i]}`;
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
 * Ajout d'une Gate, ou reconnexion d'une Gate existant. Gère les étapes demandées par
 * la Gate : code, changement du mot de passe provisoire, enrôlement du code.
 */
export function openGateLogin(_host: GateHost, existing?: Gate): Promise<Gate | null> {
  return new Promise((resolve) => {
    let target: { host: string; apiPort: number; fingerprint: string; cloudflare?: boolean } | null = existing ? { host: existing.host, apiPort: existing.apiPort, fingerprint: existing.apiFingerprint } : null;
    let rememberAllowed = existing?.rememberAllowed ?? false;
    let result: Gate | null = null;

    const address = input({ id: 'b-address', placeholder: t('gate.example.com or 192.168.1.10:8443', 'gate.exemple.fr ou 192.168.1.10:8443'), value: existing ? `${existing.host}:${existing.apiPort}` : '' });
    const fingerprintBox = h('div', { class: 'fp', hidden: !existing }, existing?.apiFingerprint ?? '');
    const fingerprintField = h('div', { class: 'fld', hidden: true },
      h('span', {}, t('Certificate fingerprint', 'Empreinte du certificat'), h('span', { class: 'muted small' }, t(' to compare with the one given at install (or « sudo portunia-gate info » on the Gate)', ' à comparer avec celle donnée à l\'installation (ou « sudo portunia-gate info » sur la Gate)'))), fingerprintBox);
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
    const intro = h('p', { class: 'muted' }, existing ? t(`Session expired: sign in to ${existing.name} again.`, `Session expirée : reconnectez-vous à ${existing.name}.`) : t('Gate address (port 8443 by default).', 'Adresse de la Gate (port 8443 par défaut).'));
    const submit = h('button', { type: 'submit', class: 'btn primary' }, existing ? t('Connect', 'Se connecter') : t('Continue', 'Continuer'));
    const cancel = h('button', { type: 'button', class: 'btn' }, t('Cancel', 'Annuler'));
    const { dialog, form, error } = modal(existing ? `Reconnexion · ${existing.name}` : t('Add a Gate', 'Ajouter une Gate'), [
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
          const probe = await gates.probe(address.value);
          target = { host: probe.host, apiPort: probe.apiPort, fingerprint: probe.fingerprint, cloudflare: probe.cloudflare };
          rememberAllowed = probe.info.memo_mot_de_passe;
          fingerprintBox.textContent = probe.fingerprint;
          fingerprintBox.hidden = false;
          fingerprintField.hidden = false;
          intro.textContent = t(`${probe.info.nom} · Portunia Gate ${probe.info.version}${probe.cloudflare ? ' (through Cloudflare)' : ''}. Check the fingerprint before sending your password.`, `${probe.info.nom} · Portunia Gate ${probe.info.version}${probe.cloudflare ? ' (par Cloudflare)' : ''}. Vérifiez l'empreinte avant d'envoyer votre mot de passe.`);
          address.disabled = true;
          credFields.hidden = false;
          codeField.hidden = false;
          rememberRow.hidden = !rememberAllowed;
          submit.textContent = 'L\'empreinte correspond, se connecter';
          login.focus();
          return;
        }
        if (!newFields.hidden && newPassword.value !== confirmPassword.value) throw new Error(t('The two new passwords differ', 'Les deux nouveaux mots de passe diffèrent'));
        const answer: GateLoginAnswer = await gates.login({
          id: existing?.id, host: target.host, apiPort: target.apiPort, fingerprint: target.fingerprint,
          login: login.value.trim(), password: password.value || undefined, code: code.value.replace(/\s/g, '') || undefined,
          newPassword: newFields.hidden ? undefined : newPassword.value, remember: remember.checked,
          cloudflare: target.cloudflare,
        });
        if (answer.etat === 'ok') {
          result = answer.gate;
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
          qr.innerHTML = await gates.qr(answer.uri);
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

/** Sessions qui contournent la Gate : proposer de les supprimer. */
function openBypass(host: GateHost, b: Gate, list: { session: Session; server: GateServer }[]) {
  const checks = list.map(({ session, server }) => {
    const box = h('input', { type: 'checkbox', checked: true, id: `bp-${session.id}` }) as HTMLInputElement;
    return { box, session, row: h('label', { class: 'check-row' }, box, h('span', {}, h('strong', {}, session.name), ` → ${server.nom} (${MODE_LABEL[server.mode]})`)) };
  });
  const remove = h('button', { type: 'button', class: 'btn danger' }, t('Delete the checked sessions', 'Supprimer les sessions cochées'));
  const keep = h('button', { type: 'button', class: 'btn' }, t('Keep', 'Garder'));
  const { dialog } = modal(t('Sessions that bypass the Gate', 'Sessions qui contournent la Gate'), [
    h('p', {}, t(`These sessions connect directly to servers that « ${b.name} » protects: they escape access control and recording. From now on, open these servers from the Gate's section.`, `Ces sessions se connectent directement à des serveurs que « ${b.name} » protège : elles échappent au contrôle d'accès et à l'enregistrement. Ouvrez désormais ces serveurs depuis la section de la Gate.`)),
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

type Section = 'etat' | 'cibles' | 'comptes' | 'groupes' | 'regles' | 'portail' | 'rdp' | 'assistance' | 'durcissement' | 'reglages';
const SECTIONS: { id: Section; label: string; admin: boolean }[] = [
  { id: 'etat', label: t('Status', 'État'), admin: true },
  { id: 'cibles', label: t('Servers and vault', 'Serveurs et coffre'), admin: true },
  { id: 'comptes', label: t('Accounts', 'Comptes'), admin: true },
  { id: 'groupes', label: t('Groups', 'Groupes'), admin: true },
  { id: 'regles', label: t('Rules', 'Règles'), admin: true },
  { id: 'portail', label: t('Web portal', 'Portail web'), admin: true },
  { id: 'rdp', label: t('Native RDP', 'RDP natif'), admin: true },
  { id: 'assistance', label: t('Assistance', 'Assistance'), admin: true },
  { id: 'durcissement', label: t('Hardening', 'Durcissement'), admin: true },
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

/** Page d'administration d'une Gate (onglet). */
export function renderGateAdmin(b: Gate, host: GateHost): HTMLElement {
  const isAdmin = b.role === 'admin';
  const sections = SECTIONS.filter((s) => isAdmin || !s.admin);
  let current: Section = sections[0].id;
  const nav = h('div', { class: 'seg admin-nav', role: 'tablist' });
  const content = h('div', { class: 'admin-content' });
  const call = <T = any>(method: string, path: string, body?: unknown) => gates.admin<T>(b.id, method, path, body);
  const fail = (e: unknown) => host.toast(errorText(e) === 'SESSION_EXPIREE' ? t('Gate session expired: sign in again (sidebar).', 'Session de la Gate expirée : reconnectez-vous (barre latérale).') : errorText(e), 'error');

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

  // Formulaire générique en fenêtre : les erreurs de la Gate s'affichent dans la fenêtre.
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
  const actions = (...buttons: (HTMLElement | null)[]) => h('td', { class: 'acts' }, ...buttons.filter((b): b is HTMLElement => !!b));
  const small = (label: string, onclick: () => void, danger = false) => h('button', { type: 'button', class: `btn sm${danger ? ' danger' : ''}`, onclick }, label);
  const toolbar = (text: string, button?: HTMLElement) => h('div', { class: 'admin-bar' }, h('p', { class: 'muted' }, text), button ?? null);

  // --- Serveurs ---
  const targetDialog = (cur?: any) => {
    const nom = input({ id: 't-nom', value: cur?.nom ?? '' });
    const dossier = input({ id: 't-dossier', value: cur?.dossier ?? '', placeholder: t('Production, Staging…', 'Production, Recette…') });
    const description = input({ id: 't-description', value: cur?.description ?? '', maxlength: 200, placeholder: t('Agency mail, accounting app…', 'Messagerie de l\'agence, compta…') });
    const hote = input({ id: 't-hote', value: cur?.hote ?? '' });
    const port = input({ id: 't-port', value: String(cur?.port ?? 22), inputmode: 'numeric' });
    const mode = select('t-mode', [['coffre', t('Vault: account provided by the Gate', 'Coffre : compte fourni par la Gate')], ['enregistre', t('Recorded: the user\'s credentials', 'Enregistré : identifiants de l\'utilisateur')], ['rebond', t('Jump: end-to-end relay', 'Rebond : relais de bout en bout')]], cur?.mode ?? 'coffre');
    const compte = input({ id: 't-compte', value: cur?.compte ?? '' });
    const secretKind = select('t-secret', [
      ...(cur ? [['', cur.secret === 'none' ? t('None', 'Aucun') : t('Keep the current secret', 'Garder le secret actuel')] as [string, string]] : [['', t('None', 'Aucun')] as [string, string]]),
      ['generer', t('Generate a key and install it on the server', 'Générer une clé et l\'installer sur le serveur')],
      ['mot_de_passe', t('Account password', 'Mot de passe du compte')],
      ['cle', t('Existing private key', 'Clé privée existante')],
    ], cur ? '' : 'generer');
    const secretPass = input({ id: 't-secret-pass', type: 'password' });
    const secretKey = h('textarea', { id: 't-secret-key', class: 'input', rows: 5, spellcheck: 'false', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' }) as HTMLTextAreaElement;
    const webLogin = select('t-web', [
      ['auto', t('Fill in the sign-in form and submit it', 'Remplir le formulaire de connexion et le valider')],
      ['remplir', t('Fill in the form only (the user clicks)', 'Remplir le formulaire seulement (l\'utilisateur clique)')],
      ['basic', t('HTTP authentication (Basic) on every request', 'Authentification HTTP (Basic) à chaque requête')],
    ], cur?.connexion_web ?? 'auto');
    const webLoginField = field(t('Sign-in', 'Connexion'), webLogin, t('form: also for applications that sign in with JavaScript; HTTP authentication is also sent when the server asks for it', 'formulaire : aussi pour les applications qui se connectent en JavaScript ; l\'authentification HTTP est aussi envoyée si le serveur la demande'));
    const passField = field(t('Account\'s current password', 'Mot de passe actuel du compte'), secretPass, t('used only once', 'utilisé une seule fois'));
    const keyField = field(t('Private key (without passphrase)', 'Clé privée (sans phrase de passe)'), secretKey);
    const proto = select('t-proto', [['ssh', 'SSH'], ['rdp', t('Remote Desktop (RDP)', 'Bureau à distance (RDP)')], ['https', t('Web interface (HTTPS)', 'Interface web (HTTPS)')], ['http', t('Web interface (HTTP)', 'Interface web (HTTP)')], ['sortie', t('Web egress (browsing through the Gate)', 'Sortie web (navigation par la Gate)')]], cur?.protocole ?? 'ssh');
    // Sortie web (Gate 0.48) : filtre des sites, ni adresse, ni compte, ni secret.
    const egressAllow = h('textarea', { id: 't-sortie-dom', class: 'input', rows: 3, spellcheck: 'false', placeholder: 'microsoft.com, github.com' }, (cur?.sortie_domaines ?? '').split(',').filter(Boolean).join(', ')) as HTMLTextAreaElement;
    const egressBlock = h('textarea', { id: 't-sortie-bloq', class: 'input', rows: 2, spellcheck: 'false' }, (cur?.sortie_bloques ?? '').split(',').filter(Boolean).join(', ')) as HTMLTextAreaElement;
    const egressPorts = input({ id: 't-sortie-ports', value: cur?.sortie_ports ?? '80,443' });
    const egressFields = h('div', { class: 'stack', hidden: true },
      h('p', { class: 'muted small' }, t('Web egress: members of the groups given this server browse the Internet from Portunia through the Gate, in a dedicated Edge or Chrome. Sites see the Gate\'s address; each site visited is logged (connections, bytes), not the pages (HTTPS stays encrypted). Internal networks (10.x, 192.168.x, 127.x…) are always refused. Gate 0.48 and later.', 'Sortie web : les membres des groupes qui ont ce serveur naviguent sur Internet depuis Portunia par la Gate, dans un Edge ou un Chrome dédié. Les sites voient l\'adresse de la Gate ; chaque site visité est journalisé (connexions, octets), pas les pages (le HTTPS reste chiffré). Les réseaux internes (10.x, 192.168.x, 127.x…) sont toujours refusés. Gate 0.48 et suivantes.')),
      field(t('Allowed domains', 'Domaines autorisés'), egressAllow, t('comma separated; a domain covers its subdomains; empty: all of Internet', 'séparés par des virgules ; un domaine couvre ses sous-domaines ; vide : tout Internet')),
      field(t('Blocked domains', 'Domaines bloqués'), egressBlock, t('refused even when allowed above', 'refusés même s\'ils sont autorisés plus haut')),
      field(t('Allowed ports', 'Ports permis'), egressPorts, t('80,443 by default; * for all', '80,443 par défaut ; * pour tous')));
    const webNote = h('p', { class: 'muted small', hidden: true }, t('Web interface: administration consoles (vCenter, iDRAC, firewall…) and internal applications. The Gate relays every request and logs the pages opened. Opens from Portunia (dedicated window) and from the web portal. Recorded: credentials are typed in the page. Vault (Gate 0.32 and later): the Gate signs the user in with the vault account; the password never reaches the browser.', 'Interface web : consoles d\'administration (vCenter, iDRAC, pare-feu…) et applications internes. La Gate relaie chaque requête et journalise les pages ouvertes. S\'ouvre depuis Portunia (fenêtre dédiée) et depuis le portail web. Enregistré : les identifiants se tapent dans la page. Coffre (Gate 0.32 et suivantes) : la Gate connecte l\'utilisateur avec le compte du coffre ; le mot de passe n\'arrive jamais dans le navigateur.'));
    const rdpNote = h('p', { class: 'muted small', hidden: true }, t('Remote Desktop. Jump: the Gate relays the encrypted connection without reading it from Portunia; from the web portal it relays without recording. Recorded: the Gate relays and records the session, without seeing the password. In both, the user types their Windows credentials at each opening. Vault: the Gate signs in to Windows with the account it keeps (NLA required on the server) and records; the user never sees the password (Gate 0.29 and later).', 'Bureau à distance. Rebond : depuis Portunia, la Gate relaie la connexion chiffrée sans la lire ; depuis le portail web, elle relaie sans enregistrer. Enregistré : la Gate relaie et enregistre la session, sans voir le mot de passe. Dans les deux cas, l\'utilisateur tape ses identifiants Windows à chaque ouverture. Coffre : la Gate ouvre la session Windows avec le compte qu\'elle garde (NLA exigé sur le serveur) et enregistre ; l\'utilisateur ne voit jamais le mot de passe (Gate 0.29 et suivantes).'));
    // Port par défaut du protocole, tant que l'administrateur ne l'a pas changé.
    proto.addEventListener('change', () => {
      if (['22', '3389', '443', '80', ''].includes(port.value.trim())) port.value = ({ rdp: '3389', https: '443', http: '80' } as Record<string, string>)[proto.value] ?? '22';
      sync();
    });
    const addressRow = h('div', { class: 'quick-row' }, field(t('Address', 'Adresse'), hote), field('Port', port));
    const sync = () => {
      const egress = proto.value === 'sortie';
      addressRow.hidden = egress;
      egressFields.hidden = !egress;
      mode.closest('label')!.hidden = egress;
      compte.closest('label')!.hidden = egress;
      if (egress) mode.value = 'enregistre';
      const rdp = proto.value === 'rdp';
      const web = proto.value === 'http' || proto.value === 'https';
      // Interface web : mode enregistré ou coffre (pas de rebond : la Gate lit chaque requête).
      for (const o of mode.options) o.disabled = web && o.value === 'rebond';
      if (web && mode.value === 'rebond') mode.value = 'enregistre';
      webNote.hidden = !web;
      // Bureau à distance et web : le coffre garde un mot de passe, pas de clé SSH.
      for (const o of secretKind.options) o.disabled = (rdp || web) && ['generer', 'cle'].includes(o.value);
      if ((rdp || web) && ['generer', 'cle'].includes(secretKind.value)) secretKind.value = 'mot_de_passe';
      rdpNote.hidden = !rdp;
      const vault = mode.value === 'coffre' && !egress;
      webLoginField.hidden = !(web && vault);
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
      addressRow, egressFields,
      field(t('Description', 'Description'), description, t('shown on the server\'s tile in the web portal and in Portunia; empty: automatic text (Gate 0.33)', 'affichée sur la vignette du serveur dans le portail web et dans Portunia ; vide : texte automatique (Gate 0.33)')),
      field('Mode', mode), rdpNote, webNote, field(t('Account on the server', 'Compte sur le serveur'), compte, t('required in vault mode; for Remote Desktop: DOMAIN\\account, offered at opening', 'obligatoire en mode coffre ; en Bureau à distance : DOMAINE\\compte, proposé à l\'ouverture')),
      webLoginField, field(t('Vault secret', 'Secret du coffre'), secretKind), passField, keyField,
      h('p', { class: 'muted small' }, t('The secret is encrypted by the Gate and can never be read back. « Generate » creates a key, installs it with the password given only once, then checks that it works.', 'Le secret est chiffré par la Gate et ne se relit jamais. « Générer » crée une clé, l\'installe avec le mot de passe donné une seule fois, puis vérifie qu\'elle fonctionne.')),
    ];
    setTimeout(sync);
    formDialog(cur ? t(`Edit ${cur.nom}`, `Modifier ${cur.nom}`) : t('Add a server', 'Ajouter un serveur'), body, cur ? t('Save', 'Enregistrer') : t('Add', 'Ajouter'), async () => {
      const kind = mode.value === 'coffre' ? secretKind.value : '';
      const secret = kind === 'generer' ? { type: 'generer', mot_de_passe: secretPass.value }
        : kind === 'mot_de_passe' ? { type: 'mot_de_passe', valeur: secretPass.value }
        : kind === 'cle' ? { type: 'cle', valeur: secretKey.value } : undefined;
      const egress = proto.value === 'sortie';
      const payload = egress ? {
        nom: nom.value.trim(), dossier: dossier.value.trim(), hote: 'internet', port: 443, mode: 'enregistre', compte: null, protocole: 'sortie',
        description: description.value.trim(), sortie_domaines: egressAllow.value, sortie_bloques: egressBlock.value, sortie_ports: egressPorts.value.trim() || '80,443',
      } : {
        nom: nom.value.trim(), dossier: dossier.value.trim(), hote: hote.value.trim(), port: Number(port.value) || (({ rdp: 3389, https: 443, http: 80 } as Record<string, number>)[proto.value] ?? 22),
        mode: mode.value, compte: compte.value.trim() || null, secret, protocole: proto.value,
        ...(proto.value === 'http' || proto.value === 'https' ? { connexion_web: webLogin.value } : {}),
        description: description.value.trim(),
      };
      await (cur ? call('PUT', `/admin/cibles/${cur.id}`, payload) : call('POST', '/admin/cibles', payload));
      host.toast(cur ? t('Server updated', 'Serveur modifié') : t('Server added', 'Serveur ajouté'));
    });
  };

  /** Marque de Portunia Assistance (Gate 0.52) : nom et logo montrés à la personne aidée. */
  const brandBlock = (a: any): HTMLElement => {
    if (a.marque === undefined) return h('p', { class: 'muted small' }, t('Needs Portunia Gate 0.52 or later.', 'Demande Portunia Gate 0.52 ou suivante.'));
    const name = input({ id: 'a-marque', value: a.marque ?? '', maxlength: 40, placeholder: 'ACME' });
    let logo: string = a.logo ?? '';
    const preview = h('img', { class: 'assist-logo', alt: '', hidden: !logo, src: logo ? `data:image/png;base64,${logo}` : '' }) as HTMLImageElement;
    const file = h('input', { type: 'file', accept: 'image/png', class: 'input', 'aria-label': t('Logo (PNG)', 'Logo (PNG)') }) as HTMLInputElement;
    const remove = small(t('Remove the logo', 'Retirer le logo'), () => { logo = ''; preview.hidden = true; remove.hidden = true; file.value = ''; });
    remove.hidden = !logo;
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      if (chosen.size > 96 * 1024) { host.toast(t('Logo: 96 KiB at most', 'Logo : 96 Kio au plus'), 'error'); file.value = ''; return; }
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      let bin = '';
      for (const x of bytes) bin += String.fromCharCode(x);
      logo = btoa(bin);
      preview.src = `data:image/png;base64,${logo}`;
      preview.hidden = false;
      remove.hidden = false;
    });
    const saveBrand = h('button', { class: 'btn primary', onclick: async () => {
      try { await call('PUT', '/admin/assistance', { marque: name.value.trim(), logo }); host.toast(t('Brand saved: shown from the next assistance', 'Marque enregistrée : montrée dès la prochaine assistance')); reload(); } catch (e) { fail(e); }
    } }, t('Save the brand', 'Enregistrer la marque'));
    return h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, t('Portunia Assistance shows « Your company support » and its logo instead of Portunia, from the code screen on (Pro and Teams editions). PNG, 96 KiB and 512 × 512 pixels at most; a square image of 64 pixels or more looks best.', 'Portunia Assistance affiche « Assistance Votre entreprise » et son logo à la place de Portunia, dès l\'écran du code (éditions Pro et Équipes). PNG, 96 Kio et 512 × 512 pixels au plus ; une image carrée de 64 pixels ou plus rend le mieux.')),
      field(t('Company name', 'Nom de l\'entreprise'), name, t('empty: Portunia', 'vide : Portunia')),
      field(t('Logo (PNG)', 'Logo (PNG)'), file),
      h('div', { class: 'assist-url' }, preview, remove),
      h('div', {}, saveBrand));
  };

  const SECTION_RENDER: Record<Section, () => Promise<HTMLElement>> = {
    etat: async () => {
      const { renderGateStatus } = await import('./gatestatus');
      return renderGateStatus(b, { toast: host.toast, allowsUpdate: () => host.allowsUpdate(), allowsSettings: () => host.allowsAdmin(), onLevel: (id, level) => host.setHealth(id, level) });
    },
    cibles: async () => {
      const { cibles } = await call<{ cibles: any[] }>('GET', '/admin/cibles');
      const rows = cibles.map((tg) => h('tr', {},
        h('td', {}, h('strong', {}, tg.nom)), h('td', {}, tg.dossier),
        h('td', {}, tg.protocole === 'sortie' ? h('span', { class: 'muted small', title: tg.sortie_bloques ? t(`Blocked: ${tg.sortie_bloques}`, `Bloqués : ${tg.sortie_bloques}`) : '' }, `${tg.sortie_domaines || t('all of Internet', 'tout Internet')} · ports ${tg.sortie_ports}`) : h('code', {}, `${tg.hote}:${tg.port}`)),
        h('td', {}, tg.protocole === 'rdp' ? h('span', { class: 'badge proto-rdp' }, 'RDP') : null, tg.protocole === 'sortie' ? h('span', { class: 'badge proto-rdp' }, t('EGRESS', 'SORTIE')) : h('span', { class: `badge mode-${tg.mode}` }, MODE_LABEL[tg.mode as GateServer['mode']])), h('td', {}, tg.compte ?? '—'),
        h('td', {}, tg.secret === 'key' ? t('SSH key', 'Clé SSH') : tg.secret === 'password' ? t('Password', 'Mot de passe') : '—'),
        h('td', { title: tg.empreinte ?? '' }, tg.empreinte ? t('known', 'connue') : t('at first connection', 'à la 1ʳᵉ connexion')),
        actions(small(t('Edit', 'Modifier'), () => targetDialog(tg)),
          ...(tg.protocole === 'rdp' ? [small(t('Confirm the fingerprint', 'Confirmer l\x27empreinte'), async () => {
            // Gate 0.50 : en coffre, le mot de passe ne part vers le serveur qu\x27après cette confirmation.
            const p = await call<{ empreinte: string; memorisee: string | null }>('GET', `/admin/cibles/${tg.id}/empreinte`).catch(fail);
            if (!p) return;
            const before = p.memorisee && p.memorisee !== p.empreinte ? t(`
Remembered today: ${p.memorisee}`, `
Mémorisée aujourd\x27hui : ${p.memorisee}`) : '';
            if (!confirm(t(`${tg.nom} presents this certificate:
${p.empreinte}${before}

Compare it with the one of the server (Remote Desktop certificate). Remember it?`, `${tg.nom} présente ce certificat :
${p.empreinte}${before}

Comparez-la avec celle du serveur (certificat Bureau à distance). La mémoriser ?`))) return;
            await call('POST', `/admin/cibles/${tg.id}/empreinte`, { empreinte: p.empreinte }).catch(fail); reload();
          })] : []),
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
        // Gate 0.38 et suivantes : adresse e-mail (approbation, alertes).
        const email = input({ id: 'u-email', type: 'email', value: u?.email ?? '', placeholder: 'prenom.nom@exemple.fr' });
        formDialog(u ? t(`Edit ${u.login}`, `Modifier ${u.login}`) : t('Create an account', 'Créer un compte'), [
          h('div', { class: 'row2' }, field(t('Login', 'Identifiant'), login), field(t('Role', 'Rôle'), role)),
          field(t('Sign-in', 'Connexion'), policy, t(`global: ${politique_generale}`, `général : ${politique_generale}`)),
          field(t('E-mail', 'E-mail'), email, t('access requests and alerts (Gate 0.38)', 'demandes d\'accès et alertes (Gate 0.38)')),
          h('div', { class: 'fld' }, h('span', {}, t('Groups', 'Groupes')), groupNames.length ? groups.el : h('p', { class: 'muted small' }, t('No group: create some in the Groups tab.', 'Aucun groupe : créez-en dans l\'onglet Groupes.'))),
          u ? disabled.row : h('p', { class: 'muted small' }, t('A temporary password will be shown once. The user will enrol their code at their first sign-in in Portunia.', 'Un mot de passe provisoire sera affiché une fois. Le code sera enrôlé par l\'utilisateur à sa première connexion dans Portunia.')),
        ], u ? t('Save', 'Enregistrer') : t('Create', 'Créer'), async () => {
          const payload = { login: login.value.trim(), role: role.value, politique: policy.value || null, groupes: groups.values(), desactive: disabled.box.checked, email: email.value.trim() };
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
      // Téléphones enrôlés (application Android, connexion au portail par empreinte ; Gate 0.47).
      const devicesDialog = async (u: any) => {
        let list: any[] = [];
        try { list = (await call<{ appareils: any[] }>('GET', `/admin/comptes/${u.id}/appareils`)).appareils; } catch (e) { fail(e); return; }
        const when = (d?: string) => (d ? new Date(d).toLocaleString() : '—');
        const close = h('button', { type: 'button', class: 'btn' }, t('Close', 'Fermer'));
        const all = h('button', { type: 'button', class: 'btn danger' }, t('Remove all', 'Tout retirer'));
        const body = list.length
          ? list.map((d) => {
            const remove = h('button', { type: 'button', class: 'btn small' }, t('Remove', 'Retirer'));
            const row = h('div', { class: 'device-row' },
              h('div', {}, h('strong', {}, d.nom), h('div', { class: 'muted small' },
                t(`Enrolled ${when(d.enrole)} · last used ${when(d.utilise)}`, `Enrôlé le ${when(d.enrole)} · dernier usage ${when(d.utilise)}`), d.adresse ? ` · ${d.adresse}` : '')),
              remove);
            remove.addEventListener('click', async () => {
              if (!confirm(t(`Remove the phone « ${d.nom} »? Its portal sessions close; fingerprint sign-in stops on it.`, `Retirer le téléphone « ${d.nom} » ? Ses sessions du portail se ferment ; la connexion par empreinte s'arrête sur lui.`))) return;
              try { await call('DELETE', `/admin/appareils/${d.id}`); row.remove(); host.toast(t('Phone removed', 'Téléphone retiré')); } catch (e) { fail(e); }
            });
            return row;
          })
          : [h('p', { class: 'muted' }, t('No phone enrolled.', 'Aucun téléphone enrôlé.'))];
        const { dialog } = modal(t(`Phones of ${u.login}`, `Téléphones de ${u.login}`), [
          h('p', { class: 'muted small' }, t(
            'Phones enrolled in the Portunia Gate Android app: they sign in to the web portal with a fingerprint, without password or code. Resetting the password or the code, or disabling the account, removes them too.',
            'Téléphones enrôlés dans l\'application Android Portunia Gate : ils se connectent au portail web par empreinte, sans mot de passe ni code. Réinitialiser le mot de passe ou le code, ou désactiver le compte, les retire aussi.')),
          ...body,
        ], list.length ? [all, close] : [close], true);
        close.addEventListener('click', () => dialog.close());
        all.addEventListener('click', async () => {
          if (!confirm(t(`Remove every phone of ${u.login}?`, `Retirer tous les téléphones de ${u.login} ?`))) return;
          try { await call('DELETE', `/admin/comptes/${u.id}/appareils`); dialog.close(); host.toast(t('Phones removed', 'Téléphones retirés')); } catch (e) { fail(e); }
        });
        dialog.addEventListener('close', () => { dialog.remove(); reload(); });
        dialog.showModal();
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
          u.appareils ? small(t(`Phones (${u.appareils})`, `Téléphones (${u.appareils})`), () => devicesDialog(u)) : null,
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
      const [{ regles }, { groupes }, { cibles }, reglages] = await Promise.all([call<{ regles: any[] }>('GET', '/admin/regles'), call<{ groupes: any[] }>('GET', '/admin/groupes'), call<{ cibles: any[] }>('GET', '/admin/cibles'), call<any>('GET', '/admin/reglages')]);
      // Gate 0.28 et suivantes : copie de fichiers en Bureau à distance.
      const hasFiles = 'copies_fichiers_mo' in reglages;
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
        const files = checkbox('r-fichiers', t('Remote Desktop: file copy through the clipboard (logged with name, size and SHA-256)', 'Bureau à distance : copie de fichiers par le presse-papiers (tracée avec nom, taille et SHA-256)'), r?.fichiers ?? false);
        const expire = input({ id: 'r-expire', type: 'date', lang: 'fr', value: r?.expire ? String(r.expire).slice(0, 10) : '' });
        // Gate 0.38 et suivantes : accès seulement après approbation.
        const approval = checkbox('r-approbation', t('Access only after approval (reason asked, duration chosen by the approver)', 'Accès seulement après approbation (motif demandé, durée choisie par l\'approbateur)'), !!r?.approbation);
        const approvers = select('r-approbateurs', [['', t('Administrators', 'Les administrateurs')], ...groupes.map((g) => [g.nom, g.nom] as [string, string])], r?.approbateurs ?? '');
        if (!groupes.length) return host.toast(t('First create a group (Groups tab)', 'Créez d\'abord un groupe (onglet Groupes)'), 'error');
        formDialog(r ? t(`Edit rule ${r.nom}`, `Modifier la règle ${r.nom}`) : t('New rule', 'Nouvelle règle'), [
          h('div', { class: 'row2' }, field(t('Name', 'Nom'), nom), field(t('Group', 'Groupe'), groupe)),
          h('div', { class: 'fld' }, h('span', {}, t('Servers', 'Serveurs')), servers.el),
          h('div', { class: 'fld' }, h('span', {}, t('Days', 'Jours')), h('div', { class: 'days' }, ...days.map((d) => d.el))),
          h('div', { class: 'row2' }, field(t('From (hour)', 'De (heure)'), from), field(t('To (hour)', 'À (heure)'), to)),
          sftp.row, tunnels.row, keys.row, ...(hasFiles ? [files.row] : []),
          field(t('Expires on', 'Expire le'), expire, 'vide = jamais'),
          approval.row,
          field(t('Approvers', 'Approbateurs'), approvers, t('a member of this group grants access; never their own request', 'un membre de ce groupe accorde l\'accès ; jamais sa propre demande')),
        ], r ? t('Save', 'Enregistrer') : t('Create', 'Créer'), async () => {
          const mask = days.reduce((m, d, i) => m | (d.box.checked ? 1 << i : 0), 0);
          const payload = {
            nom: nom.value.trim(), groupe: groupe.value, cibles: servers.values(), sftp: sftp.box.checked, tunnels: tunnels.box.checked, frappe: keys.box.checked,
            ...(hasFiles ? { fichiers: files.box.checked } : {}),
            jours: mask, heure_debut: from.value === '' ? null : Number(from.value), heure_fin: to.value === '' ? null : Number(to.value), expire: expire.value || null,
            approbation: approval.box.checked, approbateurs: approvers.value,
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
        h('td', {}, [r.sftp && 'SFTP', r.tunnels && 'tunnels', r.frappe && t('keystrokes', 'frappe'), r.fichiers && t('RDP files', 'fichiers RDP'), r.approbation && t(`approval (${r.approbateurs || 'admins'})`, `approbation (${r.approbateurs || 'admins'})`)].filter(Boolean).join(', ') || '—'),
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
        // Gate antérieur à la 0.7 : pas de portail.
        if (/404|Not Found/i.test(errorText(e))) return h('div', { class: 'admin-section' }, toolbar(t('The web portal needs Portunia Gate 0.7 or later: update the Gate (sudo bash installer.sh update).', 'Le portail web demande Portunia Gate 0.7 ou plus récent : mettez la Gate à jour (sudo bash installer.sh mise-a-jour).')));
        throw e;
      }
      const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(p.actif), 'aria-label': t('Web portal', 'Portail web') });
      const state = h('strong', { class: p.actif ? 'ok-text' : 'muted' }, p.actif ? t('enabled', 'activé') : t('disabled', 'désactivé'));
      sw.addEventListener('click', async () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        if (!on && p.sessions_en_cours > 0 && !confirm(t(`Disabling the portal closes the ${p.sessions_en_cours} open web session(s). Continue?`, `Désactiver le portail ferme les ${p.sessions_en_cours} session(s) web en cours. Continuer ?`))) return;
        if (on && !p.url && p.mode !== 'interne') host.toast(t('First give the portal\'s public address, then save.', 'Indiquez d\'abord l\'adresse publique du portail, puis enregistrez.'), 'info');
        try { await call('PUT', '/admin/portail', { actif: on }); host.toast(on ? t('Web portal enabled', 'Portail web activé') : t('Web portal disabled', 'Portail web désactivé')); reload(); } catch (e) { fail(e); }
      });
      const tunnel = { relie: ['ok', t('connected', 'relié')], deconnecte: ['warn', t('not connected', 'non relié')], absent: ['off', t('not set up', 'non configuré')] }[p.tunnel as string] ?? ['off', p.tunnel];
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
      // Gate antérieure : code toujours exigé, sans réglage.
      const hasCodeSetting = p.code_toujours !== undefined;
      const codeAlways = checkbox('p-code', t('Require the authenticator code', 'Exiger le code d\'authentification'), p.code_toujours ?? true);      const site = input({ id: 'p-site', value: p.turnstile_site, placeholder: '0x4AAAAAA…' });
      const secret = input({ id: 'p-secret', type: 'password', placeholder: p.turnstile_secret_defini ? t('Keep the current secret key', 'Garder la clé secrète actuelle') : '0x4AAAAAA…' });
      const groupMissing = !p.groupes.includes(p.groupe);

      // Gate antérieure à la 0.17 : pas de mode d'exposition.
      const hasModes = p.mode !== undefined;
      let mode: string = p.mode ?? 'cloudflare';
      const bare = (items: string[] = []) => items.map((i) => i.replace(/\/(32|128)$/, '')).join(', ');
      const proxys = input({ id: 'p-proxys', value: bare(p.proxys), placeholder: '10.0.5.10, 10.0.5.11' });
      const entete = input({ id: 'p-entete', value: p.entete ?? 'X-Forwarded-For' });
      const reseaux = input({ id: 'p-reseaux', value: bare(p.reseaux), placeholder: '10.0.0.0/8, 192.168.91.0/24' });
      // Gate 0.39 et plus : entrée interne ouverte en même temps que l'entrée externe.
      const hasInternal = p.interne !== undefined;
      const intOpen = checkbox('p-int', t('Also open the portal on the company network (internal entry)', 'Ouvrir aussi le portail sur le réseau de l\'entreprise (entrée interne)'), !!p.interne?.actif);
      const intNets = input({ id: 'p-int-reseaux', value: bare(p.interne?.reseaux), placeholder: '10.0.0.0/8, 192.168.91.0/24' });
      const intUrl = input({ id: 'p-int-url', value: p.interne?.url ?? '', placeholder: 'https://gate.lan:8446' });
      const intCode = checkbox('p-int-code', t('Require the authenticator code on the internal entry', 'Exiger le code d\'authentification sur l\'entrée interne'), p.interne?.code_toujours ?? true);
      intOpen.box.addEventListener('change', () => drawModes());
      const internalOn = () => hasInternal && (mode === 'interne' || intOpen.box.checked);
      const MODES: { id: string; name: string; hint: string; flow: string; team?: boolean }[] = [
        hasInternal
          ? { id: 'interne', name: t('None', 'Aucune'), hint: t('Internal entry only: nothing exposed on the Internet', 'Entrée interne seulement : rien d\'exposé sur Internet'), flow: t('Workstation or VPN → HTTPS → Gate → servers', 'Poste ou VPN → HTTPS → Gate → serveurs') }
          : { id: 'interne', name: t('Internal or VPN', 'Interne ou VPN'), hint: t('Nothing exposed on the Internet', 'Rien d\'exposé sur Internet'), flow: t('Workstation or VPN → HTTPS → Gate → servers', 'Poste ou VPN → HTTPS → Gate → serveurs') },
        { id: 'cloudflare', name: 'Cloudflare', hint: t('Tunnel: no inbound port', 'Tunnel : aucun port entrant'), flow: t('Browser → Cloudflare ← outbound tunnel ← Gate → servers', 'Navigateur → Cloudflare ← tunnel sortant ← Gate → serveurs') },
        { id: 'direct', name: t('Direct HTTPS', 'HTTPS direct'), hint: t('No proxy, small organisations', 'Sans proxy, petites structures'), flow: t('Browser → HTTPS → Gate → servers', 'Navigateur → HTTPS → Gate → serveurs') },
        { id: 'proxy', name: t('Proxy or WAF', 'Proxy ou WAF'), hint: 'F5, Imperva, HAProxy, Nginx…', team: true, flow: t('Browser → WAF in the DMZ → HTTPS → Gate → servers', 'Navigateur → WAF en DMZ → HTTPS → Gate → serveurs') },
        { id: 'relais', name: t('Dedicated relay', 'Relais dédié'), hint: t('DMZ, no flow to the internal network', 'DMZ, sans flux vers l\'interne'), team: true, flow: t('Browser → HTTPS → relay in the DMZ ← outbound connection ← Gate → servers', 'Navigateur → HTTPS → relais en DMZ ← connexion sortante ← Gate → serveurs') },
      ];
      const modeBody = h('div', { class: 'admin-section' });
      let pairing = '';
      const relayName = input({ id: 'p-relais-nom', placeholder: 'dmz-01' });
      const relayAddress = input({ id: 'p-relais-adresse', placeholder: '10.0.5.20:8447' });
      const relayBody = () => {
        const relays: any[] = p.relais ?? [];
        const seen = (r: any) => (r.vu ? new Date(r.vu).toLocaleString() : t('never', 'jamais'));
        return h('div', { class: 'admin-section' },
          relays.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
            h('thead', {}, h('tr', {}, ...[t('Relay', 'Relais'), t('Address', 'Adresse'), t('State', 'État'), 'Version', ''].map((c) => h('th', {}, c)))),
            h('tbody', {}, ...relays.map((r) => h('tr', {},
              h('td', {}, h('b', {}, r.nom)), h('td', {}, r.adresse),
              h('td', { title: r.erreur ?? '' }, r.connecte ? h('b', { class: 'chip ok' }, t('connected', 'connecté')) : h('b', { class: 'chip warn' }, mode === p.mode ? t('offline', 'hors ligne') : t('waiting for the mode to be saved', 'en attente du mode')), h('span', { class: 'muted small' }, r.connecte ? '' : ` ${r.erreur ?? ''} · ${t('last seen', 'vu')} ${seen(r)}`)),
              h('td', {}, r.version || '—'),
              h('td', {}, small(t('Revoke', 'Révoquer'), async () => {
                if (!confirm(t(`Revoke the relay « ${r.nom} »? Web sessions close and this machine must be paired again.`, `Révoquer le relais « ${r.nom} » ? Les sessions web se ferment et cette machine devra être réappairée.`))) return;
                try { await call('DELETE', `/admin/portail/relais/${r.id}`); host.toast(t('Relay revoked', 'Relais révoqué')); reload(); } catch (e) { fail(e); }
              }, true))))))) : h('p', { class: 'muted small' }, t('No relay yet.', 'Aucun relais pour l\'instant.')),
          h('div', { class: 'row2' },
            field(t('Relay name', 'Nom du relais'), relayName),
            field(t('Address the Gate reaches it at', 'Adresse où la Gate le joint'), relayAddress, t('the relay never calls the Gate', 'le relais n\'appelle jamais la Gate'))),
          h('div', {}, h('button', { class: 'btn', onclick: async () => {
            try {
              const r = await call<any>('POST', '/admin/portail/relais', { nom: relayName.value.trim(), adresse: relayAddress.value.trim() });
              pairing = `sudo bash installer.sh relay ${r.code} ${url.value.replace(/^https:\/\//, '').trim()}`;
              p = await call<any>('GET', '/admin/portail');
              relayName.value = ''; relayAddress.value = '';
              drawModes();
            } catch (e) { fail(e); }
          } }, t('Add a relay', 'Ajouter un relais'))),
          pairing && h('p', {}, h('b', {}, t('On the relay machine (shown only once):', 'Sur la machine du relais (affiché une seule fois) :'))),
          pairing && h('div', { class: 'hardening-command' },
            h('div', { class: 'fp' }, pairing),
            h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(pairing).then(() => host.toast(t('Copied', 'Copié'))) }, t('Copy', 'Copier'))),
          h('p', { class: 'muted small' }, t('Firewall: port 443 from browsers to the relay, port 8447 from the Gate to the relay, nothing from the relay to the internal network. The relay holds neither vault, accounts nor database.', 'Pare-feu : port 443 des navigateurs vers le relais, port 8447 de la Gate vers le relais, rien du relais vers le réseau interne. Le relais ne contient ni coffre, ni comptes, ni base.')));
      };
      // Tunnel lancé par la Gate (0.19 et suivantes) : jeton collé ici, cloudflared géré par elle.
      const managed = p.tunnel_gere;
      // Gate 0.41 et plus : API, SSH et RDP natif publiés par Cloudflare en TCP (cloudflared sur le poste).
      let cfa: any = null;
      try { cfa = await call<any>('GET', '/admin/acces-cloudflare'); } catch { /* Gate antérieure */ }
      const cfApi = input({ id: 'p-cf-api', value: cfa?.hotes?.api ?? '', placeholder: 'gate-api.votre-domaine.fr' });
      const cfSsh = input({ id: 'p-cf-ssh', value: cfa?.hotes?.ssh ?? '', placeholder: 'gate-ssh.votre-domaine.fr' });
      const cfRdp = input({ id: 'p-cf-rdp', value: cfa?.hotes?.rdp ?? '', placeholder: 'gate-rdp.votre-domaine.fr' });
      const cfToken = input({ id: 'p-cf-token', type: 'password', placeholder: t('Cloudflare API token (not kept)', 'Jeton d\'API Cloudflare (pas gardé)') });
      const cfResult = h('div', { class: 'muted small' });
      const saveCf = async (publish: boolean) => {
        if (publish && !cfToken.value.trim()) { cfToken.focus(); return; }
        cfResult.className = 'muted small';
        cfResult.textContent = publish ? t('Publishing in Cloudflare…', 'Publication dans Cloudflare…') : '';
        try {
          const r = await call<any>('PUT', '/admin/acces-cloudflare', { api: cfApi.value, ssh: cfSsh.value, rdp: cfRdp.value, jeton_api: publish ? cfToken.value.trim() : undefined });
          cfToken.value = '';
          cfResult.className = 'ok-text small';
          cfResult.replaceChildren(...(r.fait?.length ? r.fait : [t('Host names saved.', 'Noms d\'hôte enregistrés.')]).map((l: string) => h('div', {}, '✓ ', l)));
          host.toast(t('Access from outside saved', 'Accès de l\'extérieur enregistré'));
        } catch (e) { cfResult.textContent = ''; fail(e); }
      };
      const cfAccessBody = () => h('div', { class: 'admin-section' },
        h('h3', {}, t('Access from outside with Portunia and RDP clients', 'Accès de l\'extérieur avec Portunia et les clients RDP')),
        h('p', { class: 'muted small' }, t(
          'Cloudflare carries only HTTPS: Portunia (API, SSH) and mstsc or Windows App go through cloudflared on the workstation, which carries the TCP connection to the Gate. Encryption stays end to end: Cloudflare only sees encrypted bytes, and Portunia still checks the Gate\'s fingerprints. Portunia downloads and starts cloudflared by itself when the Gate does not answer directly.',
          'Cloudflare ne transporte que du HTTPS : Portunia (API, SSH) et mstsc ou Windows App passent par cloudflared sur le poste, qui transporte la connexion TCP jusqu\'à la Gate. Le chiffrement reste de bout en bout : Cloudflare ne voit que des octets chiffrés, et Portunia vérifie toujours les empreintes de la Gate. Portunia télécharge et lance cloudflared lui-même quand la Gate ne répond pas directement.')),
        h('div', { class: 'row2' },
          field(t('API host name', 'Nom d\'hôte de l\'API'), cfApi, t('Portunia: sign-in, servers, administration, Remote Desktop tab', 'Portunia : connexion, serveurs, administration, onglet Bureau à distance')),
          field(t('SSH host name', 'Nom d\'hôte du SSH'), cfSsh, t('SSH terminals and jump servers', 'terminaux SSH et rebonds'))),
        h('div', { class: 'row2' },
          field(t('Native RDP host name', 'Nom d\'hôte du RDP natif'), cfRdp, cfa && !cfa.rdp_natif_actif ? t('native RDP is off on this Gate (RDP settings)', 'RDP natif coupé sur cette Gate (réglages RDP)') : t('mstsc, Windows App', 'mstsc, Windows App')),
          field(t('Cloudflare API token', 'Jeton d\'API Cloudflare'), cfToken, t('rights: Account › Cloudflare Tunnel › Edit and Zone › DNS › Edit; used once, never kept', 'droits : Account › Cloudflare Tunnel › Edit et Zone › DNS › Edit ; utilisé une fois, jamais gardé'))),
        h('div', { class: 'cert-actions' },
          h('button', { class: 'btn primary', onclick: () => saveCf(true) }, t('Publish in Cloudflare', 'Publier dans Cloudflare')),
          small(t('Save the names only', 'Enregistrer les noms seulement'), () => saveCf(false))),
        h('p', { class: 'muted small' }, t(
          'Publish: the Gate adds a TCP route per name to its tunnel (to its own API, SSH and native RDP ports, never to your servers) and creates the DNS records; an existing record is never overwritten. By hand: Routes › Add route › Published application, type TCP, URL localhost:8443, localhost:2222 and localhost:3390, then save the names here. Optional: a Cloudflare Access application on these names adds a sign-in to Cloudflare before the Gate.',
          'Publier : la Gate ajoute à son tunnel une route TCP par nom (vers ses propres ports de l\'API, du SSH et du RDP natif, jamais vers vos serveurs) et crée les enregistrements DNS ; un enregistrement existant n\'est jamais écrasé. À la main : Routes › Add route › Published application, type TCP, URL localhost:8443, localhost:2222 et localhost:3390, puis enregistrez les noms ici. En option : une application Cloudflare Access sur ces noms ajoute une connexion à Cloudflare avant la Gate.')),
        h('p', { class: 'muted small' }, t(
          'Without Portunia (mstsc): cloudflared access rdp --hostname <RDP name> --url localhost:13389, then mstsc to localhost:13389.',
          'Sans Portunia (mstsc) : cloudflared access rdp --hostname <nom RDP> --url localhost:13389, puis mstsc vers localhost:13389.')),
        cfResult);
      const tunnelToken = input({ id: 'p-tunnel', type: 'password', placeholder: t('eyJh… or the whole install command', 'eyJh… ou toute la commande d\'installation') });
      const tunnelState = h('div', { class: 'tunnel-state' });
      const checkResult = h('p', { class: 'muted small' });
      const TUNNEL_STATES: Record<string, [string, string]> = {
        arrete: ['off', t('stopped', 'arrêté')], telechargement: ['warn', t('downloading cloudflared', 'téléchargement de cloudflared')],
        demarrage: ['warn', t('starting', 'démarrage')], relie: ['ok', t('connected', 'relié')],
        deconnecte: ['warn', t('not connected', 'non relié')], erreur: ['err', t('error', 'erreur')],
      };
      const drawTunnelState = (g: any) => {
        const [cls, label] = TUNNEL_STATES[g.etat] ?? ['off', g.etat];
        const since = g.depuis ? ` · ${t('since', 'depuis')} ${new Date(g.depuis).toLocaleString()}` : '';
        tunnelState.replaceChildren(...[
          h('div', {}, h('b', { class: `chip ${cls}` }, label),
            h('span', { class: 'muted small' }, g.etat === 'relie' ? ` ${g.connexions} ${t('connection(s) to Cloudflare', 'connexion(s) vers Cloudflare')}${since}` : since)),
          g.erreur && h('p', { class: 'gate-warn' }, g.erreur),
        ].filter(Boolean) as HTMLElement[]);
      };
      const copyBox = (text: string) => h('div', { class: 'hardening-command' }, h('div', { class: 'fp' }, text),
        h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(text).then(() => host.toast(t('Copied', 'Copié'))).catch(() => {}) }, t('Copy', 'Copier')));
      const saveToken = async (value: string) => {
        try {
          await call('PUT', '/admin/portail', { tunnel_jeton: value, mode: 'cloudflare' });
          host.toast(value ? t('Token saved: the Gate starts the tunnel', 'Jeton enregistré : la Gate démarre le tunnel') : t('Token removed: tunnel stopped', 'Jeton effacé : tunnel arrêté'));
          reload();
        } catch (e) { fail(e); }
      };
      const cloudflareBody = () => {
        const g = managed;
        drawTunnelState(g);
        return h('div', { class: 'admin-section' }, ...[
          g.jeton_defini && tunnelState,
          !g.jeton_defini && g.externe && h('p', { class: 'muted small' }, t(
            `A cloudflared installed beside the Gate serves the tunnel (${g.externe_relie ? 'connected' : 'not connected'}). To manage it from here, paste the same token, then remove the old one (sudo cloudflared service uninstall).`,
            `Un cloudflared installé à côté de la Gate sert le tunnel (${g.externe_relie ? 'relié' : 'non relié'}). Pour le gérer d'ici, collez le même jeton, puis retirez l'ancien (sudo cloudflared service uninstall).`)),
          h('ol', { class: 'tunnel-steps' },
            h('li', {}, t('Create the tunnel in Cloudflare: Networking › Tunnels › Create Tunnel, a name (e.g. portunia-gate), then copy the installation command shown, for any system. It holds the token; do not run it.', 'Créez le tunnel dans Cloudflare : Networking › Tunnels › Create Tunnel, un nom (ex. portunia-gate), puis copiez la commande d\'installation affichée, pour n\'importe quel système. Elle contient le jeton ; ne l\'exécutez pas.')),
            h('li', {}, g.jeton_defini
              ? h('div', { class: 'tunnel-token' }, h('span', {}, t('Tunnel', 'Tunnel'), ' ', h('code', {}, g.tunnel_id ?? '?')),
                small(t('Replace', 'Remplacer'), () => { tokenRow.hidden = false; tunnelToken.focus(); }),
                small(t('Remove', 'Effacer'), () => { if (confirm(t('Remove the token? The Gate stops the tunnel and the portal is no longer reachable through Cloudflare.', 'Effacer le jeton ? La Gate arrête le tunnel et le portail n\'est plus joignable par Cloudflare.'))) saveToken(''); }, true))
              : h('span', {}, t('Paste it here and save: the Gate starts the tunnel, which turns Healthy in Cloudflare.', 'Collez-la ici et enregistrez : la Gate démarre le tunnel, qui passe à Healthy dans Cloudflare.')),
              tokenRow),
            h('li', {}, t('In the tunnel: Routes tab › Add route › Published application. Subdomain and Domain (the Full hostname is your public address), Path empty, Service URL below, then Add route. Never add routes to your servers: they would bypass the Gate.', 'Dans le tunnel : onglet Routes › Add route › Published application. Subdomain et Domain (le Full hostname est votre adresse publique), Path vide, Service URL ci-dessous, puis Add route. Jamais de route vers vos serveurs : elle contournerait la Gate.'), copyBox(g.service)),
            h('li', {}, t('Public address below: https:// followed by the Full hostname. Save, then test:', 'Adresse publique ci-dessous : https:// suivi du Full hostname. Enregistrez, puis testez :'), ' ',
              small(t('Test the public address', 'Tester l\'adresse publique'), async () => {
                checkResult.className = 'muted small';
                checkResult.textContent = t('Testing…', 'Essai…');
                try {
                  const r = await call<any>('POST', '/admin/portail/tester');
                  checkResult.className = r.ok ? 'ok-text small' : 'gate-warn';
                  checkResult.textContent = r.message;
                } catch (e) { checkResult.textContent = ''; fail(e); }
              }), checkResult)),
          g.jeton_defini && cfa && cfAccessBody(),
          g.jeton_defini && 'maj_auto' in g && tunnelVersion(g),
          h('p', { class: 'muted small' }, t(
            `cloudflared ${g.version ?? ''} is downloaded by the Gate from Cloudflare's GitHub, its fingerprint checked, and run under the Gate's account: nothing to install, no root, no inbound port. The token is kept encrypted by the vault.`,
            `cloudflared ${g.version ?? ''} est téléchargé par la Gate depuis le GitHub de Cloudflare, son empreinte vérifiée, et lancé sous le compte de la Gate : rien à installer, pas de root, aucun port entrant. Le jeton est gardé chiffré par le coffre.`)),
        ].filter(Boolean) as HTMLElement[]);
      };
      // Gate 0.45 et plus : version de cloudflared suivie et mise à jour automatique.
      const tunnelVersion = (g: any) => {
        if (g.maj_systeme) return h('p', { class: 'muted small' }, t('cloudflared given by PORTUNIA_GATE_CLOUDFLARED: kept up to date by the system.', 'cloudflared donné par PORTUNIA_GATE_CLOUDFLARED : tenu à jour par le système.'));
        const auto = h('input', { type: 'checkbox', id: 'p-tunnel-auto' }) as HTMLInputElement;
        auto.checked = !!g.maj_auto;
        auto.onchange = async () => {
          try {
            await call('PUT', '/admin/portail', { tunnel_maj_auto: auto.checked });
            host.toast(auto.checked ? t('cloudflared updated automatically', 'cloudflared mis à jour automatiquement') : t('cloudflared updates: manual', 'Mises à jour de cloudflared : manuelles'));
          } catch (e) { auto.checked = !auto.checked; fail(e); }
        };
        const status = g.maj_prete
          ? h('span', { class: 'chip warn' }, t(`${g.maj_prete} installed, started when nobody is connected`, `${g.maj_prete} installée, lancée quand personne n'est connecté`))
          : g.version_dispo
            ? h('span', { class: 'chip warn' }, t(`${g.version_dispo} available`, `${g.version_dispo} disponible`))
            : g.maj_verifiee && h('span', { class: 'chip ok' }, t('up to date', 'à jour'));
        const checked = g.maj_verifiee ? ` · ${t('checked', 'vérifié le')} ${new Date(g.maj_verifiee).toLocaleString()}` : '';
        return h('div', { class: 'admin-section' }, ...[
          h('h3', {}, t('cloudflared version', 'Version de cloudflared')),
          h('div', {}, h('b', {}, g.version ?? '—'), ' ', status || '', h('span', { class: 'muted small' }, checked)),
          g.maj_erreur && h('p', { class: 'gate-warn' }, g.maj_erreur),
          h('label', { class: 'check' }, auto, ' ', t('Update automatically', 'Mettre à jour automatiquement')),
          h('p', { class: 'muted small' }, t(
            'The Gate checks Cloudflare\'s releases every 6 hours, checks the fingerprint given twice by GitHub, then restarts the tunnel on the new version when no session is open; after a day of waiting, at night (3 to 5 am) with a notice to connected users. The restart cuts connections from outside for a few seconds.',
            'La Gate consulte les versions de Cloudflare toutes les 6 heures, vérifie l\'empreinte donnée deux fois par GitHub, puis relance le tunnel sur la nouvelle version quand aucune session n\'est ouverte ; après un jour d\'attente, la nuit (3 h à 5 h) en prévenant les personnes connectées. La relance coupe les connexions de l\'extérieur quelques secondes.')),
          small(t('Update now', 'Mettre à jour maintenant'), async () => {
            if (!confirm(t('Install the latest cloudflared now? The tunnel restarts: connections from outside are cut for a few seconds.', 'Installer le dernier cloudflared maintenant ? Le tunnel redémarre : les connexions de l\'extérieur sont coupées quelques secondes.'))) return;
            try {
              await call('POST', '/admin/portail/tunnel-maj');
              host.toast(t('The Gate checks and restarts the tunnel if a newer version exists', 'La Gate vérifie et relance le tunnel si une version plus récente existe'));
              window.setTimeout(reload, 15000);
            } catch (e) { fail(e); }
          }),
        ].filter(Boolean) as HTMLElement[]);
      };
      const tokenRow = h('div', { class: 'tunnel-token' }, tunnelToken,
        h('button', { class: 'btn primary', onclick: () => { if (tunnelToken.value.trim()) saveToken(tunnelToken.value.trim()); } }, t('Save the token', 'Enregistrer le jeton')));
      if (managed?.jeton_defini) {
        tokenRow.hidden = true;
        // État du tunnel suivi en direct tant que l'onglet est affiché.
        const timer = window.setInterval(async () => {
          if (!tunnelState.isConnected) { window.clearInterval(timer); return; }
          try { const q = await call<any>('GET', '/admin/portail'); if (q.tunnel_gere) drawTunnelState(q.tunnel_gere); } catch { /* prochain essai */ }
        }, 4000);
      }
      // Écoute HTTPS pilotée depuis l'administration (Gate 0.20 et suivantes).
      const https = p.ecoute?.https;
      const httpsAddress = input({ id: 'p-https', value: p.ecoute?.proxy ?? '', placeholder: '0.0.0.0:8446' });
      const applyHttps = async (value: string) => {
        try {
          await call('PUT', '/admin/portail', { https: value });
          host.toast(value ? t('HTTPS listening applied within seconds', 'Écoute HTTPS appliquée sous quelques secondes') : t('HTTPS listening closed', 'Écoute HTTPS fermée'));
          window.setTimeout(reload, 4000);
        } catch (e) { fail(e); }
      };
      const httpsBody = () => {
        const state = https.ouverte
          ? h('b', { class: 'chip ok' }, `${t('listening on', 'en écoute sur')} ${https.ouverte}`)
          : https.erreur ? h('b', { class: 'chip err' }, t('error', 'erreur'))
          : p.ecoute.proxy ? h('b', { class: 'chip warn' }, t('starting', 'démarrage')) : h('b', { class: 'chip off' }, t('closed', 'fermée'));
        const port = (https.ouverte ?? p.ecoute.proxy ?? '0.0.0.0:8446').split(':').pop();
        return h('div', { class: 'admin-section' }, ...[
          h('div', {}, h('b', {}, t('HTTPS listening', 'Écoute HTTPS')), ' ', state),
          https.erreur && h('p', { class: 'gate-warn' }, https.erreur),
          https.fixe
            ? h('p', { class: 'muted small' }, t(
              `Set by PORTUNIA_GATE_PORTAL_TLS_LISTEN in the configuration file (${p.ecoute.proxy}): change it there, or remove it to manage it from here.`,
              `Fixée par PORTUNIA_GATE_PORTAL_TLS_LISTEN dans le fichier de configuration (${p.ecoute.proxy}) : changez-la là, ou retirez-la pour la gérer d'ici.`))
            : h('div', { class: 'tunnel-token' }, httpsAddress,
              h('button', { class: 'btn primary', onclick: () => applyHttps(httpsAddress.value.trim() || '8446') }, p.ecoute.proxy ? t('Apply', 'Appliquer') : t('Open', 'Ouvrir')),
              p.ecoute.proxy && small(t('Close', 'Fermer'), () => { if (confirm(t('Close HTTPS listening? Browsers can no longer reach the portal in this mode.', 'Fermer l\'écoute HTTPS ? Les navigateurs ne joignent plus le portail dans ce mode.'))) applyHttps(''); }, true)),
          h('p', { class: 'muted small' }, t(
            `A port, or address:port. Open port ${port} on the firewall in front of the Gate; from the Internet, redirect 443 to it on the box or the firewall. Hardened firewall: 8446 is already allowed.`,
            `Un port, ou adresse:port. Ouvrez le port ${port} sur le pare-feu devant la Gate ; depuis Internet, redirigez-y le 443 sur la box ou le pare-feu. Pare-feu durci : le 8446 est déjà autorisé.`)),
        ].filter(Boolean) as HTMLElement[]);
      };
      // Certificat du portail (Gate 0.21 et suivantes) : PKI (PEM, PFX) ou Let's Encrypt.
      const certificate = p.certificat;
      let acme = p.acme;
      const CERT_SOURCES: Record<string, string> = {
        auto: t('self-signed', 'auto-signé'), importe: t('imported', 'importé'), acme: 'Let\'s Encrypt', fichier: t('configuration file', 'fichier de configuration'),
      };
      const ACME_STATES: Record<string, [string, string]> = {
        inactif: ['off', t('off', 'inactif')], en_attente: ['warn', t('waiting', 'en attente')], en_cours: ['warn', t('in progress', 'en cours')],
        obtenu: ['ok', t('obtained', 'obtenu')], erreur: ['err', t('error', 'erreur')],
      };
      let certPanel: '' | 'import' | 'acme' = acme?.actif ? 'acme' : '';
      const certBox = h('div', { class: 'admin-section' });
      const certFile = h('input', { type: 'file', id: 'p-cert', accept: '.pem,.crt,.cer,.pfx,.p12' }) as HTMLInputElement;
      const keyFile = h('input', { type: 'file', id: 'p-cle', accept: '.pem,.key' }) as HTMLInputElement;
      const pfxPassword = input({ id: 'p-pfx', type: 'password', autocomplete: 'new-password' });
      const host0 = (p.url ?? '').replace(/^https:\/\//, '').split(/[/:]/)[0];
      const acmeDomains = input({ id: 'p-acme-noms', value: (acme?.domaines ?? []).join(', ') || host0, placeholder: 'portail.example.com' });
      const acmeEmail = input({ id: 'p-acme-email', type: 'email', value: acme?.email ?? '', placeholder: t('optional', 'facultatif') });
      const acmeMethod = select('p-acme-methode', [
        ['tls-alpn', t('TLS-ALPN-01: port 443 redirected to the HTTPS listener', 'TLS-ALPN-01 : port 443 redirigé vers l\'écoute HTTPS')],
        ['dns-cloudflare', t('DNS-01 through Cloudflare: nothing to open, wildcard allowed', 'DNS-01 par Cloudflare : rien à ouvrir, générique permis')],
      ], acme?.methode ?? 'tls-alpn');
      const acmeToken = input({ id: 'p-acme-jeton', type: 'password', placeholder: acme?.cloudflare_defini ? t('Saved: leave empty to keep it', 'Enregistré : laisser vide pour le garder') : t('API token (Zone › DNS › Edit)', 'Jeton d\'API (Zone › DNS › Edit)') });
      const acmeStaging = checkbox('p-acme-essai', t('Let\'s Encrypt staging (test certificate, not trusted by browsers)', 'Autorité d\'essai de Let\'s Encrypt (certificat de test, non reconnu par les navigateurs)'), !!acme?.essai);
      const acmeTerms = checkbox('p-acme-cgu', t('I accept the Let\'s Encrypt Subscriber Agreement', 'J\'accepte les conditions d\'utilisation de Let\'s Encrypt'), !!acme?.actif);
      const tokenField = field(t('Cloudflare API token', 'Jeton d\'API Cloudflare'), acmeToken, t('My Profile › API Tokens › Create Token › Edit zone DNS; kept encrypted by the vault', 'My Profile › API Tokens › Create Token › Edit zone DNS ; gardé chiffré par le coffre'));
      acmeMethod.addEventListener('change', () => { tokenField.hidden = acmeMethod.value !== 'dns-cloudflare'; drawCert(); });
      tokenField.hidden = acmeMethod.value !== 'dns-cloudflare';
      const readBytes = (f: File) => new Promise<Uint8Array>((ok, ko) => {
        const r = new FileReader();
        r.onload = () => ok(new Uint8Array(r.result as ArrayBuffer));
        r.onerror = () => ko(r.error);
        r.readAsArrayBuffer(f);
      });
      const toBase64 = (bytes: Uint8Array) => {
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      };
      const importCert = async () => {
        const f = certFile.files?.[0];
        if (!f) { host.toast(t('Choose the certificate file', 'Choisissez le fichier du certificat')); return; }
        try {
          const bytes = await readBytes(f);
          const text = new TextDecoder().decode(bytes);
          const body: Record<string, unknown> = text.includes('-----BEGIN')
            ? { certificat: text, cle: keyFile.files?.[0] ? new TextDecoder().decode(await readBytes(keyFile.files[0])) : '' }
            : { pfx: toBase64(bytes), mot_de_passe: pfxPassword.value };
          const r = await call<any>('PUT', '/admin/portail/certificat', body);
          host.toast(t(`Certificate imported: ${r.certificat.noms.join(', ')}`, `Certificat importé : ${r.certificat.noms.join(', ')}`));
          reload();
        } catch (e) { fail(e); }
      };
      const saveAcme = async (actif: boolean) => {
        const body: Record<string, unknown> = {
          actif, domaines: acmeDomains.value.split(/[\s,;]+/).filter(Boolean), email: acmeEmail.value.trim(),
          methode: acmeMethod.value, essai: acmeStaging.box.checked, conditions: acmeTerms.box.checked,
        };
        if (acmeToken.value.trim()) body.cloudflare_jeton = acmeToken.value.trim();
        try {
          acme = await call<any>('PUT', '/admin/portail/acme', body);
          acmeToken.value = '';
          host.toast(actif ? t('Let\'s Encrypt enabled: certificate requested', 'Let\'s Encrypt activé : certificat demandé') : t('Let\'s Encrypt disabled', 'Let\'s Encrypt désactivé'));
          drawCert();
          followAcme();
        } catch (e) { fail(e); }
      };
      // Suivi de la demande en cours, tant que l'onglet est affiché.
      let following = false;
      const followAcme = () => {
        if (following) return;
        following = true;
        const timer = window.setInterval(async () => {
          if (!certBox.isConnected) { window.clearInterval(timer); following = false; return; }
          try {
            const q = await call<any>('GET', '/admin/portail');
            const done = !['en_attente', 'en_cours'].includes(q.acme?.etat);
            const changed = q.certificat?.info?.empreinte !== p.certificat?.info?.empreinte;
            acme = q.acme;
            if (changed) p.certificat = q.certificat;
            drawCert();
            if (done) { window.clearInterval(timer); following = false; }
          } catch { /* prochain essai */ }
        }, 3000);
      };
      const drawCert = () => {
        const c = p.certificat;
        const info = c?.info;
        const date = (d?: string) => (d ? new Date(d).toLocaleDateString() : '—');
        const days = c?.jours ?? 0;
        const expiry = info && h('b', { class: `chip ${days < 0 ? 'err' : c.alerte ? 'warn' : 'ok'}` },
          days < 0 ? t('expired', 'expiré') : t(`${days} days left`, `encore ${days} jours`));
        const [acmeCls, acmeLabel] = ACME_STATES[acme?.etat] ?? ['off', acme?.etat ?? ''];
        const toggle = (panel: 'import' | 'acme', label: string) => small(label, () => { certPanel = certPanel === panel ? '' : panel; drawCert(); });
        certBox.replaceChildren(...[
          h('div', {}, h('b', {}, t('Portal certificate', 'Certificat du portail')), ' ', info ? h('b', { class: 'chip off' }, CERT_SOURCES[info.source] ?? info.source) : null, ' ', expiry),
          info && h('p', { class: 'muted small' },
            `${info.noms.join(', ') || info.sujet} · ${t('issued by', 'émis par')} ${info.emetteur} · ${t('valid until', 'valable jusqu\'au')} ${date(info.expire)}`,
            h('br'), `${t('Fingerprint', 'Empreinte')} ${info.empreinte}`),
          info?.source === 'auto' && h('p', { class: 'muted small' }, t('Self-signed: browsers show a warning. Import your PKI certificate or use Let\'s Encrypt.', 'Auto-signé : les navigateurs affichent un avertissement. Importez le certificat de votre PKI ou utilisez Let\'s Encrypt.')),
          c?.alerte && info?.source !== 'acme' && h('p', { class: 'gate-warn' }, t('The certificate expires soon: import the renewed one.', 'Le certificat expire bientôt : importez celui qui le renouvelle.')),
          c?.erreur && h('p', { class: 'gate-warn' }, c.erreur),
          c?.fixe
            ? h('p', { class: 'muted small' }, t('Set by PORTUNIA_GATE_PORTAL_TLS_CERT and PORTUNIA_GATE_PORTAL_TLS_KEY in the configuration file: replace the files there (taken within seconds), or remove the variables to manage it from here.', 'Fixé par PORTUNIA_GATE_PORTAL_TLS_CERT et PORTUNIA_GATE_PORTAL_TLS_KEY dans le fichier de configuration : remplacez les fichiers là (pris en compte sous quelques secondes), ou retirez les variables pour le gérer d\'ici.'))
            : h('div', { class: 'cert-actions' },
              toggle('import', t('Import a certificate…', 'Importer un certificat…')),
              toggle('acme', 'Let\'s Encrypt…'),
              (info?.source === 'importe' || info?.source === 'acme') && small(t('Back to self-signed', 'Revenir à l\'auto-signé'), async () => {
                if (!confirm(t('Go back to the self-signed certificate? Let\'s Encrypt renewal stops and browsers show a warning again.', 'Revenir au certificat auto-signé ? Le renouvellement Let\'s Encrypt s\'arrête et les navigateurs affichent de nouveau un avertissement.'))) return;
                try { await call('DELETE', '/admin/portail/certificat'); host.toast(t('Self-signed certificate restored', 'Certificat auto-signé rétabli')); reload(); } catch (e) { fail(e); }
              }, true)),
          !c?.fixe && certPanel === 'import' && h('div', { class: 'cert-panel' },
            h('p', { class: 'muted small' }, t('From your internal or public PKI: a PEM certificate with its chain and its unencrypted key, or a PFX file (.pfx, .p12) and its password. Applied within seconds, without restarting the Gate.', 'De votre PKI interne ou publique : un certificat PEM avec sa chaîne et sa clé non chiffrée, ou un fichier PFX (.pfx, .p12) et son mot de passe. Appliqué sous quelques secondes, sans redémarrer la Gate.')),
            h('div', { class: 'row2' },
              field(t('Certificate (PEM or PFX)', 'Certificat (PEM ou PFX)'), certFile, t('with the intermediate certificates', 'avec les certificats intermédiaires')),
              field(t('Private key (PEM)', 'Clé privée (PEM)'), keyFile, t('if not in the certificate file', 'si elle n\'est pas dans le fichier du certificat'))),
            field(t('PFX password', 'Mot de passe du PFX'), pfxPassword, t('PFX only', 'PFX seulement')),
            h('div', {}, h('button', { class: 'btn primary', onclick: importCert }, t('Import', 'Importer')))),
          !c?.fixe && certPanel === 'acme' && h('div', { class: 'cert-panel' },
            h('div', {}, h('b', {}, 'Let\'s Encrypt'), ' ', h('span', { class: 'chip pro' }, 'PRO'), ' ', h('b', { class: `chip ${acmeCls}` }, acmeLabel),
              acme?.etape && acme?.etat === 'en_cours' ? h('span', { class: 'muted small' }, ` ${acme.etape}…`) : null),
            acme?.erreur && h('p', { class: 'gate-warn' }, acme.erreur),
            acme?.actif && acme?.prochaine && h('p', { class: 'muted small' }, acme.etat === 'erreur'
              ? t(`Next automatic try: ${new Date(acme.prochaine).toLocaleString()}`, `Prochain essai automatique : ${new Date(acme.prochaine).toLocaleString()}`)
              : t(`Automatic renewal from ${date(acme.prochaine)}`, `Renouvellement automatique à partir du ${date(acme.prochaine)}`)),
            field(t('Domain names', 'Noms de domaine'), acmeDomains, t('separated by commas; they must point to this Gate (TLS-ALPN-01) or be in a Cloudflare zone (DNS-01)', 'séparés par des virgules ; ils doivent pointer vers cette Gate (TLS-ALPN-01) ou être dans une zone Cloudflare (DNS-01)')),
            h('div', { class: 'row2' }, field(t('Check', 'Vérification'), acmeMethod), field(t('Contact email', 'E-mail de contact'), acmeEmail, t('for Let\'s Encrypt', 'pour Let\'s Encrypt'))),
            tokenField,
            acmeMethod.value === 'tls-alpn' && h('p', { class: 'muted small' }, t('TLS-ALPN-01: open HTTPS listening above, then redirect port 443 of the public address to it (box, firewall). Let\'s Encrypt connects to it to check the name.', 'TLS-ALPN-01 : ouvrez l\'écoute HTTPS ci-dessus, puis redirigez-y le port 443 de l\'adresse publique (box, pare-feu). Let\'s Encrypt s\'y connecte pour vérifier le nom.')),
            acmeStaging.row,
            acmeTerms.row,
            h('p', { class: 'muted small' }, acme?.conditions ?? 'https://letsencrypt.org/repository/'),
            h('div', { class: 'cert-actions' },
              h('button', { class: 'btn primary', onclick: () => saveAcme(true) }, acme?.actif ? t('Save and request', 'Enregistrer et demander') : t('Enable and request', 'Activer et demander')),
              acme?.actif && small(t('Renew now', 'Renouveler maintenant'), async () => {
                try { await call('POST', '/admin/portail/acme/renouveler'); acme = { ...acme, etat: 'en_cours', erreur: null }; drawCert(); followAcme(); } catch (e) { fail(e); }
              }),
              acme?.actif && small(t('Disable', 'Désactiver'), () => { if (confirm(t('Stop Let\'s Encrypt renewal? The current certificate stays until it expires.', 'Arrêter le renouvellement Let\'s Encrypt ? Le certificat en place reste jusqu\'à son échéance.'))) saveAcme(false); }, true)),
            h('p', { class: 'muted small' }, t('The Gate renews the certificate 30 days before it expires, by itself. The account and the token are kept encrypted by the vault.', 'La Gate renouvelle le certificat 30 jours avant son échéance, seule. Le compte et le jeton sont gardés chiffrés par le coffre.'))),
          h('p', { class: 'muted small' }, t('Separate from the API certificate: changing it does not affect Portunia consoles.', 'Distinct du certificat de l\'API : le changer ne touche pas les consoles Portunia.')),
        ].filter(Boolean) as HTMLElement[]);
      };
      if (certificate) {
        drawCert();
        if (['en_attente', 'en_cours'].includes(acme?.etat)) followAcme();
      }
      const drawModes = () => {
        const current = MODES.find((m) => m.id === mode)!;
        const listened = (mode !== 'cloudflare' && mode !== 'relais') || internalOn();
        const needsListener = listened && !p.ecoute.proxy && !https;
        modeBody.replaceChildren(...[
          h('div', { class: 'expo-modes' }, ...MODES.map((m) => h('button', {
            type: 'button', class: `expo-mode${m.id === mode ? ' on' : ''}`, 'aria-pressed': String(m.id === mode),
            onclick: () => { mode = m.id; drawModes(); },
          }, h('span', { class: 'expo-name' }, h('b', {}, m.name), m.team && h('span', { class: 'chip pro' }, t('TEAMS', 'ÉQUIPES'))), h('span', { class: 'muted small' }, m.hint)))),
          h('p', { class: 'expo-flow' }, current.flow),
          mode === 'proxy' && h('div', { class: 'row2' },
            field(t('Trusted proxies', 'Proxys de confiance'), proxys, t('any other address is refused', 'toute autre adresse est refusée')),
            field(t('Visitor address header', 'En-tête de l\'adresse réelle'), entete, t('read from the right: what the visitor writes is ignored', 'lu de droite à gauche : ce que le visiteur écrit est ignoré'))),
          mode === 'proxy' && h('p', { class: 'muted small' }, t('The WAF must let the web socket and WebAssembly files through.', 'Le WAF doit laisser passer le WebSocket et les fichiers WebAssembly.')),
          (mode === 'direct' || (!hasInternal && mode === 'interne')) && field(t('Allowed networks', 'Réseaux autorisés'), reseaux, mode === 'interne' ? t('empty: private networks', 'vide : les réseaux privés') : t('empty: the whole Internet', 'vide : tout Internet')),
          mode === 'direct' && h('p', { class: 'gate-warn' }, t('The Gate is then directly exposed and it holds the vault: limit the allowed networks, or prefer a proxy.', 'La Gate est alors exposée directement et elle détient le coffre : limitez les réseaux autorisés, ou préférez un proxy.')),
          mode === 'relais' && relayBody(),
          mode === 'cloudflare' && managed && cloudflareBody(),
          hasInternal && h('h3', {}, t('Internal entry', 'Entrée interne')),
          hasInternal && mode !== 'interne' && intOpen.row,
          hasInternal && h('p', { class: 'muted small' }, mode === 'interne'
            ? t('Workstations of the company network (or VPN) reach the portal over the HTTPS listener below.', 'Les postes du réseau de l\'entreprise (ou du VPN) joignent le portail par l\'écoute HTTPS ci-dessous.')
            : t('Workstations of the company network reach the portal directly over the HTTPS listener below, while the external entry stays open. The Gate decides the entry from the connection, never from what the browser says.', 'Les postes du réseau de l\'entreprise joignent le portail directement par l\'écoute HTTPS ci-dessous, en même temps que l\'entrée externe. La Gate décide de l\'entrée d\'après la connexion, jamais d\'après ce que dit le navigateur.')),
          internalOn() && h('div', { class: 'row2' },
            field(t('Internal networks', 'Réseaux internes'), intNets, t('empty: private networks (10/8, 172.16/12, 192.168/16)', 'vide : les réseaux privés (10/8, 172.16/12, 192.168/16)')),
            field(t('Internal address', 'Adresse interne'), intUrl, t('the one typed on the network; empty: any name of the Gate', 'celle tapée sur le réseau ; vide : tout nom de la Gate'))),
          internalOn() && intCode.row,
          internalOn() && mode === 'proxy' && h('p', { class: 'muted small' }, t('The trusted proxies always count as the external entry, even with a private address.', 'Les proxys de confiance comptent toujours comme l\'entrée externe, même avec une adresse privée.')),
          listened && https && httpsBody(),
          listened && certificate && certBox,
          needsListener && h('p', { class: 'gate-warn' }, t(
            'HTTPS listening is off on this Gate. Set PORTUNIA_GATE_PORTAL_TLS_LISTEN=0.0.0.0:8446 in /etc/portunia-gate/portunia-gate.env, restart the Gate and open the port.',
            'L\'écoute HTTPS est coupée sur cette Gate. Réglez PORTUNIA_GATE_PORTAL_TLS_LISTEN=0.0.0.0:8446 dans /etc/portunia-gate/portunia-gate.env, redémarrez la Gate et ouvrez le port.')),
        ].filter(Boolean) as HTMLElement[]);
      };
      if (hasModes) drawModes();
      const save = h('button', { class: 'btn primary', onclick: async () => {
        const body: Record<string, unknown> = {
          url: url.value.trim(), groupe: groupe.value, duree_h: Number(duree.value), inactivite_min: Number(idle.value),
          presse_papiers: clip.box.checked, turnstile_site: site.value.trim(),
        };
        if (hasCodeSetting) body.code_toujours = codeAlways.box.checked;
        if (secret.value.trim()) body.turnstile_secret = secret.value.trim();
        if (!site.value.trim() && p.turnstile_secret_defini) body.turnstile_secret = '';
        if (hasModes) Object.assign(body, { mode, proxys: [proxys.value], entete: entete.value.trim(), reseaux: [reseaux.value] });
        if (hasInternal) Object.assign(body, {
          interne_actif: mode === 'interne' || intOpen.box.checked, interne_reseaux: [intNets.value],
          interne_url: intUrl.value.trim(), interne_code_toujours: intCode.box.checked,
        });
        try { await call('PUT', '/admin/portail', body); host.toast(t('Web portal saved', 'Portail web enregistré')); reload(); } catch (e) { fail(e); }
      } }, t('Save', 'Enregistrer'));

      return h('div', { class: 'admin-section form-narrow' },
        h('div', { class: 'portal-head' }, sw, h('div', {},
          h('div', {}, h('b', {}, t('Web portal', 'Portail web')), ' · ', state),
          h('p', { class: 'muted small' }, t('Access to SSH servers from a browser, without Portunia. Disabled: the page shows « Portal closed » and open web sessions close.', 'Accès aux serveurs SSH depuis un navigateur, sans Portunia. Désactivé : la page affiche « Portail fermé » et les sessions web en cours se ferment.')))),
        h('div', { class: 'portal-stats' },
          stat(p.sessions_en_cours, t('open web sessions', 'sessions web en cours')), stat(p.connexions_jour, t('sign-ins today', 'connexions aujourd\'hui')), stat(p.echecs_jour, t('failures today', 'échecs aujourd\'hui')),
          (p.mode ?? 'cloudflare') === 'cloudflare' && h('div', { class: 'portal-stat' }, h('b', { class: `chip ${tunnel[0]}` }, tunnel[1]), h('span', {}, t('Cloudflare tunnel', 'tunnel Cloudflare')))),
        h('div', {}, closeAll),
        hasModes && h('h3', {}, hasInternal ? t('External entry', 'Entrée externe') : t('Exposure mode', 'Mode d\'exposition')),
        hasModes && modeBody,
        h('h3', {}, t('Address', 'Adresse')),
        field(t('Public address', 'Adresse publique'), url, t('the one visitors type; checked at every connection', 'celle que tapent les visiteurs ; vérifiée à chaque connexion')),
        h('p', { class: 'muted small' }, t(
          mode !== 'cloudflare' || managed ? '' : `The Gate serves the portal on ${p.ecoute.tunnel} (Cloudflare Tunnel)${p.ecoute.proxy ? ` and ${p.ecoute.proxy} over HTTPS (Cloudflare proxy, Cloudflare addresses only)` : ''}. Install the tunnel: sudo bash installer.sh portal.`,
          mode !== 'cloudflare' || managed ? '' : `La Gate sert le portail sur ${p.ecoute.tunnel} (Cloudflare Tunnel)${p.ecoute.proxy ? ` et ${p.ecoute.proxy} en HTTPS (proxy Cloudflare, adresses de Cloudflare seulement)` : ''}. Installer le tunnel : sudo bash installer.sh portail.`)),
        h('h3', {}, t('Who and for how long', 'Qui et combien de temps')),
        field(t('Allowed group', 'Groupe autorisé'), groupe, groupMissing ? t(`the group « ${p.groupe} » does not exist yet: create it in Groups and add the accounts to it`, `le groupe « ${p.groupe} » n'existe pas encore : créez-le dans Groupes et ajoutez-y les comptes`) : t('only its members can sign in to the portal', 'seuls ses membres peuvent se connecter au portail')),
        h('div', { class: 'row2' }, field(t('Web session duration', 'Durée d\'une session web'), duree), field(t('Close after inactivity', 'Fermeture après inactivité'), idle)),
        clip.row,
        hasCodeSetting && codeAlways.row,
        h('p', { class: 'muted small' }, hasCodeSetting
          ? t('Password always required. Code: this box applies to accounts that follow the general setting; an account with its own sign-in combinations follows them (« password »: no code, « password+totp »: code). First sign-in and lost code are handled in Portunia. Servers in jump mode: only with Portunia for now.', 'Mot de passe toujours exigé. Code : cette case vaut pour les comptes qui suivent le réglage général ; un compte qui a ses propres combinaisons de connexion les suit (« password » : sans code, « password+totp » : avec code). Première connexion et code perdu se font dans Portunia. Serveurs en mode rebond et Bureau à distance : seulement avec Portunia pour l\'instant.')
          : t('Always required on the portal: password and code. First sign-in and lost code are handled in Portunia. Servers in jump mode: only with Portunia for now.', 'Toujours exigés sur le portail : mot de passe et code. Première connexion et code perdu se font dans Portunia. Serveurs en mode rebond et Bureau à distance : seulement avec Portunia pour l\'instant.')),
        h('h3', {}, t('Anti-bot (Cloudflare Turnstile)', 'Anti-robots (Cloudflare Turnstile)')),
        h('div', { class: 'row2' }, field(t('Site key', 'Clé du site'), site), field(t('Secret key', 'Clé secrète'), secret, t('kept encrypted by the Gate', 'gardée chiffrée par la Gate'))),
        h('div', {}, save));
    },

    assistance: async () => {
      let a: any;
      try {
        a = await call<any>('GET', '/admin/assistance');
      } catch (e) {
        // Gate antérieur à la 0.11 : pas de relais d'assistance.
        if (/404|Not Found/i.test(errorText(e))) return h('div', { class: 'admin-section' }, toolbar(t('Remote assistance needs Portunia Gate 0.11 or later: update the Gate (sudo bash installer.sh update).', 'L\'assistance à distance demande Portunia Gate 0.11 ou plus récent : mettez la Gate à jour (sudo bash installer.sh mise-a-jour).')));
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
          h('p', { class: 'muted small' }, t('Lets helpers take control of a PC with Portunia Assistance: the person downloads it from the page below and reads a code. The relay only passes on encrypted data.', 'Permet aux dépanneurs de prendre la main sur un PC avec Portunia Assistance : la personne le télécharge sur la page ci-dessous et lit un code. Le relais ne fait que transmettre des données chiffrées.')))),
        h('div', { class: 'portal-stats' },
          stat(a.en_attente, t('people waiting', 'personnes en attente')), stat(a.aujourd_hui, t('assistance today', 'assistances aujourd\'hui')), stat(a.total, t('in total', 'en tout')),
          h('div', { class: 'portal-stat' }, h('b', { class: `chip ${a.programme ? 'ok' : 'warn'}` }, a.programme ? t('ready', 'prêt') : t('missing', 'absent')), h('span', {}, 'Portunia Assistance'))),
        h('h3', {}, t('Page for the person helped', 'Page de la personne aidée')),
        a.adresse
          ? h('div', { class: 'assist-url' }, h('code', {}, a.adresse), small(t('Copy', 'Copier'), () => { navigator.clipboard.writeText(a.adresse).then(() => host.toast(t('Copied', 'Copié'))).catch(() => {}); }))
          : h('p', { class: 'muted small' }, t('Set the public address in Web portal first: the page and the relay use it (Cloudflare Tunnel).', 'Réglez d\'abord l\'adresse publique dans Portail web : la page et le relais l\'utilisent (Cloudflare Tunnel).')),
        a.programme ? null : h('p', { class: 'muted small' }, t('The Gate downloads Portunia Assistance from the Portunia releases when the relay is enabled (Internet access needed).', 'La Gate télécharge Portunia Assistance depuis les versions de Portunia à l\'activation du relais (accès Internet nécessaire).')),
        h('h3', {}, t('Who and for how long', 'Qui et combien de temps')),
        field(t('Group of helpers', 'Groupe des dépanneurs'), groupe, groupMissing ? t(`the group « ${a.groupe} » does not exist yet: create it in Groups and add the accounts to it`, `le groupe « ${a.groupe} » n'existe pas encore : créez-le dans Groupes et ajoutez-y les comptes`) : t('only its members can start an assistance from Portunia', 'seuls ses membres peuvent lancer une assistance depuis Portunia')),
        field(t('Maximum duration of an assistance', 'Durée maximale d\'une assistance'), duree),
        h('div', {}, save),
        h('h3', {}, t('Company name and logo', 'Nom et logo de l\'entreprise')),
        brandBlock(a));
    },

    // Entrée RDP native (Gate 0.31) : mstsc, Remmina, FreeRDP ou Windows App avec un fichier .rdp à usage unique.
    rdp: async () => {
      let r: any;
      try {
        r = await call<any>('GET', '/admin/rdp-natif');
      } catch (e) {
        if (/404|Not Found/i.test(errorText(e))) return h('div', { class: 'admin-section' }, toolbar(t('The native RDP entry needs Portunia Gate 0.31 or later: update the Gate.', 'L\'entrée RDP native demande Portunia Gate 0.31 ou suivant : mettez la Gate à jour.')));
        throw e;
      }
      const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(r.actif), 'aria-label': t('Native RDP entry', 'Entrée RDP native') });
      const stateText = r.ecoute
        ? h('strong', { class: 'ok-text' }, t(`listening on ${r.ecoute}`, `en écoute sur ${r.ecoute}`))
        : r.erreur
          ? h('strong', { class: 'danger-text' }, r.erreur)
          : h('strong', { class: 'muted' }, r.actif ? t('starting…', 'démarrage…') : t('closed', 'fermée'));
      sw.addEventListener('click', async () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        try {
          await call('PUT', '/admin/rdp-natif', { actif: on });
          host.toast(on ? t('Native RDP entry open', 'Entrée RDP native ouverte') : t('Native RDP entry closed; sessions under way continue', 'Entrée RDP native fermée ; les sessions en cours continuent'));
          // L'écoute s'ouvre sous 3 secondes.
          setTimeout(reload, on ? 3500 : 0);
        } catch (e) { fail(e); }
      });
      const port = h('input', { id: 'r-port', class: 'input', type: 'number', min: 1, max: 65535, value: String(r.port) }) as HTMLInputElement;
      const adresse = h('input', { id: 'r-adresse', class: 'input', spellcheck: 'false', value: r.adresse ?? '', placeholder: t('empty: the Gate\'s address in Portunia', 'vide : l\'adresse de la Gate dans Portunia') }) as HTMLInputElement;
      const MODES: [string, string][] = [['rebond', t('Jump (end to end, nothing recorded)', 'Rebond (de bout en bout, rien n\'est enregistré)')], ['coffre', t('Vault (the Gate signs in with the vault account)', 'Coffre (la Gate ouvre la session avec le compte du coffre)')], ['enregistre', t('Recorded (Windows account typed in Portunia)', 'Enregistré (compte Windows tapé dans Portunia)')]];
      const boxes = MODES.map(([id, label]) => ({ id, ...checkbox(`r-mode-${id}`, label, (r.modes ?? []).includes(id)) }));
      const validity = select('r-jeton', [['60', t('1 minute', '1 minute')], ['120', t('2 minutes', '2 minutes')], ['300', t('5 minutes', '5 minutes')], ['600', t('10 minutes', '10 minutes')]].concat([60, 120, 300, 600].includes(r.jeton_s) ? [] : [[String(r.jeton_s), `${r.jeton_s} s`]]) as [string, string][], String(r.jeton_s));
      const save = h('button', { class: 'btn primary', onclick: async () => {
        try {
          await call('PUT', '/admin/rdp-natif', { port: Number(port.value), adresse: adresse.value.trim(), modes: boxes.filter((x) => x.box.checked).map((x) => x.id), jeton_s: Number(validity.value) });
          host.toast(t('Native RDP saved (applied within 3 seconds)', 'RDP natif enregistré (appliqué sous 3 secondes)'));
          setTimeout(reload, 3500);
        } catch (e) { fail(e); }
      } }, t('Save', 'Enregistrer'));
      return h('div', { class: 'admin-section form-narrow' },
        h('div', { class: 'portal-head' }, sw, h('div', {},
          h('div', {}, h('b', {}, t('Native RDP entry', 'Entrée RDP native')), ' · ', stateText),
          h('p', { class: 'muted small' }, t('Lets users open the Gate\'s Remote Desktop servers in an ordinary RDP client (mstsc, Windows App, Remmina, FreeRDP): Portunia prepares a single-use .rdp file. The Gate still checks the rules, records and keeps the vault account. Portunia and the web portal keep working as before.', 'Permet d\'ouvrir les serveurs Bureau à distance de la Gate dans un client RDP ordinaire (mstsc, Windows App, Remmina, FreeRDP) : Portunia prépare un fichier .rdp à usage unique. La Gate vérifie toujours les règles, enregistre et garde le compte du coffre. Portunia et le portail web fonctionnent comme avant.')))),
        h('h3', {}, t('Listening', 'Écoute')),
        field(t('Port', 'Port'), port, t('3390 by default; open it on the firewall (with Docker, publish it: PORTUNIA_GATE_RDP_PORT)', '3390 par défaut ; ouvrez-le sur le pare-feu (avec Docker, publiez-le : PORTUNIA_GATE_RDP_PORT)')),
        field(t('Address in the .rdp files', 'Adresse dans les fichiers .rdp'), adresse, t('host or host:port reached by the users, if it differs from the Gate\'s address in Portunia (NAT, DNS name)', 'hôte ou hôte:port joint par les utilisateurs, s\'il diffère de l\'adresse de la Gate dans Portunia (NAT, nom DNS)')),
        h('h3', {}, t('Servers reachable this way', 'Serveurs accessibles ainsi')),
        h('div', { class: 'check-list' }, ...boxes.map((x) => x.row)),
        field(t('Validity of a .rdp file', 'Validité d\'un fichier .rdp'), validity, t('single use; the Windows account of the recorded mode is forgotten at the same time', 'usage unique ; le compte Windows du mode enregistré est oublié en même temps')),
        h('h3', {}, t('Certificate shown to RDP clients', 'Certificat présenté aux clients RDP')),
        h('div', { class: 'fp' }, r.empreinte ?? ''),
        h('p', { class: 'muted small' }, t('In vault and recorded modes the RDP client sees the Gate\'s API certificate: without a company certificate (sudo portunia-gate info), it warns once; compare this fingerprint before accepting. In jump mode it sees the Windows server\'s own certificate.', 'En modes coffre et enregistré, le client RDP voit le certificat de l\'API de la Gate : sans certificat d\'entreprise (sudo portunia-gate info), il avertit une fois ; comparez cette empreinte avant d\'accepter. En rebond, il voit le certificat du serveur Windows lui-même.')),
        h('div', {}, save));
    },


    // Lecture seule : le durcissement se pilote sur le serveur, avec les droits de root.
    durcissement: async () => {
      let d: any;
      try {
        d = await call<any>('GET', '/admin/durcissement');
      } catch (e) {
        if (/404|Not Found/i.test(errorText(e))) return h('div', { class: 'admin-section' }, toolbar(t('This view needs Portunia Gate 0.16 or later: update the Gate.', 'Cette vue demande Portunia Gate 0.16 ou suivant : mettez la Gate à jour.')));
        throw e;
      }
      const command = (label: string, text: string) => h('div', { class: 'fld' }, h('span', {}, label),
        h('div', { class: 'hardening-command' }, h('div', { class: 'fp' }, text),
          h('button', { type: 'button', class: 'btn', onclick: () => navigator.clipboard.writeText(text).then(() => host.toast(t('Command copied', 'Commande copiée'))).catch(fail) }, t('Copy', 'Copier'))));
      const commands = h('div', {},
        h('h3', {}, t('On the server', 'Sur le serveur')),
        h('p', { class: 'muted small' }, t('Hardening changes the firewall and services: it runs on the server, as root, never from Portunia. For a server dedicated to the Gate only.', 'Le durcissement modifie le pare-feu et les services : il se lance sur le serveur, en root, jamais depuis Portunia. Pour un serveur dédié à la Gate uniquement.')),
        command(t('See the plan, without changing anything', 'Voir le plan, sans rien changer'), t('sudo bash installer.sh harden plan', 'sudo bash installer.sh durcir simulation')),
        command(t('Harden', 'Durcir'), t('sudo bash installer.sh harden', 'sudo bash installer.sh durcir')),
        command(t('Undo', 'Annuler'), t('sudo bash installer.sh harden undo', 'sudo bash installer.sh durcir annuler')));
      if (!d.actif) return h('div', { class: 'admin-section form-narrow' }, h('p', {}, t('This server is not hardened.', 'Ce serveur n\'est pas durci.')), commands);
      const e = d.etat ?? {};
      const stat = (label: string, on: boolean, text?: string) => h('div', { class: 'portal-stat' }, h('b', { class: `chip ${on ? 'ok' : 'warn'}` }, text ?? (on ? t('active', 'actif') : t('absent', 'absent'))), h('span', { class: 'muted small' }, label));
      const firewall = e.pare_feu_prevu === false ? stat(t('Firewall', 'Pare-feu'), false, t('on the host', 'sur l\'hôte')) : stat(t('Firewall', 'Pare-feu'), !!e.pare_feu);
      const messages: Record<string, string> = {
        illisible: t('The state written by the server is unreadable.', 'L\'état écrit par le serveur est illisible.'),
        ancien: t('The state has not been read for over an hour: check the portunia-gate-etat.timer task on the server.', 'L\'état n\'a pas été relevé depuis plus d\'une heure : vérifiez la tâche portunia-gate-etat.timer sur le serveur.'),
        pare_feu: t('The firewall is no longer active.', 'Le pare-feu n\'est plus actif.'),
        services: t(`Stopped services are running again: ${(e.services_relances ?? []).join(', ')}.`, `Des services arrêtés tournent de nouveau : ${(e.services_relances ?? []).join(', ')}.`),
      };
      const alerts: string[] = d.alertes ?? [];
      return h('div', { class: 'admin-section form-narrow' },
        h('div', { class: 'portal-stats' }, firewall, stat(t('System SSH', 'SSH du système'), !!e.ssh), stat(t('Kernel', 'Noyau'), !!e.noyau), stat(t('Security updates', 'Mises à jour de sécurité'), !!e.mises_a_jour)),
        ...alerts.map((a) => h('p', { class: 'form-error' }, messages[a] ?? a)),
        h('p', { class: 'muted small' }, t(`${e.services_arretes ?? 0} services stopped.`, `${e.services_arretes ?? 0} services arrêtés.`), ' ',
          e.date ? t(`Read on ${new Date(e.date).toLocaleString()}.`, `Relevé le ${new Date(e.date).toLocaleString()}.`) : ''),
        h('p', { class: 'muted small' }, t('Reported by the server itself: a dashboard, not proof if the server is compromised.', 'Relevé par le serveur lui-même : un tableau de bord, pas une preuve si le serveur est compromis.')),
        commands);
    },

    reglages: async () => {
      const r = await call<any>('GET', '/admin/reglages');
      // Gate 0.38 et suivantes : notifications (courriel, Teams, webhook).
      const n = await call<any>('GET', '/admin/notifications').catch(() => null);
      const nom = input({ id: 's-nom', value: r.nom });
      const banner = h('textarea', { id: 's-banner', class: 'input', rows: 3 }, r.banniere) as HTMLTextAreaElement;
      const policy = select('s-policy', POLICIES.slice(1).some(([v]) => v === r.politique) ? POLICIES.slice(1) : [...POLICIES.slice(1), [r.politique, r.politique]], r.politique);
      const hours = input({ id: 's-hours', type: 'number', min: 1, max: 168, value: r.duree_session_h });
      const memo = checkbox('s-memo', t('Allow Portunia to remember the password (the code is still asked)', 'Autoriser Portunia à mémoriser le mot de passe (le code reste demandé)'), r.memo_mot_de_passe);
      const own = checkbox('s-own', t('Each account can replay its own sessions (gate\'s « My sessions » menu)', 'Chaque compte peut relire ses propres sessions (menu « Mes sessions » de la Gate)'), !!r.relecture_propres);
      // Gate 0.36 et suivantes : prévenir l'utilisateur d'une session suivie en direct.
      const notice = r.direct_prevenir === undefined ? null : checkbox('s-notice', t('Tell the user when their session is followed live (SSH terminal)', 'Prévenir l\'utilisateur quand sa session est suivie en direct (terminal SSH)'), !!r.direct_prevenir);
      const sensitive = h('textarea', { id: 's-sensitive', class: 'input', rows: 4, spellcheck: 'false' }, (r.commandes_sensibles ?? []).join('\n')) as HTMLTextAreaElement;
      // Langue de la Gate (Portunia Gate 0.9 et suivants) : menu SSH, bannière par défaut, journaux.
      const langue = r.langue === undefined ? null : select('s-langue', [['', t('System language', 'Langue du système')], ['en', 'English'], ['fr', 'Français']], r.langue);
      // Gate 0.28 et suivantes : copies des fichiers copiés en Bureau à distance, gardées par session.
      const copies = r.copies_fichiers_mo === undefined ? null : input({ id: 's-copies', type: 'number', min: 0, max: 10240, value: String(r.copies_fichiers_mo) });
      // Gate 0.39 et suivantes : jours de conservation des enregistrements (0 : toujours).
      const retention = r.conservation_jours === undefined ? null : input({ id: 's-retention', type: 'number', min: 0, max: 36500, value: String(r.conservation_jours) });
      const journalDays = r.journal_jours === undefined ? null : input({ id: 's-journal-days', type: 'number', min: 0, max: 36500, value: String(r.journal_jours) });
      const notificationsBlock = (n: any) => {
        const host_ = input({ id: 'n-host', value: n.smtp_hote, placeholder: 'smtp.exemple.fr' });
        const port = input({ id: 'n-port', type: 'number', min: 1, max: 65535, value: String(n.smtp_port || 587) });
        const security = select('n-sec', [['starttls', 'STARTTLS (587)'], ['tls', 'TLS (465)'], ['aucune', t('None (25)', 'Aucune (25)')]], n.smtp_securite || 'starttls');
        const user = input({ id: 'n-user', value: n.smtp_compte, autocomplete: 'off' });
        const pass = input({ id: 'n-pass', type: 'password', autocomplete: 'new-password', placeholder: n.smtp_mot_de_passe ? t('saved — type to replace', 'enregistré — tapez pour remplacer') : '' });
        const from = input({ id: 'n-from', value: n.smtp_expediteur, placeholder: 'Portunia Gate <gate@exemple.fr>' });
        const teams = input({ id: 'n-teams', value: n.teams_url, placeholder: 'https://…' });
        const hook = input({ id: 'n-hook', value: n.webhook_url, placeholder: 'https://…' });
        const newSecret = checkbox('n-secret', n.webhook_secret ? t('New signing secret (the current one stops working)', 'Nouveau secret de signature (l\'actuel ne marchera plus)') : t('Sign the webhook (secret shown once)', 'Signer le webhook (secret affiché une fois)'), false);
        const testTo = input({ id: 'n-test', type: 'email', placeholder: t('address for the test e-mail', 'adresse du courriel d\'essai') });
        const save = h('button', { class: 'btn primary', onclick: async () => {
          try {
            const res = await call<any>('PUT', '/admin/notifications', {
              smtp_hote: host_.value, smtp_port: Number(port.value) || 587, smtp_securite: security.value, smtp_compte: user.value,
              ...(pass.value ? { smtp_mot_de_passe: pass.value } : {}), smtp_expediteur: from.value, teams_url: teams.value, webhook_url: hook.value,
              nouveau_secret_webhook: newSecret.box.checked,
            });
            pass.value = '';
            host.toast(t('Notification settings saved', 'Réglages des notifications enregistrés'));
            if (res.secret_webhook) showSecret(t('Webhook signing secret', 'Secret de signature du webhook'), t('Give it to the receiving service; it is shown only once:', 'Donnez-le au service destinataire ; il n\'est affiché qu\'une fois :'), res.secret_webhook);
          } catch (e) { fail(e); }
        } }, t('Save', 'Enregistrer'));
        const test = h('button', { class: 'btn', onclick: async () => {
          try {
            const res = await call<any>('POST', '/admin/notifications/essai', { email: testTo.value || null });
            const line = (name: string, x: any) => (x ? `${name} : ${x.ok ? '✓' : `✗ ${x.erreur}`}` : '');
            host.toast([line(t('E-mail', 'Courriel'), res.courriel), line('Teams', res.teams), line('Webhook', res.webhook)].filter(Boolean).join('\n') || t('Nothing to test: set up a channel first.', 'Rien à essayer : réglez d\'abord un canal.'));
          } catch (e) { fail(e); }
        } }, t('Send a test', 'Envoyer un essai'));
        return h('div', { class: 'admin-section form-narrow' },
          h('h3', {}, t('Notifications', 'Notifications')),
          h('p', { class: 'muted small' }, t('Used by access approval (and alerts): e-mail to the approvers and to the requester, Microsoft Teams channel, signed JSON webhook.', 'Utilisées par l\'approbation des accès (et les alertes) : courriel aux approbateurs et au demandeur, canal Microsoft Teams, webhook JSON signé.')),
          h('div', { class: 'row2' }, field(t('SMTP server', 'Serveur SMTP'), host_), field('Port', port)),
          h('div', { class: 'row2' }, field(t('Security', 'Sécurité'), security), field(t('Sender', 'Expéditeur'), from)),
          h('div', { class: 'row2' }, field(t('SMTP account', 'Compte SMTP'), user, t('empty: no authentication', 'vide : sans authentification')), field(t('SMTP password', 'Mot de passe SMTP'), pass)),
          field('Microsoft Teams', teams, t('« Workflows » webhook of the channel', 'webhook « Workflows » du canal')),
          field('Webhook', hook, t('JSON POST, X-Portunia-Gate-Signature: HMAC-SHA256 of « date.body »', 'POST JSON, X-Portunia-Gate-Signature : HMAC-SHA256 de « date.corps »')),
          newSecret.row,
          h('div', { class: 'row2' }, h('div', {}, save), h('div', { style: 'display:flex;gap:6px' }, testTo, test)));
      };
      const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
        try {
          await call('PUT', '/admin/reglages', {
            nom: nom.value, banniere: banner.value, politique: policy.value, duree_session_h: Number(hours.value), memo_mot_de_passe: memo.box.checked,
            relecture_propres: own.box.checked, commandes_sensibles: sensitive.value.split('\n').map((x) => x.trim()).filter(Boolean),
            ...(langue ? { langue: langue.value } : {}),
            ...(notice ? { direct_prevenir: notice.box.checked } : {}),
            ...(copies ? { copies_fichiers_mo: Number(copies.value) || 0 } : {}),
            ...(retention ? { conservation_jours: Number(retention.value) || 0 } : {}),
            ...(journalDays ? { journal_jours: Number(journalDays.value) || 0 } : {}),
          });
          host.toast(t('Settings saved', 'Réglages enregistrés'));
        } catch (e) { fail(e); }
      } }, t('Save', 'Enregistrer'));
      return h('div', { class: 'admin-section form-narrow' },
        field(t('Gate name', 'Nom de la Gate'), nom, t('shown in Portunia and the authenticator app', 'affiché dans Portunia et l\'application d\'authentification')),
        field(t('Sign-in banner', 'Bannière de connexion'), banner, t('legal warning shown before sign-in', 'avertissement légal affiché avant l\'identification')),
        field(t('Default sign-in for accounts', 'Connexion par défaut des comptes'), policy),
        field(t('Session duration in Portunia (hours)', 'Durée d\'une session dans Portunia (heures)'), hours),
        langue ? field(t('Gate language', 'Langue de la Gate'), langue, t('SSH menu and messages, default banner, logs; Portunia and the web portal follow each user\'s language', 'menu et messages SSH, bannière par défaut, journaux ; Portunia et le portail web suivent la langue de chacun')) : null,
        memo.row,
        h('h3', {}, t('Session replay', 'Relecture des sessions')),
        own.row,
        notice ? notice.row : null,
        retention ? field(t('Keep recordings (days)', 'Garder les enregistrements (jours)'), retention, t('0: forever; otherwise the recordings of sessions ended earlier are deleted every hour (the sessions stay in the list)', '0 : toujours ; sinon les enregistrements des sessions terminées avant sont supprimés chaque heure (les sessions restent dans la liste)')) : null,
        journalDays ? field(t('Keep the audit log (days)', 'Garder le journal d\'audit (jours)'), journalDays, t('0: forever; otherwise at least 90, older events are deleted every day after checking the chain', '0 : toujours ; sinon au moins 90, les événements plus anciens sont supprimés chaque jour après vérification de la chaîne')) : null,
        field(t('Sensitive commands', 'Commandes sensibles'), sensitive, t('one per line; marked in red on the player\'s timeline', 'une par ligne ; repérées en rouge sur la barre de temps du lecteur')),
        copies ? h('h3', {}, t('Remote Desktop file copy', 'Copie de fichiers en Bureau à distance')) : null,
        copies ? field(t('Copies kept per session (MB)', 'Copies gardées par session (Mo)'), copies, t('0: none, only name, size and SHA-256 are logged; otherwise the files copied, up to this size, next to the recording', '0 : aucune, seuls nom, taille et SHA-256 sont tracés ; sinon les fichiers copiés, jusqu\'à cette taille, à côté de l\'enregistrement')) : null,
        copies ? h('p', { class: 'muted small' }, t('File copy itself is allowed per rule (Rules › Remote Desktop file copy).', 'La copie elle-même se permet règle par règle (Règles › copie de fichiers).')) : null,
        h('div', {}, saveBtn),
        n ? notificationsBlock(n) : null);
    },
  };

  show(current);
  return h('div', { class: 'ext-page gate-admin' },
    h('header', {}, h('h2', {}, `Administration · ${b.name}`), h('p', { class: 'muted' }, t(`${b.host} · signed in as ${b.login} (${roleLabel(b.role)})`, `${b.host} · connecté en tant que ${b.login} (${roleLabel(b.role)})`))),
    nav, content);
}
