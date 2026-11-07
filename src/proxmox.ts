// Extension Proxmox VE : serveurs Proxmox dans la barre latérale, nœuds, machines virtuelles et
// conteneurs avec leur état ; actions, consoles, instantanés, sauvegardes, clonage, migration,
// ressources, tâches et stockages. Tout passe par l'API de Proxmox (commande pve_api).
// Création de machines et gestion des nœuds : proxmoxadmin.ts. Terminal, connexion SSH/RDP,
// matériel, cloud-init, envoi d'ISO, pare-feu, droits, Ceph, stockages et réseau : proxmoxmore.ts.
import { errorText, Manifest, proxmox, Pve, PveResource } from './api';
import { h, icon } from './dom';
import { LOCALE, t } from './i18n';
import { MenuItem, showMenu } from './menu';
import { nodePower, openCreateCt, openCreateVm, openDisks, openJournal, openServices, openUpdates } from './proxmoxadmin';
import { openAccess, openAddStorage, openCeph, openCloudInit, openConnect, openFirewall, openHardware, openNetworkEdit, openTaskLog, openUpload, removeStorage } from './proxmoxmore';

/** Proxmox VE apparaît dans la page Extensions comme les protocoles. */
export const PROXMOX_EXTENSION: Manifest = {
  id: 'proxmox',
  name: 'Proxmox VE',
  version: '1.0.0',
  description: t('Proxmox servers in the sidebar: create, start and stop virtual machines and containers, consoles and terminals, SSH or Remote Desktop to a machine, hardware and cloud-init, snapshots, backups, clone, migrate, tasks and their log, storage and ISO upload; node updates, services, log, network, disks, firewall, users and permissions, Ceph.', 'Serveurs Proxmox dans la barre latérale : création, démarrage et arrêt des machines virtuelles et conteneurs, consoles et terminaux, SSH ou Bureau à distance vers une machine, matériel et cloud-init, instantanés, sauvegardes, clonage, migration, tâches et leur journal, stockages et envoi d\'ISO ; mises à jour, services, journal, réseau, disques, pare-feu, utilisateurs et droits, Ceph des nœuds.'),
  view: 'screen',
  builtin: true,
  catalog: true,
  fileBrowser: false,
  portForwarding: false,
  fields: [],
};

export interface ProxmoxHost {
  toast(message: string, kind?: 'info' | 'error'): void;
  /** Console VNC dans un onglet (machine virtuelle, conteneur, ou shell du nœud). */
  openConsole(p: Pve, node: string, kind: 'qemu' | 'lxc' | 'node', vmid: number | null, title: string, upgrade?: boolean): void;
  /** Terminal texte de Proxmox dans un onglet terminal (conteneur, nœud, console série d'une VM). */
  openTerminal(p: Pve, node: string, kind: 'qemu' | 'lxc' | 'node', vmid: number | null, title: string, cmd?: 'upgrade'): void;
  /** Connexion rapide préremplie (« ssh 192.168.1.20 », « rdp 192.168.1.30 »). */
  quickConnect(text: string): void;
  /** Formulaire de nouvelle session prérempli (protocole, nom, adresse). */
  saveSession(protocol: string, name: string, host: string): void;
  /** Onglet de supervision du serveur, ou d'un seul de ses nœuds. */
  openMonitor(p: Pve, node?: string): void;
  /** Console impossible sans l'extension VNC. */
  vncEnabled(): boolean;
  allowed(): boolean;
  filter(): string;
  clearFilter(): void;
}

type Guest = PveResource & { type: 'qemu' | 'lxc'; vmid: number };

const COLLAPSED_KEY = 'portunia.proxmox.replis';

const pct = (v?: number) => `${Math.round((v ?? 0) * 100)} %`;
export function bytes(n?: number): string {
  if (!n) return '0';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const unitsEn = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1).replace('.', t('.', ','))} ${t(unitsEn[i], units[i])}`;
}
export const date = (s?: number) => (s ? new Date(s * 1000).toLocaleString(LOCALE) : '');
export const guestLabel = (g: PveResource) => `${g.vmid} · ${g.name ?? ''}`;
const kindLabel = (g: PveResource) => (g.type === 'qemu' ? t('virtual machine', 'machine virtuelle') : t('container', 'conteneur'));

// ---------- Barre latérale ----------

export class ProxmoxPanel {
  list: Pve[] = [];
  /** Dernier inventaire de chaque serveur (/cluster/resources), ou l'erreur rencontrée. */
  private resources = new Map<string, PveResource[]>();
  private errors = new Map<string, string>();
  /** Droits manquants (jeton sans permission) : explication à afficher sous le serveur. */
  private hints = new Map<string, string>();
  private collapsed: Set<string>;
  private timer = 0;

  constructor(private root: HTMLElement, readonly host: ProxmoxHost) {
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'); } catch { /* ignoré */ }
    this.collapsed = new Set(saved);
  }

  show(on: boolean) {
    this.root.hidden = !on;
    window.clearInterval(this.timer);
    if (on) {
      this.load();
      // États et charges à jour toutes les 30 secondes, tant que l'extension est active.
      this.timer = window.setInterval(() => this.refreshAll(true), 30 * 1000);
    }
  }

  async load() {
    try {
      this.list = await proxmox.list();
    } catch (e) {
      this.host.toast(errorText(e), 'error');
    }
    await this.refreshAll(true);
  }

  private async refreshAll(quiet: boolean) {
    if (!this.host.allowed()) return this.render();
    await Promise.all(this.list.map((p) => this.refresh(p.id, quiet, false)));
    this.render();
  }

  async refresh(id: string, quiet = false, draw = true) {
    try {
      const res = await proxmox.api<PveResource[]>(id, 'GET', '/cluster/resources');
      this.resources.set(id, res);
      this.errors.delete(id);
      // Sans droit, Proxmox liste quand même les nœuds, mais ni leurs chiffres ni les machines.
      if (res.some((r) => r.type === 'qemu' || r.type === 'lxc')) this.hints.delete(id);
      else this.hints.set(id, await rightsHint(id));
    } catch (e) {
      this.errors.set(id, errorText(e));
      if (!quiet) this.host.toast(errorText(e), 'error');
    }
    if (draw) this.render();
  }

  /** Machines et conteneurs que le filtre retient. */
  countMatches(filter: string): number {
    let n = 0;
    for (const res of this.resources.values()) n += res.filter((r) => (r.type === 'qemu' || r.type === 'lxc') && matches(r, filter)).length;
    return n;
  }

  async add(existing?: Pve) {
    const p = await openServerForm(existing);
    if (p) {
      this.host.toast(existing ? t(`« ${p.name} » updated`, `« ${p.name} » modifié`) : t(`Proxmox « ${p.name} » added`, `Proxmox « ${p.name} » ajouté`));
      await this.load();
    }
  }

  render() {
    const filter = this.host.filter().trim().toLowerCase();
    const head = h('div', { class: 'sidebar-head' },
      h('span', { class: 'label' }, 'Proxmox'),
      h('div', { class: 'head-actions' },
        h('button', { class: 'icon-btn', 'aria-label': t('Add a Proxmox server', 'Ajouter un serveur Proxmox'), title: t('Add a Proxmox server', 'Ajouter un serveur Proxmox'), onclick: () => this.add() }, icon('plus'))));
    const body = h('div', { class: 'gate-list' });
    if (!this.host.allowed()) {
      body.append(h('div', { class: 'empty-tree' }, h('span', { class: 'small' }, t('Proxmox VE is part of Portunia Pro (Settings › Licence).', 'Proxmox VE fait partie de Portunia Pro (Paramètres › Licence).'))));
      this.root.replaceChildren(head, body);
      return;
    }
    if (filter) {
      body.append(h('p', { class: 'gate-filter muted small' }, t(`Filtered by « ${filter} »`, `Filtrés par « ${filter} »`), ' ',
        h('button', { class: 'link-btn', onclick: () => this.host.clearFilter() }, t('Clear', 'Effacer'))));
    }
    if (!this.list.length) {
      body.append(h('div', { class: 'empty-tree' },
        h('span', { class: 'small' }, t('No Proxmox server. Add one with its address and an API token (or a password).', 'Aucun serveur Proxmox. Ajoutez-en un avec son adresse et un jeton d\'API (ou un mot de passe).')),
        h('button', { class: 'btn', onclick: () => this.add() }, t('Add a Proxmox server', 'Ajouter un serveur Proxmox'))));
    }
    for (const p of this.list) body.append(...this.renderServer(p, filter));
    this.root.replaceChildren(head, body);
  }

  private serverMenu(p: Pve): (MenuItem | 'separator')[] {
    const nodes = this.nodes(p.id);
    return [
      { label: t('Monitoring', 'Supervision'), icon: 'chart', action: () => this.host.openMonitor(p) },
      { label: t('Create a virtual machine…', 'Créer une machine virtuelle…'), icon: 'desktop', action: () => openCreateVm(this, p) },
      { label: t('Create a container…', 'Créer un conteneur…'), icon: 'box', action: () => openCreateCt(this, p) },
      { label: t('Refresh', 'Actualiser'), icon: 'refresh', action: () => this.refresh(p.id) },
      { label: t('Tasks', 'Tâches'), icon: 'commands', action: () => openTasks(this, p) },
      { label: t('Storage', 'Stockages'), icon: 'drive', action: () => openStorage(this, p, nodes) },
      { label: t('Users and permissions', 'Utilisateurs et droits'), icon: 'user', action: () => openAccess(this, p) },
      { label: t('Datacenter firewall', 'Pare-feu du datacenter'), icon: 'shield', action: () => openFirewall(this, p, { kind: 'cluster' }) },
      { label: t('Edit', 'Modifier'), icon: 'edit', action: () => this.add(p) },
      { label: t('Copy the certificate fingerprint', 'Copier l\'empreinte du certificat'), icon: 'copy', action: () => navigator.clipboard.writeText(p.fingerprint) },
      'separator',
      {
        label: t('Remove this server', 'Retirer ce serveur'), icon: 'trash', danger: true, action: async () => {
          if (!confirm(t(`Remove « ${p.name} » from Portunia? Its secret is erased from this PC; nothing changes on the Proxmox server.`, `Retirer « ${p.name} » de Portunia ? Son secret est effacé de ce PC ; rien ne change sur le serveur Proxmox.`))) return;
          await proxmox.remove(p.id).catch((e) => this.host.toast(errorText(e), 'error'));
          this.resources.delete(p.id);
          this.load();
        },
      },
    ];
  }

  /** Machines et conteneurs connus d'un serveur (dernier inventaire). */
  guests(id: string): PveResource[] {
    return (this.resources.get(id) ?? []).filter((r) => r.type === 'qemu' || r.type === 'lxc');
  }

  nodes(id: string): string[] {
    return (this.resources.get(id) ?? []).filter((r) => r.type === 'node').map((r) => r.node).sort();
  }

  private renderServer(p: Pve, filter: string): HTMLElement[] {
    const error = this.errors.get(p.id);
    const res = this.resources.get(p.id);
    const state = res && !error ? 'on' : 'off';
    const guests = (res ?? []).filter((r): r is Guest => r.type === 'qemu' || r.type === 'lxc');
    const running = guests.filter((g) => g.status === 'running').length;
    const hint = !error && this.hints.get(p.id);
    const card = h('div', { class: `gate-card ${state}` },
      h('button', { class: 'gate-main', title: error ?? `${p.host}:${p.port} · ${p.user}${p.tokenId ? `!${p.tokenId}` : ''}`, onclick: () => this.toggle(p.id) },
        h('span', { class: `led ${state}` }),
        h('span', { class: 'grow' },
          h('span', { class: 'gate-name ellipsis' }, p.name),
          h('span', { class: 'gate-sub ellipsis' }, error ? error : hint ? t('No right to see the machines', 'Aucun droit de voir les machines') : res ? t(`${running} running out of ${guests.length}`, `${running} en marche sur ${guests.length}`) : t('loading…', 'chargement…')))),
      h('button', { class: 'icon-btn sm', 'aria-label': t(`Actions for ${p.name}`, `Actions de ${p.name}`), title: t('More actions', 'Plus d\'actions'), onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY, this.serverMenu(p)) }, icon('more', 14)));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, this.serverMenu(p)); });
    const out: HTMLElement[] = [card];
    if (hint) out.push(h('p', { class: 'gate-filter muted small' }, hint));
    if ((this.collapsed.has(p.id) && !filter) || !res) return out;
    for (const node of (res ?? []).filter((r) => r.type === 'node').sort((a, b) => a.node.localeCompare(b.node))) {
      const list = guests.filter((g) => g.node === node.node && matches(g, filter)).sort((a, b) => a.vmid - b.vmid);
      if (filter && !list.length) continue;
      const online = node.status === 'online';
      const row = h('div', { class: `tree-row${online ? '' : ' disabled'}` },
        h('span', { class: 'tree-item group-head gate-folder', title: online ? t(`CPU ${pct(node.cpu)} · memory ${bytes(node.mem)} / ${bytes(node.maxmem)}`, `Processeur ${pct(node.cpu)} · mémoire ${bytes(node.mem)} / ${bytes(node.maxmem)}`) : t('Node offline', 'Nœud hors ligne') },
          icon('server', 14), h('span', { class: 'grow ellipsis' }, node.node), h('span', { class: 'count' }, !online ? t('offline', 'hors ligne') : node.maxcpu ? pct(node.cpu) : '')));
      const nodeMenu = (): (MenuItem | 'separator')[] => [
        { label: t('Monitoring', 'Supervision'), icon: 'chart', action: () => this.host.openMonitor(p, node.node) },
        { label: t('Node terminal', 'Terminal du nœud'), icon: 'terminal', action: () => this.terminal(p, node.node, 'node', null, `${node.node}`) },
        { label: t('Node shell (VNC)', 'Shell du nœud (VNC)'), icon: 'desktop', action: () => this.console(p, node.node, 'node', null, `${node.node}`) },
        'separator',
        { label: t('Create a virtual machine…', 'Créer une machine virtuelle…'), icon: 'desktop', action: () => openCreateVm(this, p, node.node) },
        { label: t('Create a container…', 'Créer un conteneur…'), icon: 'box', action: () => openCreateCt(this, p, node.node) },
        'separator',
        { label: t('Updates', 'Mises à jour'), icon: 'download', action: () => openUpdates(this, p, node.node) },
        { label: t('Services', 'Services'), icon: 'settings', action: () => openServices(this, p, node.node) },
        { label: t('System log', 'Journal système'), icon: 'commands', action: () => openJournal(this, p, node.node) },
        { label: t('Network', 'Réseau'), icon: 'broadcast', action: () => openNetworkEdit(this, p, node.node) },
        { label: t('Firewall', 'Pare-feu'), icon: 'shield', action: () => openFirewall(this, p, { kind: 'node', node: node.node }) },
        { label: 'Ceph', icon: 'layers', action: () => openCeph(this, p, node.node) },
        { label: t('Disks', 'Disques'), icon: 'drive', action: () => openDisks(this, p, node.node) },
        { label: t('Storage', 'Stockages'), icon: 'drive', action: () => openStorage(this, p, [node.node]) },
        { label: t('Send an ISO or a template…', 'Envoyer une ISO ou un modèle…'), icon: 'upload', action: () => openUpload(this, p, node.node) },
        { label: t('Tasks', 'Tâches'), icon: 'commands', action: () => openTasks(this, p, node.node) },
        'separator',
        { label: t('Restart the node…', 'Redémarrer le nœud…'), icon: 'refresh', danger: true, action: () => nodePower(this, p, node.node, 'reboot') },
        { label: t('Shut down the node…', 'Éteindre le nœud…'), icon: 'power', danger: true, action: () => nodePower(this, p, node.node, 'shutdown') },
      ];
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, nodeMenu()); });
      out.push(row);
      for (const g of list) out.push(this.renderGuest(p, g));
    }
    return out;
  }

  private renderGuest(p: Pve, g: Guest): HTMLElement {
    const on = g.status === 'running';
    const template = g.template === 1;
    const open = () => {
      if (template) return this.host.toast(t('A template does not start: clone it (menu « … »).', 'Un modèle ne démarre pas : clonez-le (menu « … »).'), 'info');
      if (!on) return this.host.toast(t(`${guestLabel(g)} is stopped: start it from its menu (right click).`, `${guestLabel(g)} est arrêté : démarrez-le depuis son menu (clic droit).`), 'info');
      if (g.type === 'lxc') this.terminal(p, g.node, 'lxc', g.vmid, guestLabel(g));
      else this.console(p, g.node, g.type, g.vmid, guestLabel(g));
    };
    const title = [
      `${guestLabel(g)} (${kindLabel(g)}) · ${g.status ?? ''}${g.lock ? ` · ${t('locked', 'verrouillé')} (${g.lock})` : ''}`,
      on ? t(`CPU ${pct(g.cpu)} · memory ${bytes(g.mem)} / ${bytes(g.maxmem)} · up ${Math.round((g.uptime ?? 0) / 3600)} h`, `Processeur ${pct(g.cpu)} · mémoire ${bytes(g.mem)} / ${bytes(g.maxmem)} · en marche depuis ${Math.round((g.uptime ?? 0) / 3600)} h`) : '',
      g.tags ? `${t('Tags', 'Étiquettes')} : ${g.tags.replace(/;/g, ', ')}` : '',
    ].filter(Boolean).join('\n');
    const row = h('div', { class: 'tree-row' },
      h('button', { class: 'tree-item session', style: 'padding-left: 32px', title, onclick: open },
        h('span', { class: `dot${on ? ' on' : ''}` }),
        icon(g.type === 'qemu' ? 'desktop' : 'box', 13),
        h('span', { class: 'grow ellipsis' }, guestLabel(g)),
        template ? h('span', { class: 'badge' }, t('template', 'modèle')) : null,
        on ? h('span', { class: 'muted small' }, pct(g.cpu)) : null));
    const show = (e: MouseEvent) => { e.preventDefault(); showMenu(e.clientX, e.clientY, this.guestMenu(p, g)); };
    row.addEventListener('contextmenu', show);
    return row;
  }

  private guestMenu(p: Pve, g: Guest): (MenuItem | 'separator')[] {
    const on = g.status === 'running';
    const paused = g.status === 'paused' || (g.status as string) === 'suspended';
    const base = `/nodes/${g.node}/${g.type}/${g.vmid}`;
    const act = (action: string, label: string) => ({ label, action: () => this.run(p, g.node, `${base}/status/${action}`, `${label} ${guestLabel(g)}`) });
    const items: (MenuItem | 'separator')[] = [];
    if (g.template !== 1) {
      if (on && g.type === 'lxc') items.push({ label: t('Terminal', 'Terminal'), icon: 'terminal', action: () => this.terminal(p, g.node, 'lxc', g.vmid, guestLabel(g)) });
      if (on) items.push({ label: g.type === 'lxc' ? t('Console (VNC)', 'Console (VNC)') : t('Console', 'Console'), icon: 'desktop', action: () => this.console(p, g.node, g.type, g.vmid, guestLabel(g)) });
      if (on && g.type === 'qemu') items.push({ label: t('Text console (serial port)', 'Console texte (port série)'), icon: 'terminal', action: () => this.terminal(p, g.node, 'qemu', g.vmid, guestLabel(g)) });
      if (on) items.push({ label: t('Connect with SSH or Remote Desktop…', 'Se connecter en SSH ou Bureau à distance…'), icon: 'link', action: () => openConnect(this, p, g) });
      if (!on && !paused) items.push({ ...act('start', t('Start', 'Démarrer')), icon: 'play' });
      if (on) {
        items.push({ ...act('shutdown', t('Shut down', 'Éteindre')), icon: 'power' });
        items.push({ ...act('reboot', t('Restart', 'Redémarrer')), icon: 'refresh' });
        if (g.type === 'qemu') items.push({ ...act('suspend', t('Pause', 'Mettre en pause')), icon: 'pause' });
      }
      if (paused) items.push({ ...act('resume', t('Resume', 'Reprendre')), icon: 'play' });
      if (on || paused) {
        items.push({
          label: t('Stop (power cut)', 'Arrêter (coupure)'), icon: 'power', danger: true, action: () => {
            if (confirm(t(`Stop ${guestLabel(g)} immediately, like pulling the plug? Unsaved work is lost.`, `Arrêter ${guestLabel(g)} immédiatement, comme une coupure de courant ? Le travail non enregistré est perdu.`))) this.run(p, g.node, `${base}/status/stop`, `${t('Stop', 'Arrêt')} ${guestLabel(g)}`);
          },
        });
      }
      items.push('separator');
    }
    items.push(
      { label: t('Snapshots', 'Instantanés'), icon: 'camera', action: () => openSnapshots(this, p, g) },
      { label: t('Backups', 'Sauvegardes'), icon: 'download', action: () => openBackups(this, p, g) },
      { label: t('Clone', 'Cloner'), icon: 'copy', action: () => openClone(this, p, g) },
      { label: t('Migrate', 'Migrer'), icon: 'move', action: () => openMigrate(this, p, g) },
      { label: t('Resources and settings', 'Ressources et réglages'), icon: 'settings', action: () => openConfig(this, p, g) },
      { label: t('Hardware', 'Matériel'), icon: 'drive', action: () => openHardware(this, p, g) },
      ...(g.type === 'qemu' ? [{ label: t('Cloud-init', 'Cloud-init'), icon: 'user', action: () => openCloudInit(this, p, g) }] : []),
      { label: t('Firewall', 'Pare-feu'), icon: 'shield', action: () => openFirewall(this, p, { kind: 'guest', guest: g }) },
      { label: t('Tasks', 'Tâches'), icon: 'commands', action: () => openTasks(this, p, g.node, g.vmid) },
    );
    if (g.template !== 1 && !on) {
      items.push({
        label: t('Convert to template', 'Convertir en modèle'), icon: 'layers', action: () => {
          if (confirm(t(`Convert ${guestLabel(g)} to a template? It will no longer start; it is used to clone new machines. This cannot be undone.`, `Convertir ${guestLabel(g)} en modèle ? Il ne démarrera plus ; il sert à cloner de nouvelles machines. C'est définitif.`))) this.run(p, g.node, `${base}/template`, t('Conversion to template', 'Conversion en modèle'));
        },
      });
    }
    items.push('separator', {
      label: t('Delete…', 'Supprimer…'), icon: 'trash', danger: true, action: () => {
        if (on) return this.host.toast(t('Stop it first.', 'Arrêtez-le d\'abord.'), 'error');
        const typed = prompt(t(`Delete ${guestLabel(g)} and its disks for good? Type its number (${g.vmid}) to confirm.`, `Supprimer ${guestLabel(g)} et ses disques définitivement ? Tapez son numéro (${g.vmid}) pour confirmer.`));
        if (typed?.trim() === String(g.vmid)) this.run(p, g.node, base, `${t('Deletion of', 'Suppression de')} ${guestLabel(g)}`, 'DELETE', { purge: 1, 'destroy-unreferenced-disks': 1 });
      },
    });
    return items;
  }

  /** Terminal texte (termproxy) : pas besoin de l'extension VNC. */
  terminal(p: Pve, node: string, kind: 'qemu' | 'lxc' | 'node', vmid: number | null, title: string, cmd?: 'upgrade') {
    this.host.openTerminal(p, node, kind, vmid, title, cmd);
  }

  console(p: Pve, node: string, kind: 'qemu' | 'lxc' | 'node', vmid: number | null, title: string, upgrade = false) {
    if (!this.host.vncEnabled()) return this.host.toast(t('Enable the VNC extension (Extensions): Proxmox consoles use it.', 'Activez l\'extension VNC (Extensions) : les consoles Proxmox s\'en servent.'), 'error');
    this.host.openConsole(p, node, kind, vmid, title, upgrade);
  }

  /** Lance une action (tâche Proxmox), la suit jusqu'à sa fin et actualise. */
  async run(p: Pve, node: string, path: string, label: string, method: 'POST' | 'DELETE' | 'PUT' = 'POST', params?: Record<string, unknown>): Promise<boolean> {
    try {
      const upid = await proxmox.api<string | null>(p.id, method, path, params);
      this.host.toast(t(`${label}: started`, `${label} : lancé`));
      const ok = typeof upid === 'string' && upid.startsWith('UPID:') ? await this.waitTask(p, node, upid, label) : true;
      await this.refresh(p.id, true);
      return ok;
    } catch (e) {
      this.host.toast(`${label} : ${errorText(e)}`, 'error');
      return false;
    }
  }

  /** Attend la fin d'une tâche (jusqu'à 30 minutes) et annonce son résultat. */
  async waitTask(p: Pve, node: string, upid: string, label: string): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < 30 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const s = await proxmox.api<{ status: string; exitstatus?: string }>(p.id, 'GET', `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
        if (s.status === 'stopped') {
          const ok = s.exitstatus === 'OK' || (s.exitstatus ?? '').startsWith('WARNINGS');
          this.host.toast(ok ? t(`${label}: done`, `${label} : terminé`) : `${label} : ${s.exitstatus ?? t('failed', 'échec')}`, ok ? 'info' : 'error');
          // Échec : le journal de la tâche dit pourquoi.
          if (!ok) openTaskLog(p, node, upid, label);
          return ok;
        }
      } catch {
        /* nœud momentanément injoignable (migration, redémarrage) : on réessaie */
      }
    }
    return false;
  }

  private toggle(id: string) {
    if (this.collapsed.has(id)) this.collapsed.delete(id);
    else this.collapsed.add(id);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed])); } catch { /* ignoré */ }
    this.render();
  }
}

/** Explication quand l'utilisateur ou le jeton ne voit aucune machine (vide si c'est juste un cluster sans machine). */
export async function rightsHint(id: string): Promise<string> {
  let perms: Record<string, Record<string, number>>;
  try {
    perms = await proxmox.api(id, 'GET', '/access/permissions');
  } catch {
    return '';
  }
  if (Object.values(perms ?? {}).some((p) => p['VM.Audit'])) return '';
  return t('Proxmox gives this account no right on the machines. In Proxmox: Datacenter › Permissions › Add › API Token Permission (or User Permission), path « / », role PVEVMAdmin (or PVEAuditor to only look), then Refresh. A token with « Privilege Separation » needs its own permission, even for root@pam.',
    'Proxmox ne donne à ce compte aucun droit sur les machines. Dans Proxmox : Datacenter › Permissions › Ajouter › Permission de jeton d\'API (ou d\'utilisateur), chemin « / », rôle PVEVMAdmin (ou PVEAuditor pour seulement regarder), puis Actualiser. Un jeton avec « Privilege Separation » demande sa propre permission, même pour root@pam.');
}

function matches(r: PveResource, filter: string): boolean {
  if (!filter) return true;
  return [String(r.vmid ?? ''), r.name ?? '', r.node, r.tags ?? ''].some((x) => x.toLowerCase().includes(filter));
}

// ---------- Fenêtres ----------

export function modal(title: string, body: (HTMLElement | null)[], buttons: HTMLElement[], wide = false) {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h('form', { method: 'dialog' },
    h('header', { class: 'dlg-head' }, h('h2', {}, title)),
    h('div', { class: 'dlg-body' }, ...body.filter((x): x is HTMLElement => !!x), error),
    h('footer', { class: 'dlg-foot' }, ...buttons));
  const dialog = h('dialog', { class: `dialog${wide ? ' wide' : ' narrow'}`, 'aria-label': title }, form) as HTMLDialogElement;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  return { dialog, form, error };
}

export function field(label: string, control: HTMLElement, hint?: string) {
  return h('label', { class: 'fld' }, h('span', {}, label, hint ? h('span', { class: 'muted small' }, ` ${hint}`) : null), control);
}

export function input(attrs: Record<string, unknown>) {
  return h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', class: 'input', ...attrs }) as HTMLInputElement;
}

export function select(options: [string, string][], value?: string) {
  const s = h('select', { class: 'input' }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label))) as HTMLSelectElement;
  return s;
}

export function check(label: string, checked = false) {
  const box = h('input', { type: 'checkbox', checked }) as HTMLInputElement;
  return { box, row: h('label', { class: 'check-row' }, box, h('span', {}, label)) };
}

export function table(head: string[], rows: HTMLElement[]) {
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)));
}

export const closeButton = (dialog: HTMLDialogElement) => h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, t('Close', 'Fermer'));

/** Ajout ou modification d'un serveur : adresse, empreinte à vérifier, compte et secret. */
function openServerForm(existing?: Pve): Promise<Pve | null> {
  return new Promise((resolve) => {
    let target = existing ? { host: existing.host, port: existing.port, fingerprint: existing.fingerprint } : null;
    let result: Pve | null = null;
    const address = input({ value: existing ? `${existing.host}:${existing.port}` : '', placeholder: t('pve.example.com or 192.168.1.20 (port 8006)', 'pve.exemple.fr ou 192.168.1.20 (port 8006)') });
    const name = input({ value: existing?.name ?? '', placeholder: t('Name shown in Portunia', 'Nom affiché dans Portunia') });
    const fp = h('div', { class: 'fp' }, existing?.fingerprint ?? '');
    const fpField = h('div', { class: 'fld', hidden: !existing }, h('span', {}, t('Certificate fingerprint', 'Empreinte du certificat'), h('span', { class: 'muted small' }, t(' to compare with Proxmox: node › System › Certificates › pve-ssl.pem › Fingerprint', ' à comparer avec Proxmox : nœud › Système › Certificats › pve-ssl.pem › Empreinte'))), fp);
    const user = input({ value: existing?.user ?? 'root@pam', placeholder: 'root@pam' });
    const mode = select([['token', t('API token (recommended)', 'Jeton d\'API (conseillé)')], ['password', t('Password', 'Mot de passe')]], existing && !existing.tokenId ? 'password' : 'token');
    const tokenId = input({ value: existing?.tokenId ?? '', placeholder: 'portunia' });
    const tokenField = field(t('Token name', 'Nom du jeton'), tokenId, t('Datacenter › Permissions › API Tokens', 'Datacenter › Permissions › API Tokens'));
    const secret = input({ type: 'password', placeholder: existing?.hasSecret ? t('Kept: leave empty', 'Gardé : laisser vide') : '' });
    const secretLabel = h('span', {});
    const secretField = h('label', { class: 'fld' }, secretLabel, secret);
    // Proxmox refuse les jetons pour les consoles : elles s'ouvrent avec le mot de passe de l'utilisateur.
    const consolePassword = input({ type: 'password', placeholder: existing?.hasConsole ? t('Kept: leave empty', 'Gardé : laisser vide') : t('Optional', 'Facultatif') });
    const consoleField = field(t('Password for consoles', 'Mot de passe des consoles'), consolePassword, t('the user\'s: Proxmox does not open consoles with a token', 'celui de l\'utilisateur : Proxmox n\'ouvre pas les consoles avec un jeton'));
    const sync = () => {
      const token = mode.value === 'token';
      tokenField.hidden = !token;
      consoleField.hidden = !token;
      secretLabel.textContent = token ? t('Token secret', 'Secret du jeton') : t('Password', 'Mot de passe');
    };
    mode.addEventListener('change', sync);
    sync();
    const creds = h('div', { class: 'fld-group', hidden: !existing },
      field(t('Name', 'Nom'), name),
      h('div', { class: 'row2' }, field(t('User', 'Utilisateur'), user, 'utilisateur@domaine'), field(t('Sign-in', 'Connexion'), mode)),
      tokenField, secretField, consoleField,
      h('p', { class: 'muted small' }, t('Token: give it the privileges needed (e.g. role PVEVMAdmin on /, without « Privilege Separation » to keep the user\'s rights). Password: accounts with two-factor authentication need a token.', 'Jeton : donnez-lui les droits nécessaires (par ex. rôle PVEVMAdmin sur /, sans « Privilege Separation » pour garder les droits de l\'utilisateur). Mot de passe : les comptes à double authentification demandent un jeton.')));
    const submit = h('button', { type: 'submit', class: 'btn primary' }, existing ? t('Save', 'Enregistrer') : t('Continue', 'Continuer'));
    const cancel = h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, t('Cancel', 'Annuler'));
    const { dialog, form, error } = modal(existing ? t(`Edit ${existing.name}`, `Modifier ${existing.name}`) : t('Add a Proxmox server', 'Ajouter un serveur Proxmox'),
      [field(t('Address', 'Adresse'), address), fpField, creds], [cancel, submit]);
    address.addEventListener('input', () => { if (!existing) { target = null; fpField.hidden = true; creds.hidden = true; submit.textContent = t('Continue', 'Continuer'); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.setAttribute('disabled', '');
      try {
        if (!target) {
          target = await proxmox.probe(address.value);
          fp.textContent = target.fingerprint;
          fpField.hidden = false;
          creds.hidden = false;
          if (!name.value) name.value = target.host;
          submit.textContent = t('Add', 'Ajouter');
          return;
        }
        result = await proxmox.save({
          id: existing?.id, name: name.value.trim(), host: target.host, port: target.port, fingerprint: target.fingerprint,
          user: user.value.trim(), tokenId: mode.value === 'token' ? tokenId.value.trim() : '', secret: secret.value || undefined,
          consolePassword: mode.value === 'token' ? consolePassword.value || undefined : undefined,
        });
        dialog.close();
      } catch (err) {
        error.textContent = errorText(err);
      } finally {
        submit.removeAttribute('disabled');
      }
    });
    dialog.addEventListener('close', () => resolve(result));
    dialog.showModal();
    address.focus();
  });
}

/** Instantanés : liste, création (avec la mémoire pour une machine en marche), retour, suppression. */
async function openSnapshots(panel: ProxmoxPanel, p: Pve, g: Guest) {
  const base = `/nodes/${g.node}/${g.type}/${g.vmid}/snapshot`;
  const list = h('div', {});
  const snapName = input({ placeholder: t('before-update', 'avant-maj'), pattern: '[A-Za-z][A-Za-z0-9_\\-]*' });
  const description = input({ placeholder: t('Optional', 'Facultatif') });
  const memory = check(t('Include the memory (the machine resumes where it was)', 'Inclure la mémoire (la machine repart là où elle en était)'), false);
  memory.row.hidden = !(g.type === 'qemu' && g.status === 'running');
  const create = h('button', { type: 'button', class: 'btn primary' }, t('Take a snapshot', 'Prendre un instantané'));
  const { dialog, error } = modal(t(`Snapshots · ${guestLabel(g)}`, `Instantanés · ${guestLabel(g)}`), [
    list,
    h('h3', {}, t('New snapshot', 'Nouvel instantané')),
    h('div', { class: 'row2' }, field(t('Name', 'Nom'), snapName, t('letters, digits, - and _', 'lettres, chiffres, - et _')), field(t('Description', 'Description'), description)),
    memory.row,
  ], [create], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  const draw = async () => {
    try {
      const snaps = (await proxmox.api<{ name: string; description?: string; snaptime?: number; vmstate?: number; parent?: string }[]>(p.id, 'GET', base)).filter((s) => s.name !== 'current');
      list.replaceChildren(snaps.length
        ? table([t('Name', 'Nom'), t('Date', 'Date'), t('Description', 'Description'), ''], snaps.sort((a, b) => (b.snaptime ?? 0) - (a.snaptime ?? 0)).map((s) => h('tr', {},
          h('td', {}, s.name, s.vmstate ? h('span', { class: 'badge', title: t('with memory', 'avec la mémoire') }, 'RAM') : null),
          h('td', {}, date(s.snaptime)),
          h('td', { class: 'muted' }, s.description ?? ''),
          h('td', { class: 'pve-actions' },
            h('button', { type: 'button', class: 'btn sm', onclick: async () => {
              if (!confirm(t(`Go back to « ${s.name} »? Everything since this snapshot is lost.`, `Revenir à « ${s.name} » ? Tout ce qui a changé depuis cet instantané est perdu.`))) return;
              await panel.run(p, g.node, `${base}/${encodeURIComponent(s.name)}/rollback`, t(`Rollback to ${s.name}`, `Retour à ${s.name}`));
              draw();
            } }, t('Roll back', 'Revenir')),
            h('button', { type: 'button', class: 'btn sm danger', onclick: async () => {
              if (!confirm(t(`Delete the snapshot « ${s.name} »?`, `Supprimer l'instantané « ${s.name} » ?`))) return;
              await panel.run(p, g.node, `${base}/${encodeURIComponent(s.name)}`, t(`Deletion of ${s.name}`, `Suppression de ${s.name}`), 'DELETE');
              draw();
            } }, t('Delete', 'Supprimer'))))))
        : h('p', { class: 'muted' }, t('No snapshot.', 'Aucun instantané.')));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  create.addEventListener('click', async () => {
    error.textContent = '';
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(snapName.value.trim())) { error.textContent = t('Name: a letter, then letters, digits, - or _ (2 to 40 characters).', 'Nom : une lettre, puis lettres, chiffres, - ou _ (2 à 40 caractères).'); return; }
    create.setAttribute('disabled', '');
    const params: Record<string, unknown> = { snapname: snapName.value.trim(), description: description.value.trim() || undefined };
    if (!memory.row.hidden && memory.box.checked) params.vmstate = 1;
    await panel.run(p, g.node, base, t(`Snapshot ${snapName.value.trim()}`, `Instantané ${snapName.value.trim()}`), 'POST', params);
    create.removeAttribute('disabled');
    snapName.value = '';
    description.value = '';
    draw();
  });
  dialog.showModal();
  draw();
}

/** Sauvegardes : en lancer une (vzdump), lister celles d'un stockage, restaurer, supprimer. */
async function openBackups(panel: ProxmoxPanel, p: Pve, g: Guest) {
  const list = h('div', {});
  const storage = select([]);
  const mode = select([['snapshot', t('Snapshot (no interruption)', 'Instantané (sans interruption)')], ['suspend', t('Suspend', 'Suspension')], ['stop', t('Stop (most consistent)', 'Arrêt (le plus cohérent)')]], 'snapshot');
  const compress = select([['zstd', 'ZSTD'], ['lzo', 'LZO'], ['gzip', 'GZIP'], ['0', t('None', 'Aucune')]], 'zstd');
  const notes = input({ value: '{{guestname}}' });
  const start = h('button', { type: 'button', class: 'btn primary' }, t('Back up now', 'Sauvegarder maintenant'));
  const { dialog, error } = modal(t(`Backups · ${guestLabel(g)}`, `Sauvegardes · ${guestLabel(g)}`), [
    h('div', { class: 'row2' }, field(t('Storage', 'Stockage'), storage), field(t('Mode', 'Mode'), mode)),
    h('div', { class: 'row2' }, field(t('Compression', 'Compression'), compress), field(t('Notes', 'Notes'), notes)),
    h('h3', {}, t('Backups on this storage', 'Sauvegardes sur ce stockage')),
    list,
  ], [start], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  const draw = async () => {
    if (!storage.value) { list.replaceChildren(h('p', { class: 'muted' }, t('No storage accepts backups on this node.', 'Aucun stockage n\'accepte de sauvegardes sur ce nœud.'))); return; }
    try {
      const items = await proxmox.api<{ volid: string; ctime?: number; size?: number; notes?: string; protected?: number }[]>(p.id, 'GET', `/nodes/${g.node}/storage/${encodeURIComponent(storage.value)}/content`, { content: 'backup', vmid: g.vmid });
      list.replaceChildren(items.length
        ? table([t('Date', 'Date'), t('Size', 'Taille'), t('Notes', 'Notes'), ''], items.sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0)).map((b) => h('tr', {},
          h('td', { title: b.volid }, date(b.ctime)),
          h('td', {}, bytes(b.size)),
          h('td', { class: 'muted' }, b.notes ?? ''),
          h('td', { class: 'pve-actions' },
            h('button', { type: 'button', class: 'btn sm', onclick: async () => {
              if (g.status === 'running') return panel.host.toast(t('Stop the machine before restoring over it.', 'Arrêtez la machine avant de restaurer par-dessus.'), 'error');
              if (!confirm(t(`Restore this backup over ${guestLabel(g)}? Its current disks are replaced.`, `Restaurer cette sauvegarde à la place de ${guestLabel(g)} ? Ses disques actuels sont remplacés.`))) return;
              const params: Record<string, unknown> = g.type === 'qemu' ? { vmid: g.vmid, archive: b.volid, force: 1 } : { vmid: g.vmid, ostemplate: b.volid, restore: 1, force: 1 };
              await panel.run(p, g.node, `/nodes/${g.node}/${g.type}`, t(`Restore of ${guestLabel(g)}`, `Restauration de ${guestLabel(g)}`), 'POST', params);
            } }, t('Restore', 'Restaurer')),
            h('button', { type: 'button', class: 'btn sm danger', disabled: b.protected === 1, title: b.protected === 1 ? t('Protected backup', 'Sauvegarde protégée') : '', onclick: async () => {
              if (!confirm(t('Delete this backup for good?', 'Supprimer cette sauvegarde définitivement ?'))) return;
              await panel.run(p, g.node, `/nodes/${g.node}/storage/${encodeURIComponent(storage.value)}/content/${encodeURIComponent(b.volid)}`, t('Deletion of the backup', 'Suppression de la sauvegarde'), 'DELETE');
              draw();
            } }, t('Delete', 'Supprimer'))))))
        : h('p', { class: 'muted' }, t('No backup of this machine on this storage.', 'Aucune sauvegarde de cette machine sur ce stockage.')));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  try {
    const stores = await proxmox.api<{ storage: string; active?: number; enabled?: number }[]>(p.id, 'GET', `/nodes/${g.node}/storage`, { content: 'backup' });
    storage.replaceChildren(...stores.filter((s) => s.active !== 0).map((s) => h('option', { value: s.storage }, s.storage)));
  } catch (e) {
    error.textContent = errorText(e);
  }
  storage.addEventListener('change', draw);
  start.addEventListener('click', async () => {
    if (!storage.value) return;
    start.setAttribute('disabled', '');
    await panel.run(p, g.node, `/nodes/${g.node}/vzdump`, t(`Backup of ${guestLabel(g)}`, `Sauvegarde de ${guestLabel(g)}`), 'POST',
      { vmid: g.vmid, storage: storage.value, mode: mode.value, compress: compress.value, 'notes-template': notes.value || undefined });
    start.removeAttribute('disabled');
    draw();
  });
  dialog.showModal();
  draw();
}

/** Clonage : nouveau numéro, nom, nœud cible, copie complète ou liée (modèles). */
async function openClone(panel: ProxmoxPanel, p: Pve, g: Guest) {
  const newid = input({ inputmode: 'numeric' });
  const name = input({ value: `${g.name ?? 'clone'}-clone` });
  const target = select(panel.nodes(p.id).map((n) => [n, n]), g.node);
  const full = check(t('Full copy (independent of the original)', 'Copie complète (indépendante de l\'original)'), g.template !== 1);
  if (g.template !== 1) full.box.disabled = true;
  const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Clone', 'Cloner'));
  const { dialog, form, error } = modal(t(`Clone ${guestLabel(g)}`, `Cloner ${guestLabel(g)}`), [
    h('div', { class: 'row2' }, field(t('New number (VM ID)', 'Nouveau numéro (VM ID)'), newid), field(g.type === 'qemu' ? t('Name', 'Nom') : t('Host name', 'Nom d\'hôte'), name)),
    field(t('Target node', 'Nœud cible'), target),
    full.row,
    h('p', { class: 'muted small' }, g.template === 1
      ? t('From a template, a linked copy is quick and shares the template\'s disks; a full copy is independent.', 'Depuis un modèle, une copie liée est rapide et partage les disques du modèle ; une copie complète est indépendante.')
      : t('A machine (not a template) is always copied in full.', 'Une machine (pas un modèle) est toujours copiée en entier.')),
  ], [submit]);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  try { newid.value = String(await proxmox.api<number | string>(p.id, 'GET', '/cluster/nextid')); } catch { /* laissé vide */ }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const id = Number(newid.value);
    if (!(id >= 100)) { error.textContent = t('Number: 100 or more, not used yet.', 'Numéro : 100 ou plus, pas encore utilisé.'); return; }
    const params: Record<string, unknown> = { newid: id, target: target.value, full: full.box.checked ? 1 : 0 };
    params[g.type === 'qemu' ? 'name' : 'hostname'] = name.value.trim() || undefined;
    dialog.close();
    panel.run(p, g.node, `/nodes/${g.node}/${g.type}/${g.vmid}/clone`, t(`Clone of ${guestLabel(g)}`, `Clonage de ${guestLabel(g)}`), 'POST', params);
  });
  dialog.showModal();
}

/** Migration vers un autre nœud du cluster, à chaud si la machine tourne. */
async function openMigrate(panel: ProxmoxPanel, p: Pve, g: Guest) {
  const others = panel.nodes(p.id).filter((n) => n !== g.node);
  if (!others.length) return panel.host.toast(t('This cluster has no other node.', 'Ce cluster n\'a pas d\'autre nœud.'), 'error');
  const target = select(others.map((n) => [n, n]));
  const running = g.status === 'running';
  const live = check(g.type === 'qemu' ? t('Live migration (the machine keeps running)', 'Migration à chaud (la machine continue de tourner)') : t('Restart the container on the target node', 'Redémarrer le conteneur sur le nœud cible'), running);
  live.row.hidden = !running;
  const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Migrate', 'Migrer'));
  const { dialog, form } = modal(t(`Migrate ${guestLabel(g)}`, `Migrer ${guestLabel(g)}`), [
    field(t('Target node', 'Nœud cible'), target),
    live.row,
    h('p', { class: 'muted small' }, t(`Now on ${g.node}. Local disks are copied, which can take a while.`, `Actuellement sur ${g.node}. Les disques locaux sont copiés, ce qui peut prendre du temps.`)),
  ], [submit]);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const params: Record<string, unknown> = { target: target.value };
    if (running && live.box.checked) params[g.type === 'qemu' ? 'online' : 'restart'] = 1;
    if (g.type === 'qemu') params['with-local-disks'] = 1;
    dialog.close();
    panel.run(p, g.node, `/nodes/${g.node}/${g.type}/${g.vmid}/migrate`, t(`Migration of ${guestLabel(g)} to ${target.value}`, `Migration de ${guestLabel(g)} vers ${target.value}`), 'POST', params);
  });
  dialog.showModal();
}

/** Ressources (processeurs, mémoire, démarrage automatique, description) et réglages en lecture. */
async function openConfig(panel: ProxmoxPanel, p: Pve, g: Guest) {
  const path = `/nodes/${g.node}/${g.type}/${g.vmid}/config`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let config: Record<string, any> = {};
  try {
    config = await proxmox.api(p.id, 'GET', path);
  } catch (e) {
    return panel.host.toast(errorText(e), 'error');
  }
  const cores = input({ type: 'number', min: 1, max: 512, value: String(config.cores ?? 1) });
  const sockets = input({ type: 'number', min: 1, max: 8, value: String(config.sockets ?? 1) });
  const memory = input({ type: 'number', min: 16, step: 16, value: String(config.memory ?? 512) });
  const onboot = check(t('Start with the node', 'Démarrer avec le nœud'), config.onboot === 1);
  const description = h('textarea', { class: 'input', rows: 3 }, config.description ?? '') as HTMLTextAreaElement;
  const rows = Object.keys(config).filter((k) => !['digest', 'description'].includes(k)).sort().map((k) => h('tr', {}, h('td', {}, k), h('td', { class: 'mono small' }, String(config[k]))));
  const submit = h('button', { type: 'submit', class: 'btn primary' }, t('Save', 'Enregistrer'));
  const { dialog, form, error } = modal(t(`${guestLabel(g)} · resources`, `${guestLabel(g)} · ressources`), [
    h('div', { class: 'row2' },
      field(t('Cores', 'Cœurs'), cores),
      g.type === 'qemu' ? field(t('Sockets', 'Processeurs (sockets)'), sockets) : h('span', {})),
    field(t('Memory (MiB)', 'Mémoire (Mio)'), memory),
    onboot.row,
    field(t('Description (notes)', 'Description (notes)'), description),
    h('p', { class: 'muted small' }, g.status === 'running' ? t('Some changes only apply after a restart (Proxmox marks them as pending).', 'Certains changements ne s\'appliquent qu\'après un redémarrage (Proxmox les note « en attente »).') : null),
    h('details', {}, h('summary', {}, t('All settings', 'Tous les réglages')), table([t('Key', 'Clé'), t('Value', 'Valeur')], rows)),
  ], [submit], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const params: Record<string, unknown> = { cores: Number(cores.value), memory: Number(memory.value), onboot: onboot.box.checked ? 1 : 0, description: description.value, digest: config.digest };
    if (g.type === 'qemu') params.sockets = Number(sockets.value);
    try {
      await proxmox.api(p.id, 'PUT', path, params);
      panel.host.toast(t('Resources saved', 'Ressources enregistrées'));
      dialog.close();
      panel.refresh(p.id, true);
    } catch (err) {
      error.textContent = errorText(err);
    }
  });
  dialog.showModal();
}

/** Tâches récentes du cluster (ou d'un nœud, ou d'une machine), avec leur résultat. */
async function openTasks(_panel: ProxmoxPanel, p: Pve, node?: string, vmid?: number) {
  const list = h('div', {});
  const refresh = h('button', { type: 'button', class: 'btn' }, icon('refresh', 14), ' ', t('Refresh', 'Actualiser'));
  const { dialog, error } = modal(t(`Tasks · ${vmid ?? node ?? p.name}`, `Tâches · ${vmid ?? node ?? p.name}`), [list], [refresh], true);
  dialog.querySelector('.dlg-foot')!.prepend(closeButton(dialog));
  const draw = async () => {
    try {
      let tasks = await proxmox.api<{ upid: string; node: string; type: string; id?: string; user: string; starttime: number; endtime?: number; status?: string }[]>(p.id, 'GET', '/cluster/tasks');
      if (node) tasks = tasks.filter((x) => x.node === node);
      if (vmid) tasks = tasks.filter((x) => x.id === String(vmid));
      list.replaceChildren(tasks.length
        ? table([t('Start', 'Début'), t('Node', 'Nœud'), t('Task', 'Tâche'), t('Object', 'Objet'), t('User', 'Utilisateur'), t('Result', 'Résultat')],
          tasks.sort((a, b) => b.starttime - a.starttime).slice(0, 100).map((x) => h('tr', { class: 'clickable', title: t('Show the log', 'Voir le journal'), onclick: () => openTaskLog(p, x.node, x.upid, `${x.type} ${x.id ?? ''}`.trim()) },
            h('td', {}, date(x.starttime)), h('td', {}, x.node), h('td', {}, x.type), h('td', {}, x.id ?? ''), h('td', {}, x.user),
            h('td', { class: x.endtime ? (x.status === 'OK' ? '' : 'danger-text') : 'muted' }, x.endtime ? x.status ?? '' : t('running…', 'en cours…')))))
        : h('p', { class: 'muted' }, t('No recent task.', 'Aucune tâche récente.')), h('p', { class: 'muted small' }, t('Click a task to see its log.', 'Cliquez sur une tâche pour voir son journal.')));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  refresh.addEventListener('click', draw);
  dialog.showModal();
  draw();
}

/** Stockages des nœuds : type, contenu, place occupée ; contenu d'un stockage (images ISO, modèles, disques…). */
async function openStorage(panel: ProxmoxPanel, p: Pve, nodes: string[]) {
  const list = h('div', {});
  const content = h('div', {});
  const again = () => { dialog.close(); openStorage(panel, p, nodes); };
  const addBtn = h('button', { type: 'button', class: 'btn' }, icon('plus', 14), ' ', t('Add a storage…', 'Ajouter un stockage…'));
  addBtn.addEventListener('click', () => openAddStorage(panel, p, again));
  const sendBtn = h('button', { type: 'button', class: 'btn' }, icon('upload', 14), ' ', t('Send an ISO…', 'Envoyer une ISO…'));
  sendBtn.addEventListener('click', () => openUpload(panel, p, nodes[0], again));
  const { dialog, error } = modal(t(`Storage · ${nodes.length === 1 ? nodes[0] : p.name}`, `Stockages · ${nodes.length === 1 ? nodes[0] : p.name}`), [list, content], [addBtn, sendBtn], true);
  dialog.querySelector('.dlg-foot')!.append(closeButton(dialog));
  const show = async (node: string, storage: string) => {
    try {
      const items = await proxmox.api<{ volid: string; content: string; size?: number; ctime?: number; vmid?: number; format?: string }[]>(p.id, 'GET', `/nodes/${node}/storage/${encodeURIComponent(storage)}/content`);
      content.replaceChildren(h('h3', {}, `${storage} · ${node}`), items.length
        ? table([t('Volume', 'Volume'), t('Content', 'Contenu'), t('Format', 'Format'), t('Size', 'Taille'), t('Date', 'Date')],
          items.map((i) => h('tr', {}, h('td', { class: 'mono small' }, i.volid), h('td', {}, i.content), h('td', {}, i.format ?? ''), h('td', {}, bytes(i.size)), h('td', {}, date(i.ctime)))))
        : h('p', { class: 'muted' }, t('Empty.', 'Vide.')));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  try {
    const rows: HTMLElement[] = [];
    for (const node of nodes) {
      const stores = await proxmox.api<{ storage: string; type: string; content: string; used?: number; total?: number; active?: number; shared?: number }[]>(p.id, 'GET', `/nodes/${node}/storage`);
      for (const s of stores.sort((a, b) => a.storage.localeCompare(b.storage))) {
        rows.push(h('tr', { class: 'clickable', onclick: () => show(node, s.storage) },
          h('td', {}, s.storage), h('td', {}, node), h('td', {}, s.type), h('td', { class: 'small' }, s.content.replace(/,/g, ', ')),
          h('td', {}, s.active === 0 ? t('inactive', 'inactif') : `${bytes(s.used)} / ${bytes(s.total)} (${s.total ? Math.round(((s.used ?? 0) / s.total) * 100) : 0} %)`),
          h('td', {}, s.shared ? t('shared', 'partagé') : ''),
          h('td', { class: 'pve-actions' }, h('button', { type: 'button', class: 'btn sm danger', onclick: async (e: MouseEvent) => { e.stopPropagation(); if (await removeStorage(panel, p, s.storage)) again(); } }, t('Remove', 'Retirer')))));
      }
    }
    list.replaceChildren(table([t('Storage', 'Stockage'), t('Node', 'Nœud'), t('Type', 'Type'), t('Content', 'Contenu'), t('Used', 'Occupé'), '', ''], rows),
      h('p', { class: 'muted small' }, t('Click a storage to see its content.', 'Cliquez sur un stockage pour voir son contenu.')));
  } catch (e) {
    error.textContent = errorText(e);
  }
  dialog.showModal();
}
