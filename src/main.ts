import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { api, assistFile, assistOffer, assistSend, Gate, gates, GateServer, connectAssist, connectGate, connectProxmox, connectProxmoxTerminal, connectQuick, connectWith, ConnectResponse, errorText, Manifest, notes, Pve, Session, Snippet, TermEvent } from './api';
import { GatePanel, GATE_EXTENSION, renderGateAdmin } from './gate';
import { ProxmoxPanel, PROXMOX_EXTENSION } from './proxmox';
import { ASSIST_EXTENSION, AssistPanel, openAssistDialog } from './assist';
import { openKeyManager } from './keys';
import { NotesPanel } from './notes';
import { ServerPanel } from './dashboard';
import { ContainersPanel } from './containers';
import { DualFiles, FilesView } from './filesview';
import { createMultiExec, MultiExecView } from './multiexec';
import { openCredentialManager } from './credentials';
import { createNetTools, NetToolsView, wakeSession } from './nettools';
import { askCredentials, looksLikeAddress, openCommandPalette, openQuickConnect, PaletteEntry, parseQuick, QuickTarget, rememberQuick } from './quick';
import { badge, h, icon, viewIcon } from './dom';
import { openSessionDialog } from './dialog';
import { renderExtensions } from './extensions';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { FilePanel } from './files';
import type { Opener, TerminalView, TermState } from './terminal';
import type { ScreenView } from './screen';
import { leafOf, parentOf, SessionTree } from './tree';
import { SessionLibrary } from './library';
import { showMenu } from './menu';
import { openPalette, openSnippetManager, SnippetContext } from './snippets';
import { openTunnels } from './tunnels';
import { openImportExport } from './importexport';
import { onSettingsChange, openSettingsDialog, settings, updateSettings } from './settings';
import { Monitor } from './monitoring';
import { checkForUpdates } from './updates';
import { allows, currentEdition, EDITION_LABEL, initLock, isLocked, loadLicense, lockNow } from './security';
import { openRecordings, setPlayerHandler, stamp } from './recordings';
import type { Player } from './player';
import { buildReplay, replayTitle, ReplayPlayer } from './replayview';
import type { AuditRow } from './audit';
import { folderColors, recordings, shells, ShellSpec } from './api';
import { defaultShell, hideShell, loadShells, setDefaultShell, shellIcon, shellsLoaded, visibleShells } from './localshells';
import { colorOf, FOLDER_COLORS, initTheme, paint } from './theme';
import { LANG, t as tr } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { appShortcut, canElevate, initPlatform, IS_MAC, keys, localizeShortcutTitles, runUnlessBusy } from './platform';
import { listen } from '@tauri-apps/api/event';

// Plateforme connue avant le premier rendu (menus, raccourcis, textes).
await initPlatform();
// Menu natif macOS : installé avant que la langue de l'interface soit connue du cœur, on la lui donne ici.
// Sans attendre : le premier rendu ne dépend pas du menu.
if (IS_MAC) invoke('appmenu_refresh', { lang: LANG }).catch((err) => console.warn('Menu natif : langue non appliquée', errorText(err)));

interface Tab {
  id: string;
  kind: 'session' | 'local' | 'extensions' | 'replay' | 'tools' | 'multi' | 'admin' | 'library';
  /** Shell local (onglet « local »). */
  shell?: ShellSpec;
  title: string;
  sessionId?: string;
  /** Connexion rapide (pas de session enregistrée). */
  quick?: QuickTarget;
  protocol?: string;
  view: HTMLElement;
  term?: TerminalView;
  files?: FilePanel;
  /** Écran distant (VNC…) à la place du terminal. */
  screen?: ScreenView;
  state: TermState;
  /** En-tête affiché quand l'onglet est dans l'écran partagé. */
  paneHead?: HTMLElement;
  /** Reçoit la saisie multiple. */
  receive: boolean;
  /** Fichier en cours d'enregistrement. */
  recording?: string;
  /** Notes de la session (panneau de droite). */
  notes?: NotesPanel;
  /** Panneau de droite ouvert dans cet onglet ; aucun à l'ouverture, l'utilisateur choisit. */
  side?: SidePanel;
  /** Toutes les sessions en tableau (onglet « library »). */
  library?: SessionLibrary;
  /** Supervision Proxmox (onglet « admin »). */
  pveMonitor?: { dispose(): void };
  /** Lecteur d'enregistrement (onglet « replay »). */
  player?: Player;
  /** Relecture d'une session de Gate (onglet « replay »). */
  auditPlayer?: ReplayPlayer;
  /** Outils réseau (onglet « tools »). */
  netTools?: NetToolsView;
  /** Commande sur plusieurs serveurs (onglet « multi »). */
  multi?: MultiExecView;
  /** Tableau de bord du serveur (panneau de droite, Pro). */
  server?: ServerPanel;
  /** Conteneurs du serveur (panneau de droite, Pro). */
  containers?: ContainersPanel;
  /** Onglet ouvert sur une commande distante (shell ou journaux d'un conteneur). */
  remoteCommand?: string;
  /** Onglet « fichiers seulement » (FTP, S3…). */
  filesView?: FilesView;
}

const state = {
  protocols: [] as Manifest[],
  sessions: [] as Session[],
  tabs: [] as Tab[],
  active: null as string | null,
  filter: '',
  folders: [] as string[],
  /** Panneau de droite affiché (vide = masqué). */
  /** Sessions qui ont une note. */
  noteIds: new Set<string>(),
  /** Onglets affichés côte à côte (2 à 4), vide = un seul onglet à l'écran. */
  split: [] as string[],
  /** Saisie multiple : la frappe part vers toutes les sessions de l'écran partagé. */
  broadcast: false,
  snippets: [] as Snippet[],
  folderColors: {} as Record<string, string>,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tree = $('tree');
const tabsBar = $('tabs');
const toolbar = $('toolbar');
const views = $('views');
const details = $('details');
const statusBar = $('status');
const search = $<HTMLInputElement>('search');

const protocolOf = (id?: string) => state.protocols.find((p) => p.id === id);
/** Extension installée : intégrée d'office, ou prise dans le catalogue, ou déjà utilisée par des sessions. */
const extensionInstalled = (id: string) =>
  !(id === 'proxmox' ? PROXMOX_EXTENSION : protocolOf(id))?.catalog || settings().installedExtensions.includes(id) || state.sessions.some((s) => s.protocol === id);
/** Extension activée (Paramètres › Extensions). */
const extensionEnabled = (id: string) => extensionInstalled(id) && !settings().disabledExtensions.includes(id);
/** Catalogue : installer (ou retirer) une extension. Ses sessions éventuelles restent. */
function installExtension(id: string, on: boolean) {
  const others = settings().installedExtensions.filter((x) => x !== id);
  updateSettings({
    installedExtensions: on ? [...others, id] : others,
    disabledExtensions: settings().disabledExtensions.filter((x) => x !== id),
  });
}
const enabledProtocols = () => state.protocols.filter((p) => extensionEnabled(p.id));
function setExtension(id: string, on: boolean) {
  const others = settings().disabledExtensions.filter((x) => x !== id);
  updateSettings({ disabledExtensions: on ? others : [...others, id] });
}
const sessionOf = (id?: string) => state.sessions.find((s) => s.id === id);
const activeTab = () => state.tabs.find((t) => t.id === state.active);
const folders = () => state.folders;
const isConnected = (sessionId: string) => state.tabs.some((t) => t.sessionId === sessionId && t.state === 'connected');

function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

// ---------- Arbre des sessions ----------

// Les sessions d'une extension désactivée ne sont pas supervisées.
const monitor = new Monitor(() => state.sessions.filter((s) => extensionEnabled(s.protocol)), () => { renderTree(); renderStatus(); });

const sessionTree = new SessionTree(tree, {
  isConnected,
  protocolEnabled: extensionEnabled,
  enableProtocol: (id) => setExtension(id, true),
  health: (id) => {
    if (!settings().monitoring || !extensionEnabled(sessionOf(id)?.protocol ?? '')) return { cls: '', title: '' };
    if (monitor.isExcluded(id)) return { cls: 'off', title: tr('Not monitored', 'Non surveillé') };
    const hl = monitor.get(id);
    if (!hl) return { cls: 'unknown', title: '' };
    return hl.up ? { cls: 'up', title: `En ligne · ${hl.latencyMs} ms` } : { cls: 'down', title: `Injoignable : ${hl.error ?? ''}` };
  },
  toggleMonitor: (s) => monitor.toggleExcluded(s.id),
  folderColor: (path) => colorOf(path, state.folderColors),
  colorKey: (path) => state.folderColors[path],
  setFolderColor: (path, color) => act(() => folderColors.set(path, color)),
  activeSessionId: () => activeTab()?.sessionId,
  hasNote: (id) => state.noteIds.has(id),
  isPinned: (id) => settings().favorites.includes(id),
  togglePin: (s) => {
    const list = settings().favorites;
    updateSettings({ favorites: list.includes(s.id) ? list.filter((id) => id !== s.id) : [...list, s.id] });
    renderTree();
  },
  target: (s) => sessionTarget(s),
  netTools: (s) => openNetTools(typeof s.values.host === 'string' ? s.values.host : '', s),
  openFiles: (s) => openSessionFiles(s),
  wake: (s) => wakeSession(s, toast),
  multiExec: (folder) => openMultiExec(folder),
  openSession: (s) => openSession(s),
  editSession: (s) => editSession(s),
  duplicateSession: (s) => act(async () => {
    const copy = await api.duplicateSession(s.id);
    toast(tr(`Session duplicated: ${copy.name}`, `Session dupliquée : ${copy.name}`));
  }),
  removeSession: (s) => removeSession(s),
  newSession: (folder) => newSession(folder),
  newFolder: (parent) => promptNewFolder(parent),
  renameFolder: (path) => {
    const name = prompt(tr('New folder name:', 'Nouveau nom du dossier :'), leafOf(path))?.trim();
    if (!name || name === leafOf(path)) return;
    const parent = parentOf(path);
    act(() => api.renameFolder(path, parent ? `${parent}/${name}` : name));
  },
  deleteFolder: (path) => {
    const inside = state.sessions.filter((s) => s.folder === path || s.folder.startsWith(`${path}/`)).length;
    const where = parentOf(path) ? tr(`the folder « ${parentOf(path)} »`, `le dossier « ${parentOf(path)} »`) : tr('the root', 'la racine');
    const detail = inside ? tr(`\nIts ${inside} session(s) and subfolders will be moved to ${where} (nothing is deleted).`, `\nSes ${inside} session(s) et sous-dossiers seront déplacés dans ${where} (rien n'est supprimé).`) : '';
    if (confirm(tr(`Delete the folder « ${leafOf(path)} »?${detail}`, `Supprimer le dossier « ${leafOf(path)} » ?${detail}`))) act(() => api.deleteFolder(path));
  },
  openAll: (path) => {
    const list = state.sessions.filter((s) => s.folder === path || s.folder.startsWith(`${path}/`));
    if (list.length > 8 && !confirm(tr(`Open ${list.length} sessions?`, `Ouvrir ${list.length} sessions ?`))) return;
    list.forEach((s) => openSession(s));
  },
  moveSessions: (ids, folder) => act(() => api.moveSessions(ids, folder)),
  moveFolder: (path, parent) => act(() => api.renameFolder(path, parent ? `${parent}/${leafOf(path)}` : leafOf(path))),
});
tree.addEventListener('tree-change', () => renderTree());
tree.addEventListener('tree-top', () => search.focus());

// ---------- Extension Portunia Gate (Gates) ----------

/** Santé des Gates administrées (pastille de la barre latérale). */
const gateHealth = new Map<string, string>();
const gatePanel = new GatePanel($('gates'), {
  toast,
  openServer: (b, s) => openGateServer(b, s),
  sessions: () => state.sessions,
  removeSessions: async (ids) => {
    for (const id of ids) {
      for (const t of state.tabs.filter((t) => t.sessionId === id)) closeTab(t.id);
      await api.deleteSession(id).catch((e) => toast(errorText(e), 'error'));
    }
    await reload();
  },
  openAdmin: (b) => openGateAdmin(b),
  openAudit: (b) => openGateAudit(b),
  openApprovals: (b) => openGateApprovals(b),
  pendingApprovals: (b) => approvalWatch?.pending.get(b.id) ?? 0,
  protocolEnabled: (id) => extensionEnabled(id),
  allowsAdmin: () => allows('gateAdmin'),
  openStatus: (b) => openGateStatus(b),
  allowsUpdate: () => allows('gateUpdate'),
  health: (b) => gateHealth.get(b.id),
  setHealth: (id, level) => {
    if (gateHealth.get(id) === level) return;
    gateHealth.set(id, level);
    gatePanel?.render();
  },
  filter: () => state.filter,
  clearFilter: () => { search.value = ''; state.filter = ''; renderTree(); },
});

/** Serveur d'une Gate : session SSH par la Gate, avec un jeton à usage unique par connexion. */
function openGateServer(b: Gate, s: GateServer) {
  if (s.protocole === 'rdp') return openGateDesktop(b, s);
  if (s.protocole === 'http' || s.protocole === 'https') return openGateWeb(b, s);
  const rebond = s.mode === 'rebond';
  const session: Session = {
    id: '', name: `${s.nom} · ${b.name}`, folder: '', protocol: 'ssh', tags: [], secretKeys: [],
    // Rebond : authentification de bout en bout, identifiants demandés dans le terminal au besoin.
    values: rebond ? { host: s.hote, port: s.port, username: s.compte ?? '', auth: 'auto' } : { host: b.host, port: b.sshPort, username: `${b.login}%${s.nom}`, auth: 'key' },
  };
  const connect = async (typed: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => {
    try {
      return await connectGate(b.id, s.nom, typed, cols, rows, onEvent);
    } catch (e) {
      if (errorText(e) !== 'SESSION_EXPIREE') throw e;
      if (await gatePanel.reconnect(b.id)) return connectGate(b.id, s.nom, typed, cols, rows, onEvent);
      throw new Error(tr('Gate session expired: sign in again (Gates section).', 'Session de la Gate expirée : reconnectez-vous (section Gates).'));
    }
  };
  return openSession(session, undefined, { connect, typing: rebond });
}

/**
 * Interface web d'un serveur de la Gate : fenêtre web sur un relais local vers la Gate, qui
 * relaie vers le serveur et note les pages ouvertes.
 */
function openGateWeb(b: Gate, s: GateServer) {
  const session: Session = { id: '', name: `${s.nom} · ${b.name}`, folder: '', protocol: 'web', tags: [], secretKeys: [], values: { url: `${s.protocole}://${s.hote}:${s.port}` } };
  const connect = async (_t: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => {
    try {
      return await connectGate(b.id, s.nom, {}, cols, rows, onEvent);
    } catch (e) {
      if (errorText(e) !== 'SESSION_EXPIREE') throw e;
      if (await gatePanel.reconnect(b.id)) return connectGate(b.id, s.nom, {}, cols, rows, onEvent);
      throw new Error(tr('Gate session expired: sign in again (Gates section).', 'Session de la Gate expirée : reconnectez-vous (section Gates).'));
    }
  };
  return openSession(session, undefined, { connect, typing: false });
}

/**
 * Serveur Bureau à distance d'une Gate (mode rebond) : onglet RDP habituel, à travers un
 * tunnel par la Gate. Le serveur Windows authentifie lui-même : identifiants demandés à
 * chaque ouverture, jamais enregistrés.
 */
async function openGateDesktop(b: Gate, s: GateServer) {
  // Coffre : la Gate ouvre la session Windows avec le compte qu'elle garde, rien à demander.
  const cred = s.mode === 'coffre' ? { username: s.compte ?? '', password: '' } : await askCredentials(
    { protocol: 'rdp', name: s.nom, values: { host: s.nom, username: s.compte ?? '' } } as QuickTarget,
    s.mode === 'enregistre'
      ? tr(`Windows credentials for ${s.nom} (local account or DOMAIN\\user). The Gate relays and records the session; it does not see your password.`, `Identifiants Windows de ${s.nom} (compte local ou DOMAINE\\utilisateur). La Gate relaie et enregistre la session ; il ne voit pas votre mot de passe.`)
      : tr(`Windows credentials for ${s.nom} (local account or DOMAIN\\user). The Gate relays the encrypted connection without reading it.`, `Identifiants Windows de ${s.nom} (compte local ou DOMAINE\\utilisateur). La Gate relaie la connexion chiffrée sans la lire.`),
  );
  if (!cred) return;
  const session: Session = {
    id: '', name: `${s.nom} · ${b.name}`, folder: '', protocol: 'rdp', tags: [], secretKeys: [],
    values: { host: s.hote, port: s.port, username: cred.username, client: 'tab' },
  };
  const typed = { username: cred.username, password: cred.password };
  const connect = async (_t: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => {
    try {
      return await connectGate(b.id, s.nom, typed, cols, rows, onEvent);
    } catch (e) {
      if (errorText(e) !== 'SESSION_EXPIREE') throw e;
      if (await gatePanel.reconnect(b.id)) return connectGate(b.id, s.nom, typed, cols, rows, onEvent);
      throw new Error(tr('Gate session expired: sign in again (Gates section).', 'Session de la Gate expirée : reconnectez-vous (section Gates).'));
    }
  };
  return openSession(session, undefined, { connect, typing: false });
}

/**
 * Assistance à distance : écran de la personne aidée dans un onglet Bureau à distance, à travers
 * le relais de la Gate (chiffré de bout en bout par le code qu'elle a lu).
 */
/** Bandeau d'assistance de chaque onglet (fichiers déposés sur l'écran). */
const assistPanels = new WeakMap<HTMLElement, AssistPanel>();

function openAssist(b: Gate, code: string) {
  const session: Session = {
    id: '', name: tr(`Assistance · ${code}`, `Assistance · ${code}`), folder: '', protocol: 'rdp', tags: [], secretKeys: [],
    values: { host: b.host, port: b.apiPort, username: '', client: 'tab' },
  };
  // Bandeau de l'onglet : contrôle, pause, qualité, discussion.
  const assist = crypto.randomUUID();
  const panel = new AssistPanel((m) => assistSend(assist, m), toast, {
    offer: (paths) => assistOffer(assist, paths),
    file: (id, dest) => assistFile(assist, id, dest),
  });
  const onAssist = (e: any) => panel.handle(e);
  const connect = async (_t: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => {
    try {
      return await connectAssist(b.id, code, assist, cols, rows, onEvent, onAssist);
    } catch (e) {
      if (errorText(e) !== 'SESSION_EXPIREE') throw e;
      if (await gatePanel.reconnect(b.id)) return connectAssist(b.id, code, assist, cols, rows, onEvent, onAssist);
      throw new Error(tr('Gate session expired: sign in again (Gates section).', 'Session de la Gate expirée : reconnectez-vous (section Gates).'));
    }
  };
  const decorate = (view: HTMLElement, screen: HTMLElement) => {
    view.classList.add('assist-pane');
    view.insertBefore(panel.bar, screen);
    view.append(panel.chat, panel.drop);
    assistPanels.set(view, panel);
  };
  return openSession(session, undefined, { connect, typing: false, decorate });
}

// ---------- Extension Proxmox VE ----------

const proxmoxPanel = new ProxmoxPanel($('proxmox'), {
  toast,
  openConsole: (p, node, kind, vmid, title, upgrade) => {
    // Console VNC de Proxmox, relayée par Portunia : onglet VNC habituel.
    const session: Session = { id: '', name: `${title} · ${p.name}`, folder: '', protocol: 'vnc', tags: [], secretKeys: [], values: { host: p.host, port: p.port } };
    const connect = (_t: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => connectProxmox(p.id, node, kind, vmid, cols, rows, onEvent, upgrade);
    openSession(session, undefined, { connect, typing: false });
  },
  openTerminal: (p, node, kind, vmid, title, cmd) => {
    // Terminal texte de Proxmox (termproxy) : onglet terminal ordinaire.
    const session: Session = { id: '', name: `${title} · ${p.name}`, folder: '', protocol: 'telnet', tags: [], secretKeys: [], values: { host: p.host, port: p.port } };
    const connect = (_t: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => connectProxmoxTerminal(p.id, node, kind, vmid, cols, rows, onEvent, cmd);
    openSession(session, undefined, { connect, typing: false });
  },
  quickConnect: (text) => quickConnect(text),
  saveSession: (protocol, name, host) => saveQuick({ protocol, name, values: { host } }),
  openMonitor: (p, node) => openProxmoxMonitor(p, node),
  vncEnabled: () => extensionEnabled('vnc'),
  allowed: () => allows('proxmox'),
  filter: () => state.filter,
  clearFilter: () => { search.value = ''; state.filter = ''; renderTree(); },
});

/** Supervision d'un serveur Proxmox (ou d'un nœud) dans un onglet, relue tant qu'il est ouvert. */
async function openProxmoxMonitor(p: Pve, node?: string) {
  const title = tr(`Monitoring · ${node ?? p.name}`, `Supervision · ${node ?? p.name}`);
  const existing = state.tabs.find((t) => t.kind === 'admin' && t.title === title);
  if (existing) return activate(existing.id);
  const { ProxmoxMonitor } = await import('./proxmon');
  const monitor = new ProxmoxMonitor(p, node);
  const view = h('div', { class: 'page-view' }, monitor.el);
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'admin', title, view, state: 'connected', receive: false, pveMonitor: monitor };
  state.tabs.push(tab);
  activate(tab.id);
}

/** Le bouton « Assistance à distance » de la barre latérale suit les deux extensions. */
function showAssist() {
  $('open-assist').hidden = !(extensionEnabled('assistance') && extensionEnabled('gate'));
}

function openGateAdmin(b: Gate) {
  if (!allows('gateAdmin')) return toast(tr('Gate administration is part of Portunia Teams (Settings › Licence)', 'L’administration des Gates fait partie de Portunia Équipes (Paramètres › Licence)'), 'error');
  const title = `Admin · ${b.name}`;
  const existing = state.tabs.find((t) => t.kind === 'admin' && t.title === title);
  if (existing) return activate(existing.id);
  const view = h('div', { class: 'page-view' }, renderGateAdmin(b, gatePanel.host));
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'admin', title, view, state: 'connected', receive: false };
  state.tabs.push(tab);
  activate(tab.id);
}

/** État d'une Gate (santé, matériel, services, mise à jour) : pour tout administrateur de la Gate. */
async function openGateStatus(b: Gate) {
  const title = tr(`Status · ${b.name}`, `État · ${b.name}`);
  const existing = state.tabs.find((t) => t.kind === 'admin' && t.title === title);
  if (existing) return activate(existing.id);
  const { renderGateStatus } = await import('./gatestatus');
  const view = h('div', { class: 'page-view' },
    h('div', { class: 'ext-page gate-admin' },
      h('header', {}, h('h2', {}, title)),
      renderGateStatus(b, { toast, allowsUpdate: () => allows('gateUpdate'), allowsSettings: () => allows('gateAdmin'), onLevel: (id, level) => gatePanel.host.setHealth(id, level) })));
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'admin', title, view, state: 'connected', receive: false };
  state.tabs.push(tab);
  activate(tab.id);
}

/** Audit de la Gate (sessions et journal), chargé à la demande. */
/** Approbations des accès d'une Gate : demander, décider, retirer (page en onglet). */
async function openGateApprovals(b: Gate) {
  const title = tr(`Approvals · ${b.name}`, `Approbations · ${b.name}`);
  const existing = state.tabs.find((t) => t.kind === 'admin' && t.title === title);
  if (existing) return activate(existing.id);
  const { renderApprovals } = await import('./approvals');
  const view = h('div', { class: 'page-view' }, renderApprovals(b, { toast }));
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'admin', title, view, state: 'connected', receive: false };
  state.tabs.push(tab);
  activate(tab.id);
}

// Surveillance des approbations (notifications du système), lancée au chargement des Gates.
let approvalWatch: import('./approvals').ApprovalWatch | null = null;
void import('./approvals').then(({ ApprovalWatch }) => {
  approvalWatch = new ApprovalWatch(() => gatePanel.list, () => gatePanel.render());
  // Premier passage après le chargement des Gates.
  setTimeout(() => approvalWatch?.start(), 8000);
});

async function openGateAudit(b: Gate) {
  if (!allows('gateAdmin')) return toast(tr('Gate audit is part of Portunia Teams (Settings › Licence)', 'L’audit des Gates fait partie de Portunia Équipes (Paramètres › Licence)'), 'error');
  const title = `Audit · ${b.name}`;
  const existing = state.tabs.find((t) => t.kind === 'admin' && t.title === title);
  if (existing) return activate(existing.id);
  const { renderGateAudit } = await import('./audit');
  const view = h('div', { class: 'page-view' }, renderGateAudit(b, { toast, openRecording: (bb, s, start) => openAuditReplay(bb, s, start) }));
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'admin', title, view, state: 'connected', receive: false };
  state.tabs.push(tab);
  activate(tab.id);
}

/** Relecture d'une session de la Gate dans un onglet. `reveal` : saisies masquées en clair (administrateur). */
async function openAuditReplay(b: Gate, s: AuditRow, start?: number, reveal = false, replace?: Tab) {
  const title = replayTitle(s.serveur, s.debut);
  const existing = !replace && start == null && state.tabs.find((t) => t.kind === 'replay' && t.title === title);
  if (existing) return activate(existing.id);
  const view = h('div', { class: 'pane audit-pane' });
  // Onglet qui affiche ce lecteur (remplacé par la version révélée).
  let owner: Tab | undefined = replace;
  const built = await buildReplay(b, s.id, view, {
    start,
    reveal,
    host: {
      toast,
      reveal: () => openAuditReplay(b, s, undefined, true, owner),
      // Lecteur dans sa propre fenêtre : l'onglet se ferme.
      detach: () => {
        gates.openReplayWindow(b.id, s.id, reveal, title)
          .then(() => { if (owner) closeTab(owner.id); })
          .catch((e) => toast(errorText(e), 'error'));
      },
    },
  });
  if (!built) return;
  const player = built.player;
  views.append(view);
  if (replace) {
    replace.auditPlayer?.dispose();
    replace.view.remove();
    replace.view = view;
    replace.auditPlayer = player;
    replace.title = tr(`${title} (revealed)`, `${title} (révélé)`);
    renderTabs();
    return activate(replace.id);
  }
  const tab: Tab = { id: crypto.randomUUID(), kind: 'replay', title, view, state: 'connected', receive: false, auditPlayer: player };
  owner = tab;
  state.tabs.push(tab);
  activate(tab.id);
  view.focus();
}

function promptNewFolder(parent: string) {
  const name = prompt(parent ? tr(`New subfolder in « ${parent} »:`, `Nouveau sous-dossier dans « ${parent} » :`) : tr('Name of the new folder:', 'Nom du nouveau dossier :'))?.trim();
  if (name) act(() => api.createFolder(parent ? `${parent}/${name}` : name));
}

/** Lance une action sur les sessions, affiche l'erreur éventuelle, puis recharge. */
async function act(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (e) {
    toast(errorText(e), 'error');
  }
  await reload();
}

// ---------- Barre latérale : rail et panneaux ----------

type Pane = 'sessions' | 'gates' | 'proxmox' | 'pc';
const PANE_KEY = 'portunia.panneau';
const RECENT_KEY = 'portunia.recentes';
let pane: Pane = (() => { try { return (localStorage.getItem(PANE_KEY) as Pane | null) ?? 'sessions'; } catch { return 'sessions'; } })();
/** Puce de filtre active : all, up, fav, p:<protocole>, t:<étiquette>. */
let chip = 'all';

/** Affiche un panneau ; un clic sur l'icône du panneau ouvert replie la barre. */
function showPane(next: Pane, fromRail = false) {
  const app = document.querySelector<HTMLElement>('.app')!;
  if (next === 'gates' && !extensionEnabled('gate')) next = 'sessions';
  if (next === 'proxmox' && !extensionEnabled('proxmox')) next = 'sessions';
  const fold = fromRail && next === pane && !app.classList.contains('folded');
  app.classList.toggle('folded', fold);
  pane = next;
  try { localStorage.setItem(PANE_KEY, next); } catch { /* stockage indisponible */ }
  for (const p of ['sessions', 'gates', 'proxmox', 'pc'] as Pane[]) {
    $(`pane-${p}`).hidden = p !== next;
    $(`rail-${p}`).classList.toggle('on', p === next && !fold);
    $(`rail-${p}`).setAttribute('aria-pressed', String(p === next && !fold));
  }
}

function syncRail() {
  $('rail-gates').hidden = !extensionEnabled('gate');
  $('rail-proxmox').hidden = !extensionEnabled('proxmox');
  showPane(pane);
}

function recentSessions(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}'); } catch { return {}; }
}

function markRecent(id: string) {
  const list = Object.entries({ ...recentSessions(), [id]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 20);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(Object.fromEntries(list))); } catch { /* stockage indisponible */ }
}

function chipMatches(s: Session): boolean {
  if (chip === 'up') return isConnected(s.id);
  if (chip === 'fav') return settings().favorites.includes(s.id);
  if (chip.startsWith('p:')) return s.protocol === chip.slice(2);
  if (chip.startsWith('t:')) return s.tags.includes(chip.slice(2));
  return true;
}

/** Puces sous le filtre : connectées, épinglées, protocoles, étiquettes les plus utilisées. */
function renderChips() {
  const all = state.sessions;
  const up = all.filter((s) => isConnected(s.id)).length;
  const pinned = all.filter((s) => settings().favorites.includes(s.id)).length;
  const protocols = [...new Set(all.map((s) => s.protocol))].filter(extensionEnabled).sort();
  const tagCount = new Map<string, number>();
  all.forEach((s) => s.tags.forEach((tag) => tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)));
  const tags = [...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([tag]) => tag);
  const defs: [string, string][] = [
    ['all', tr('All', 'Toutes')],
    ...(up ? [['up', tr(`Connected · ${up}`, `Connectées · ${up}`)] as [string, string]] : []),
    ...(pinned ? [['fav', tr('Pinned', 'Épinglées')] as [string, string]] : []),
    ...(protocols.length > 1 ? protocols.map((p) => [`p:${p}`, p.toUpperCase()] as [string, string]) : []),
    ...tags.map((tag) => [`t:${tag}`, `#${tag}`] as [string, string]),
  ];
  if (!defs.some(([id]) => id === chip)) chip = 'all';
  $('session-chips').replaceChildren(...(defs.length > 1 ? defs.map(([id, label]) => h('button', {
    type: 'button', class: `fchip${chip === id ? ' on' : ''}`, 'aria-pressed': String(chip === id),
    onclick: () => { chip = chip === id ? 'all' : id; renderTree(); },
  }, label)) : []));
}

function renderTree() {
  renderChips();
  const all = state.sessions;
  const pinnedIds = settings().favorites;
  const recent = recentSessions();
  const q = state.filter.trim().toLowerCase();
  const gateHits = q && extensionEnabled('gate') ? gatePanel.countMatches(q) : 0;
  sessionTree.render(state.folders, chip === 'all' ? all : all.filter(chipMatches), state.filter, {
    narrowed: chip !== 'all' || q !== '',
    pinned: all.filter((s) => pinnedIds.includes(s.id)).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })),
    recent: all.filter((s) => recent[s.id] && !pinnedIds.includes(s.id)).sort((a, b) => recent[b.id] - recent[a.id]).slice(0, 5).map((s) => ({ session: s, at: recent[s.id] })),
    footer: gateHits > 0 && h('button', { class: 'tree-item gate-hits', onclick: () => showPane('gates') },
      icon('shield', 14), h('span', { class: 'grow' }, tr(`${gateHits} server(s) in the Gates`, `${gateHits} serveur(s) dans les Gates`)), icon('chevronRight', 12)),
  });
  $('session-count').textContent = String(all.length);
  if (extensionEnabled('gate')) gatePanel.render();
  if (extensionEnabled('proxmox')) proxmoxPanel.render();
  state.tabs.find((t) => t.kind === 'library')?.library?.render();
}

/** Onglet « Toutes les sessions » : tableau triable, facettes, sélection multiple. */
function openLibrary() {
  const existing = state.tabs.find((t) => t.kind === 'library');
  if (existing) {
    existing.library?.render();
    activate(existing.id);
    existing.library?.focus();
    return;
  }
  const library = new SessionLibrary({
    sessions: () => state.sessions,
    isConnected,
    isPinned: (id) => settings().favorites.includes(id),
    target: (s) => sessionTarget(s),
    lastOpened: (id) => recentSessions()[id],
    folderColor: (path) => colorOf(path, state.folderColors),
    open: (list) => {
      if (list.length > 8 && !confirm(tr(`Open ${list.length} sessions?`, `Ouvrir ${list.length} sessions ?`))) return;
      list.forEach((s) => openSession(s));
    },
    edit: (s) => editSession(s),
    multiExec: (ids) => openMultiExec(null, ids),
    newSession: () => newSession(),
  });
  const view = h('div', { class: 'page-view' }, library.el);
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'library', title: tr('All sessions', 'Toutes les sessions'), view, state: 'connected', receive: false, library };
  state.tabs.push(tab);
  activate(tab.id);
  library.focus();
}

/** Adresse d'une session : user@hôte, ou l'URL. */
function sessionTarget(s: Session): string {
  const v = s.values;
  if (typeof v.url === 'string' && v.url) return v.url;
  return [v.username && `${v.username}@`, v.host].filter(Boolean).join('');
}

// ---------- Onglets ----------

/** Vue d'un onglet de session : terminal ou écran distant. */
const viewOf = (tab: Tab): TerminalView | ScreenView | FilesView | undefined => tab.term ?? tab.screen ?? tab.filesView;

// ---------- Écran partagé ----------

const MAX_PANES = 4;

/** Onglets à l'écran : l'écran partagé s'il contient l'onglet actif, sinon l'onglet actif seul. */
function visibleTabs(): Tab[] {
  if (state.split.length > 1 && state.active && state.split.includes(state.active)) {
    return state.split.map((id) => state.tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t);
  }
  const tab = activeTab();
  return tab ? [tab] : [];
}

const isSplit = () => visibleTabs().length > 1;

function addToSplit(tabId: string) {
  const base = isSplit() ? [...state.split] : state.active ? [state.active] : [];
  if (base.includes(tabId)) return;
  if (base.length >= MAX_PANES) return toast(tr(`Split screen is limited to ${MAX_PANES} sessions`, `L'écran partagé est limité à ${MAX_PANES} sessions`), 'error');
  state.split = [...base, tabId];
  activate(state.active ?? tabId);
}

function removeFromSplit(tabId: string) {
  state.split = state.split.filter((id) => id !== tabId);
  if (state.split.length < 2) {
    state.split = [];
    state.broadcast = false;
  }
  if (state.active === tabId && state.split.length) state.active = state.split[0];
  activate(state.active ?? tabId);
}

function leaveSplit() {
  state.split = [];
  state.broadcast = false;
  if (state.active) activate(state.active);
}

/** Contexte des commandes enregistrées pour l'onglet actif. */
function snippetContext(): SnippetContext {
  return {
    snippets: state.snippets,
    folders: state.folders,
    session: sessionOf(activeTab()?.sessionId),
    send: (text) => {
      const tab = activeTab();
      if (!tab?.term?.connection) return toast(tr('The active session is not connected', 'La session active n\'est pas connectée'), 'error');
      if (!broadcastFrom(tab, text)) tab.term.send(text);
      tab.term.focus();
    },
    reload: async () => (state.snippets = await api.listSnippets()),
    toast,
  };
}

/** Saisie multiple : envoie la frappe à toutes les sessions visibles qui la reçoivent. */
function broadcastFrom(source: Tab, data: string): boolean {
  const visible = visibleTabs();
  if (!state.broadcast || visible.length < 2 || !visible.includes(source)) return false;
  for (const t of visible) {
    if (t === source || t.receive) t.term?.send(data);
  }
  return true;
}

function splitMenu(e: MouseEvent) {
  const candidates = state.tabs.filter((t) => isTerminalTab(t) && !visibleTabs().includes(t));
  showMenu(e.clientX, e.clientY, [
    ...(candidates.length
      ? candidates.map((t) => ({ label: tr(`Show beside: ${t.title}`, `Afficher à côté : ${t.title}`), icon: 'split', action: () => addToSplit(t.id) }))
      : [{ label: tr('Open another session first', 'Ouvrez d\'abord une autre session'), action: () => {} }]),
    ...(isSplit() ? ['separator' as const, { label: tr('Leave split screen', 'Quitter l\'écran partagé'), icon: 'close', action: leaveSplit }] : []),
  ]);
}

function tabMenu(t: Tab, e: MouseEvent) {
  e.preventDefault();
  const inSplit = isSplit() && visibleTabs().includes(t);
  showMenu(e.clientX, e.clientY, [
    ...(isTerminalTab(t) && !inSplit && t.id !== state.active && !!activeTab() && isTerminalTab(activeTab()!)
      ? [{ label: tr('Show beside the active tab', 'Afficher à côté de l\'onglet actif'), icon: 'split', action: () => addToSplit(t.id) }]
      : []),
    ...(inSplit ? [{ label: tr('Remove from split screen', 'Retirer de l\'écran partagé'), icon: 'split', action: () => removeFromSplit(t.id) }] : []),
    { label: tr('Close', 'Fermer'), icon: 'close', action: () => closeTab(t.id) },
    { label: tr('Close the other tabs', 'Fermer les autres onglets'), action: () => state.tabs.filter((o) => o !== t).forEach((o) => closeTab(o.id)) },
  ]);
}

function renderTabs() {
  tabsBar.replaceChildren(
    ...state.tabs.map((t) => {
      const selected = t.id === state.active;
      const shown = isSplit() && visibleTabs().includes(t);
      const tabEl = h('div', { class: `tab${selected ? ' active' : ''}${shown && !selected ? ' shown' : ''}` },
        h('button', { role: 'tab', 'aria-selected': String(selected), class: 'tab-main', onclick: () => activate(t.id) },
          t.kind === 'local' && t.shell ? shellIcon(t.shell, 14) : t.kind === 'session' ? h('span', { class: `dot ${t.state === 'connected' ? 'on' : t.state === 'connecting' || t.state === 'reconnecting' ? 'wait' : ''}` }) : icon(t.kind === 'replay' ? 'play' : t.kind === 'library' ? 'files' : 'puzzle', 14),
          h('span', { class: 'ellipsis' }, t.title),
          t.protocol && badge(t.protocol)),
        h('button', { class: 'icon-btn sm', 'aria-label': tr(`Close ${t.title}`, `Fermer ${t.title}`), title: keys(tr('Close (Ctrl Shift W)', 'Fermer (Ctrl Maj W)')), onclick: () => closeTab(t.id) }, icon('close', 13)));
      tabEl.addEventListener('contextmenu', (e) => tabMenu(t, e));
      paint(tabEl, colorOf(sessionOf(t.sessionId)?.folder ?? '', state.folderColors));
      return tabEl;
    }),
    h('button', { class: 'icon-btn', 'aria-label': tr('Palette: sessions, shells, actions and quick connect', 'Palette : sessions, shells, actions et connexion rapide'), title: keys(tr('Go to… or quick connect (Ctrl Shift O)', 'Aller à… ou connexion rapide (Ctrl Maj O)')), onclick: () => openGlobalPalette() }, icon('search')),
    h('button', { class: 'icon-btn', 'aria-label': tr('Open a session or a local shell', 'Ouvrir une session ou un shell local'), title: keys(tr('New session or local shell (Ctrl Shift T: default shell)', 'Nouvelle session ou shell local (Ctrl Maj T : shell par défaut)')), onclick: (e: MouseEvent) => openPlusMenu(e) }, icon('plus')),
  );
}

function renderToolbar() {
  const tab = activeTab();
  const session = sessionOf(tab?.sessionId) ?? (tab?.quick && quickSession(tab.quick));
  if (tab?.kind === 'local' && tab.shell) return renderLocalToolbar(tab, tab.shell);
  if (!tab || tab.kind !== 'session' || !session) {
    toolbar.replaceChildren();
    toolbar.hidden = true;
    return;
  }
  toolbar.hidden = false;
  // Couleur du dossier (ex. rouge pour la production) et nom du dossier coloré.
  const color = colorOf(session.folder, state.folderColors);
  paint(toolbar, color);
  const coloredFolder = color ? envFolder(session.folder) : '';
  const v = session.values;
  const target = [v.username && `${v.username}@`, v.host ?? v.url, v.port && `:${v.port}`].filter(Boolean).join('');
  const label = { connecting: tr('connecting…', 'connexion…'), connected: tr('connected', 'connecté'), reconnecting: 'reconnexion…', closed: tr('disconnected', 'déconnecté') }[tab.state];
  const side = shownSide(tab);
  const ssh = tab.state === 'connected' && session.protocol === 'ssh';
  const panels = panelButtons(tab, session);
  // Ordre de repli quand la place manque : d'abord le libellé (label), puis le menu « ⋯ » (menu).
  const items: (ToolbarItem | '|' | 'panels')[] = [
    ...(tab.state === 'closed' ? [{ id: 'reconnect', icon: 'refresh', label: tr('Reconnect', 'Reconnecter'), action: () => reconnect(tab), cls: 'primary', fold: { label: 20 } }] : []),
    ...(tab.state === 'reconnecting' ? [{ id: 'cancel', icon: 'close', label: tr('Cancel the reconnection', 'Annuler la reconnexion'), action: () => viewOf(tab)?.cancelReconnect(), fold: { label: 20 } }] : []),
    ...(tab.term ? [{ id: 'commands', icon: 'commands', label: tr('Commands', 'Commandes'), title: keys(tr('Saved commands (Ctrl Shift P)', 'Commandes enregistrées (Ctrl Maj P)')), action: () => openPalette(snippetContext()), fold: { label: 9 } }] : []),
    ...(tab.term ? [{ id: 'search', icon: 'search', label: tr('Search in the terminal', 'Rechercher dans le terminal'), title: keys(tr('Search (Ctrl Shift F)', 'Rechercher (Ctrl Maj F)')), action: () => tab.term?.openSearch(), iconOnly: true }] : []),
    ...(tab.term && tab.state === 'connected' ? [{
      id: 'record', lead: h('span', { class: 'rec-dot' }), label: tab.recording ? tr('Stop recording', 'Arrêter l’enregistrement') : tr('Record', 'Enregistrer'),
      title: tab.recording ? `${tr('Recording', 'Enregistrement en cours')} : ${tab.recording}` : tr('Record this session (asciicast + text)', 'Enregistrer cette session (asciicast + texte)'),
      action: () => (tab.recording ? stopRecording(tab) : startRecording(tab)), cls: tab.recording ? 'rec' : '', fold: { label: 5 },
    }] : []),
    ...(tab.screen ? [{ id: 'cad', icon: 'power', label: tr('Ctrl+Alt+Del', 'Ctrl+Alt+Suppr'), title: tr('Send Ctrl+Alt+Del to the remote screen', 'Envoyer Ctrl+Alt+Suppr à l’écran distant'), action: () => tab.screen?.sendCtrlAltDel(), fold: { label: 4, menu: 7 } }] : []),
    ...(tab.screen?.filesAllowed ? [{ id: 'send-files', icon: 'upload', label: tr('Send files', 'Envoyer des fichiers'), title: tr('Put files of this PC on the server\'s clipboard, then paste them there (Ctrl+V). You can also drop them on the screen.', 'Mettre des fichiers de ce poste au presse-papiers du serveur, puis les y coller (Ctrl+V). Vous pouvez aussi les déposer sur l’écran.'), action: () => tab.screen?.chooseFiles(), fold: { label: 5, menu: 7 } }] : []),
    ...(tab.screen?.remoteFiles ? [{ id: 'fetch-files', icon: 'download', label: tr('Get the files', 'Récupérer les fichiers'), title: tr('Save on this PC the files copied on the server (Ctrl+C)', 'Enregistrer sur ce poste les fichiers copiés sur le serveur (Ctrl+C)'), action: () => tab.screen?.fetchFiles(), cls: 'primary', fold: { label: 5, menu: 7 } }] : []),
    ...(tab.screen && session.protocol !== 'rdp' ? [{ id: 'clipboard', icon: 'copy', label: tr('Clipboard', 'Presse-papiers'), title: IS_MAC ? tr('Copy the Mac clipboard to the remote screen', 'Copier le presse-papiers du Mac vers l’écran distant') : tr('Copy the Windows clipboard to the remote screen', 'Copier le presse-papiers de Windows vers l’écran distant'), action: () => tab.screen?.sendClipboard(), fold: { label: 3, menu: 8 } }] : []),
    ...(tab.screen ? [{ id: 'fit', icon: 'move', label: tab.screen.fit ? tr('Real size', 'Taille réelle') : tr('Fit to window', 'Ajuster à la fenêtre'), title: tr('Fit the image to the tab or show it at real size', 'Adapter l’image à l’onglet ou afficher en taille réelle'), action: () => { tab.screen?.toggleFit(); renderToolbar(); }, fold: { label: 4, menu: 9 } }] : []),
    { id: 'split', icon: 'split', label: tr('Split screen', 'Écran partagé'), title: tr('Show several sessions side by side', 'Afficher plusieurs sessions côte à côte'), action: (e: MouseEvent) => splitMenu(e), cls: isSplit() ? 'on' : '', fold: { label: 4, menu: 10 } },
    ...(isSplit() ? [{
      id: 'broadcast', icon: 'broadcast', label: state.broadcast ? tr('Multi-input: ON', 'Saisie multiple : ACTIVE') : tr('Multi-input', 'Saisie multiple'),
      title: keys(tr('Send keystrokes to all displayed sessions (Ctrl Shift B)', 'Envoyer la frappe à toutes les sessions affichées (Ctrl Maj B)')), action: () => toggleBroadcast(), cls: state.broadcast ? 'warn' : '', pressed: state.broadcast, fold: { label: 6 },
    }] : []),
    '|',
    ...(!tab.quick && tab.state === 'connected' && protocolOf(session.protocol)?.portForwarding ? [{
      id: 'tunnels', icon: 'tunnel', label: 'Tunnels', title: tr('Port forwards through this session', 'Redirections de ports à travers cette session'),
      action: () => { const id = tab.term?.connection; if (id) openTunnels(session, id, toast, () => reload()); }, fold: { label: 3, menu: 8 },
    }] : []),
    ...(ssh ? [{ id: 'key', icon: 'lock', label: tr('SSH key', 'Clé SSH'), title: tr('Create an SSH key and install it on this server (no more password)', 'Créer une clé SSH et l’installer sur ce serveur (plus de mot de passe)'), action: () => openKeysFor(tab, session), fold: { label: 2, menu: 7 } }] : []),
    tab.quick
      ? { id: 'save', icon: 'plus', label: tr('Save as a session', 'Enregistrer comme session'), title: tr('Keep this connection in the session list', 'Garder cette connexion dans la liste des sessions'), action: () => { if (tab.quick) saveQuick(tab.quick); }, cls: 'primary', fold: { label: 8 } }
      : { id: 'edit', icon: 'edit', label: tr('Edit', 'Modifier'), title: tr('Edit the session', 'Modifier la session'), action: () => editSession(session), fold: { label: 1, menu: 6 } },
    '|',
    'panels',
    ...(tab.state === 'connected' ? [{ id: 'disconnect', icon: 'power', label: tr('Disconnect', 'Déconnecter'), title: tr('Close the connection and the tab', 'Fermer la connexion et l’onglet'), action: () => closeTab(tab.id), fold: { label: 11 } }] : []),
  ];
  toolbar.replaceChildren(
    h('div', { class: 'toolbar-info', title: [target || session.name, session.folder, label].filter(Boolean).join(' · ') },
      h('span', { class: `dot ${tab.state === 'connected' ? 'on' : tab.state === 'connecting' || tab.state === 'reconnecting' ? 'wait' : ''}` }),
      coloredFolder && h('span', { class: 'env-label', title: tr('Folder colour', 'Couleur du dossier') }, coloredFolder.toUpperCase()),
      h('strong', { class: 'ellipsis' }, target || session.name),
      session.folder && h('span', { class: 'muted tb-folder' }, `· ${session.folder}`),
      typeof v.jump === 'string' && v.jump.trim() && h('span', { class: 'muted tb-folder', title: tr('Jump server', 'Serveur de rebond') }, `· via ${v.jump}`),
      h('span', { class: 'muted tb-state' }, `· ${label}`)),
    toolbarActions(items, panels, side));
  fitToolbar();
}

/** Panneaux de la session (groupe de la barre et onglets du panneau ouvert). */
function panelButtons(tab: Tab, session: Session): PanelButton[] {
  const ssh = tab.state === 'connected' && session.protocol === 'ssh';
  const hasNote = !tab.quick && state.noteIds.has(session.id);
  return [
    ...(tab.files && !tab.filesView ? [{ side: 'files' as const, icon: 'files', label: tr('Files', 'Fichiers'), title: tr('File browser (SFTP)', 'Explorateur de fichiers (SFTP)'), open: () => showSide(tab, 'files') }] : []),
    ...(!tab.quick ? [{ side: 'notes' as const, icon: 'edit', label: 'Notes', title: hasNote ? tr('Notes for this session (a note exists)', 'Notes de cette session (une note existe)') : tr('Notes for this session (Markdown)', 'Notes de cette session (Markdown)'), open: () => toggleNotes(tab), dot: hasNote }] : []),
    ...(ssh ? [{ side: 'server' as const, icon: 'chart', label: tr('Server', 'Serveur'), title: tr('Dashboard: CPU, memory, disks, processes, failed services', 'Tableau de bord : processeur, mémoire, disques, processus, services en échec'), open: () => toggleServer(tab), locked: !allows('serverDashboard') }] : []),
    ...(ssh ? [{ side: 'containers' as const, icon: 'box', label: tr('Containers', 'Conteneurs'), title: tr('Docker / Podman containers and Kubernetes pods', 'Conteneurs Docker / Podman et pods Kubernetes'), open: () => toggleContainers(tab), locked: !allows('containers') }] : []),
  ];
}

interface ToolbarItem {
  id: string;
  label: string;
  icon?: string;
  /** Élément placé avant le libellé à la place de l'icône (point rouge de l'enregistrement). */
  lead?: Node;
  title?: string;
  action: (e: MouseEvent) => void;
  cls?: string;
  pressed?: boolean;
  /** Icône seule, quelle que soit la place. */
  iconOnly?: boolean;
  /** Rang de repli : le plus petit perd son libellé (label), puis passe dans « ⋯ » (menu), en premier. */
  fold?: { label?: number; menu?: number };
}

interface PanelButton {
  side: Exclude<SidePanel, ''>;
  icon: string;
  label: string;
  title: string;
  open: () => void;
  locked?: boolean;
  dot?: boolean;
}

/** Bouton de la barre : icône, libellé qui peut disparaître, rangs de repli en attributs. */
function toolbarButton(it: ToolbarItem): HTMLButtonElement {
  const b = h('button', {
    type: 'button', class: `btn tb-btn${it.cls ? ` ${it.cls}` : ''}${it.iconOnly ? ' icon-only' : ''}`, title: it.title ?? it.label, 'aria-label': it.label,
    'aria-pressed': it.pressed === undefined ? null : String(it.pressed), onclick: it.action,
  }, it.lead ?? (it.icon ? icon(it.icon, 14) : null), h('span', { class: 'tb-label' }, it.label)) as HTMLButtonElement;
  b.dataset.label = it.label;
  if (it.icon) b.dataset.icon = it.icon;
  b.dataset.id = it.id;
  if (it.iconOnly) b.dataset.iconOnly = '';
  if (it.fold?.label !== undefined) b.dataset.foldLabel = String(it.fold.label);
  if (it.fold?.menu !== undefined) b.dataset.foldMenu = String(it.fold.menu);
  return b;
}

function toolbarActions(items: (ToolbarItem | '|' | 'panels')[], panels: PanelButton[], side: SidePanel): HTMLElement {
  const out: HTMLElement[] = [];
  for (const it of items) {
    if (it === '|') { if (out.length && !out[out.length - 1].classList.contains('tb-sep')) out.push(h('span', { class: 'tb-sep', 'aria-hidden': 'true' })); continue; }
    if (it === 'panels') {
      if (panels.length) out.push(h('div', { class: 'tb-group', role: 'group', 'aria-label': tr('Session panels', 'Panneaux de la session') }, ...panels.map((p) => h('button', {
        type: 'button', class: `${side === p.side ? 'on' : ''}${p.locked ? ' locked' : ''}`, 'aria-pressed': String(side === p.side),
        'aria-label': p.label, title: p.locked ? `${p.title} · Pro` : p.title, onclick: p.open,
      }, icon(p.icon, 16), p.dot && h('span', { class: 'note-dot' })))));
      continue;
    }
    out.push(toolbarButton(it));
  }
  while (out.length && out[out.length - 1].classList.contains('tb-sep')) out.pop();
  const more = h('button', {
    type: 'button', class: 'btn tb-btn icon-only tb-more', hidden: true, 'aria-label': tr('More actions', 'Plus d’actions'), title: tr('More actions', 'Plus d’actions'),
    onclick: (e: MouseEvent) => {
      const folded = [...(e.currentTarget as HTMLElement).parentElement!.querySelectorAll<HTMLButtonElement>('.tb-btn.tb-folded')];
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, folded.map((b) => ({ label: b.dataset.label ?? '', icon: b.dataset.icon ?? 'more', action: () => b.click() })));
    },
  }, icon('more', 14), h('span', { class: 'tb-label' }, tr('More', 'Plus')));
  // « ⋯ » juste avant Déconnecter (ou à la fin).
  const last = out[out.length - 1];
  if (last?.dataset.id === 'disconnect') out.splice(out.length - 1, 0, more); else out.push(more);
  return h('div', { class: 'toolbar-actions' }, ...out);
}

/**
 * Garde la barre sur une ligne : selon la place, l'identité se raccourcit, des libellés
 * disparaissent (icône et infobulle), puis les actions rares passent dans « ⋯ ».
 */
function fitToolbar() {
  if (toolbar.hidden) return;
  const actions = toolbar.querySelector<HTMLElement>('.toolbar-actions');
  const info = toolbar.querySelector<HTMLElement>('.toolbar-info');
  if (!actions || !info) return;
  const width = toolbar.clientWidth;
  toolbar.dataset.size = width >= 1000 ? 'l' : width >= 760 ? 'm' : 's';
  const buttons = [...actions.querySelectorAll<HTMLButtonElement>('.tb-btn:not(.tb-more)')];
  const more = actions.querySelector<HTMLElement>('.tb-more');
  for (const b of buttons) {
    b.hidden = false;
    b.classList.remove('tb-folded');
    b.classList.toggle('icon-only', b.dataset.iconOnly !== undefined);
  }
  if (more) more.hidden = true;
  const keep = width >= 1000 ? 260 : width >= 760 ? 190 : 130;
  const style = getComputedStyle(toolbar);
  // Largeur naturelle de l'identité : ses morceaux visibles, avant tout rétrécissement.
  const parts = [...info.children].filter((c) => (c as HTMLElement).offsetParent !== null) as HTMLElement[];
  const natural = parts.reduce((n, c) => n + c.scrollWidth, 0) + 8 * Math.max(0, parts.length - 1);
  const room = () => width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - Math.min(natural, keep) - 12;
  tidySeparators(actions);
  if (actions.scrollWidth <= room()) return;
  const steps: { b: HTMLButtonElement; menu: boolean; rank: number }[] = [];
  for (const b of buttons) {
    if (b.dataset.foldLabel) steps.push({ b, menu: false, rank: Number(b.dataset.foldLabel) });
    if (b.dataset.foldMenu) steps.push({ b, menu: true, rank: Number(b.dataset.foldMenu) });
  }
  steps.sort((a, b) => a.rank - b.rank);
  for (const step of steps) {
    if (step.menu) {
      step.b.hidden = true;
      step.b.classList.add('tb-folded');
      if (more) more.hidden = false;
    } else step.b.classList.add('icon-only');
    tidySeparators(actions);
    if (actions.scrollWidth <= room()) return;
  }
}

/** Pas de séparateur en tête, en fin, ni deux de suite (groupe entièrement replié). */
function tidySeparators(actions: HTMLElement) {
  let previous: HTMLElement | null = null;
  for (const el of [...actions.children] as HTMLElement[]) {
    if (el.classList.contains('tb-sep')) {
      el.hidden = !previous || previous.classList.contains('tb-sep');
      if (!el.hidden) previous = el;
    } else if (!el.hidden) previous = el;
  }
  if (previous?.classList.contains('tb-sep')) previous.hidden = true;
}

type SidePanel = 'files' | 'notes' | 'server' | 'containers' | '';

/** Panneau affiché dans cet onglet : celui que l'utilisateur a ouvert, s'il existe encore. */
function shownSide(tab: Tab | undefined): SidePanel {
  // Onglet « fichiers seulement » : l'explorateur est déjà au centre.
  if (!tab || !tab.side || tab.filesView) return '';
  if (tab.side === 'notes' && tab.notes) return 'notes';
  if (tab.side === 'server' && tab.server) return 'server';
  if (tab.side === 'containers' && tab.containers) return 'containers';
  return tab.side === 'files' && tab.files ? 'files' : '';
}

// Panneau de droite : onglets en tête (Fichiers, Notes, Serveur, Conteneurs), contenu dessous.
const sideTabs = h('div', { class: 'side-tabs', role: 'tablist', 'aria-label': tr('Session panels', 'Panneaux de la session') });
const sideBody = h('div', { class: 'side-body' });
details.replaceChildren(sideTabs, sideBody);

function renderSideTabs(tab: Tab, side: SidePanel) {
  const session = sessionOf(tab.sessionId) ?? (tab.quick && quickSession(tab.quick));
  const list = session ? panelButtons(tab, session) : [];
  sideTabs.replaceChildren(
    ...list.map((p) => h('button', {
      type: 'button', role: 'tab', class: `side-tab${p.side === side ? ' on' : ''}`, 'aria-selected': String(p.side === side), title: p.title,
      onclick: () => { if (p.side !== shownSide(tab)) p.open(); },
    }, p.label)),
    h('span', { class: 'grow' }),
    h('button', {
      type: 'button', class: 'icon-btn sm', 'aria-label': tr('Close the panel', 'Fermer le panneau'), title: tr('Close the panel', 'Fermer le panneau'),
      onclick: () => { tab.side = ''; renderAll(); requestAnimationFrame(() => viewOf(tab)?.refit()); },
    }, icon('close', 14)));
}

/** Panneau de droite de l'onglet actif : fichiers, notes ou tableau de bord du serveur. */
function renderSidePanel() {
  const tab = activeTab();
  const side = shownSide(tab);
  // Le tableau de bord ne relève les mesures que lorsqu'il est visible.
  for (const t of state.tabs) t.server?.setVisible(t === tab && side === 'server');
  for (const t of state.tabs) t.containers?.setVisible(t === tab && side === 'containers');
  const panel = side === 'notes' ? tab?.notes?.el : side === 'server' ? tab?.server?.el : side === 'containers' ? tab?.containers?.el : side === 'files' ? tab?.files?.el : undefined;
  if (!panel) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  renderSideTabs(tab!, side);
  if (sideBody.firstChild !== panel) sideBody.replaceChildren(panel);
}

// Fenêtre étroite : le panneau passe par-dessus le terminal au lieu de le rétrécir.
// La barre d'outils se replie à chaque changement de largeur.
const contentArea = document.querySelector<HTMLElement>('.content')!;
new ResizeObserver(() => {
  const narrow = contentArea.clientWidth < 860;
  if (narrow !== contentArea.classList.contains('narrow')) {
    contentArea.classList.toggle('narrow', narrow);
    requestAnimationFrame(() => { const t = activeTab(); if (t) viewOf(t)?.refit(); });
  }
}).observe(contentArea);
new ResizeObserver(() => fitToolbar()).observe(toolbar);

/** Affiche un panneau, ou le masque s'il est déjà affiché. */
function showSide(tab: Tab, side: Exclude<SidePanel, ''>) {
  tab.side = shownSide(tab) === side ? '' : side;
  renderAll();
  requestAnimationFrame(() => viewOf(tab)?.refit());
}

/** Tableau de bord du serveur de l'onglet (Pro). */
function toggleServer(tab: Tab) {
  if (!allows('serverDashboard')) return toast(tr('The server dashboard is part of Portunia Pro (Settings › Licence)', 'Le tableau de bord des serveurs fait partie de Portunia Pro (Paramètres › Licence)'), 'error');
  const id = tab.term?.connection;
  if (!id) return;
  if (!tab.server || tab.server.connectionId !== id) {
    tab.server?.dispose();
    tab.server = new ServerPanel(id, tab.title, (cmd) => {
      if (!tab.term?.connection) return;
      tab.term.send(cmd);
      tab.term.focus();
    });
  }
  showSide(tab, 'server');
}

/** Affiche / masque les notes de la session de l'onglet. */
function toggleNotes(tab: Tab) {
  const session = sessionOf(tab.sessionId);
  if (!session) return;
  const created = !tab.notes;
  if (!tab.notes) {
    tab.notes = new NotesPanel(session.id, session.name, toast, (text) => {
      if (!tab.term?.connection) return toast(tr('The session is not connected', 'La session n\'est pas connectée'), 'error');
      if (!broadcastFrom(tab, text)) tab.term.send(text);
      tab.term.focus();
    }, (has) => {
      if (has) state.noteIds.add(session.id); else state.noteIds.delete(session.id);
      renderToolbar();
      renderTree();
    });
  }
  if (created) tab.side = '';
  showSide(tab, 'notes');
}

function renderStatus() {
  const open = state.tabs.filter((t) => t.kind === 'session' && t.state === 'connected').length;
  const localCount = state.tabs.filter((t) => t.kind === 'local' && t.state === 'connected').length;
  statusBar.replaceChildren(
    h('span', {}, h('span', { class: `dot${open ? ' on' : ''}` }), tr(`${open} session(s) connected${localCount ? ` · ${localCount} local shell(s)` : ''}`, `${open} session(s) connectée(s)${localCount ? ` · ${localCount} shell(s) local(aux)` : ''}`)),
    h('span', {}, tr(`${state.sessions.length} saved`, `${state.sessions.length} enregistrée(s)`)),
    h('span', { class: 'push' }, (() => {
      const installed = state.protocols.filter((p) => extensionInstalled(p.id)).length;
      const on = enabledProtocols().length;
      return on < installed ? `${on}/${installed} extensions` : `${installed} extensions`;
    })()),
    ...(settings().monitoring && monitor.summary().total ? [h('button', {
      class: `status-btn${monitor.summary().up < monitor.summary().total ? ' warn' : ''}`, title: tr('Server monitoring', 'Supervision des serveurs'),
      onclick: () => monitor.openOverview((s) => openSession(s)),
    }, h('span', { class: `health ${monitor.summary().up < monitor.summary().total ? 'down' : 'up'}` }), tr(`${monitor.summary().up}/${monitor.summary().total} online`, `${monitor.summary().up}/${monitor.summary().total} en ligne`))] : []),
    h('span', { title: tr('Edition and licence: Settings › Licence', 'Édition et licence : Paramètres › Licence') }, EDITION_LABEL[(currentEdition())], ` · v${__APP_VERSION__}`),
  );
}

function toggleBroadcast() {
  if (!isSplit()) return;
  state.broadcast = !state.broadcast;
  renderAll();
  const focused = activeTab();
  if (focused) viewOf(focused)?.focus();
}

function renderViews() {
  const visible = visibleTabs();
  const split = visible.length > 1;
  views.className = `views${split ? ` split-${visible.length}` : ''}`;
  for (const t of state.tabs) {
    const index = visible.indexOf(t);
    t.view.hidden = index < 0;
    t.view.style.order = String(index);
    t.view.classList.toggle('focused', split && t.id === state.active);
    t.view.classList.toggle('tall', split && visible.length === 3 && index === 0);
    t.view.classList.toggle('receiving', split && state.broadcast && (t.receive || t.id === state.active));
    if (t.paneHead) renderPaneHead(t, split);
  }
  views.querySelector('.welcome')?.remove();
  if (!state.tabs.length) {
    views.append(h('div', { class: 'welcome' },
      h('h2', {}, tr('No open session', 'Aucune session ouverte')),
      h('p', { class: 'muted' }, tr('Choose a session on the left, create one, or connect directly to an address.', 'Choisissez une session à gauche, créez-en une, ou connectez-vous directement à une adresse.')),
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'btn primary', onclick: () => newSession() }, icon('plus', 14), tr('New session', 'Nouvelle session')),
        h('button', { class: 'btn', onclick: () => quickConnect() }, icon('link', 14), tr('Quick connect', 'Connexion rapide')))));
  }
}

/** En-tête d'un volet de l'écran partagé. */
function renderPaneHead(t: Tab, split: boolean) {
  const head = t.paneHead!;
  head.hidden = !split;
  if (!split) return;
  head.replaceChildren(h('div', { class: 'pane-head-inner' },
    h('span', { class: `dot ${t.state === 'connected' ? 'on' : t.state === 'closed' ? '' : 'wait'}` }),
    h('span', { class: 'grow ellipsis' }, t.title),
    t.protocol && badge(t.protocol),
    state.broadcast && h('label', { class: 'pane-receive', title: tr('This session receives multi-input', 'Cette session reçoit la saisie multiple') },
      h('input', { type: 'checkbox', checked: t.receive || t.id === state.active, disabled: t.id === state.active, onchange: (e: Event) => { t.receive = (e.target as HTMLInputElement).checked; renderViews(); } }),
      tr('receives', 'reçoit')),
    h('button', { class: 'icon-btn sm', 'aria-label': tr(`Remove ${t.title} from split screen`, `Retirer ${t.title} de l'écran partagé`), title: tr('Remove from split screen', 'Retirer de l\'écran partagé'), onclick: () => removeFromSplit(t.id) }, icon('close', 12))));
}

function renderAll() {
  renderShells();
  renderTree();
  renderTabs();
  renderToolbar();
  renderSidePanel();
  renderStatus();
  renderViews();
}

function activate(id: string) {
  state.active = id;
  renderAll();
  const tab = activeTab();
  requestAnimationFrame(() => {
    for (const t of visibleTabs()) viewOf(t)?.refit();
    if (tab) viewOf(tab)?.focus();
  });
}

function closeTab(id: string) {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  const [tab] = state.tabs.splice(index, 1);
  viewOf(tab)?.dispose();
  tab.notes?.flush();
  tab.server?.dispose();
  tab.containers?.dispose();
  tab.player?.dispose();
  tab.auditPlayer?.dispose();
  tab.netTools?.dispose();
  tab.multi?.dispose();
  tab.pveMonitor?.dispose();
  tab.view.remove();
  const wasSplit = state.split.includes(id);
  state.split = state.split.filter((s) => s !== id);
  if (state.split.length < 2) { state.split = []; state.broadcast = false; }
  if (state.active === id) {
    state.active = (wasSplit && state.split[0]) || state.tabs[Math.min(index, state.tabs.length - 1)]?.id || null;
  }
  if (state.active) activate(state.active);
  else renderAll();
}

// ---------- Sessions ----------

/** Session éphémère d'une connexion rapide (jamais enregistrée telle quelle). */
const quickSession = (t: QuickTarget): Session => ({ id: '', name: t.name, folder: '', protocol: t.protocol, values: t.values, tags: [], secretKeys: [] });

/** Connexion rapide : un onglet sans session enregistrée (valeurs par défaut de l'extension complétées). */
function openQuick(target: QuickTarget) {
  const defaults = Object.fromEntries((protocolOf(target.protocol)?.fields ?? []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
  const full = { ...target, values: { ...defaults, ...target.values } };
  return openSession(quickSession(full), full);
}

/** Fenêtre « Connexion rapide » : adresse, identifiant et mot de passe saisis à la main. */
async function quickConnect(initial = '') {
  const r = await openQuickConnect(extensionEnabled, initial);
  if (!r) return;
  // Bureau à distance : pas de terminal pour taper les identifiants, on les demande ici.
  const v = r.target.values;
  if (r.target.protocol === 'rdp' && (!v.username || !v.password)) {
    const cred = await askCredentials(r.target, tr('Windows credentials for the server (local account or DOMAIN\\user).', 'Identifiants Windows du serveur (compte local ou DOMAINE\\utilisateur).'));
    if (!cred) return;
    Object.assign(v, { username: cred.username, password: cred.password });
    r.target.name = `${cred.username}@${r.target.name.replace(/^[^@]*@/, '')}`;
  }
  rememberQuick(r.text);
  await openQuick(r.target);
}

/** Propose d'enregistrer une connexion rapide comme session (formulaire prérempli). */
async function saveQuick(target: QuickTarget) {
  const result = await openSessionDialog({
    protocols: dialogProtocols(target.protocol), folders: folders(), title: tr('Save as a session', 'Enregistrer comme session'),
    // Le mot de passe saisi pour la connexion rapide n'est pas repris.
    existing: quickSession({ ...target, values: { ...withoutPassword(target.values) } }),
  });
  if (!result) return;
  await reload();
  toast(tr(`Session « ${result.session.name} » saved`, `Session « ${result.session.name} » enregistrée`));
  if (result.connect) await openSession(result.session);
}

/** Session SSH enregistrée sans utilisateur, ou sans mot de passe enregistré : saisie dans le terminal. */
function needsTyping(session: Session): boolean {
  const v = session.values;
  if (session.protocol !== 'ssh' || (typeof v.credential === 'string' && v.credential.trim())) return false;
  return !String(v.username ?? '').trim() || (v.auth === 'password' && !session.secretKeys.includes('password'));
}

/**
 * Connexion SSH avec saisie dans le terminal, comme PuTTY : « login as: » si l'identifiant
 * manque, puis le mot de passe (masqué) si la clé et l'agent sont refusés. Rien n'est enregistré :
 * les réponses restent dans `typed` pour les reconnexions de cet onglet.
 */
async function sshLogin(tab: Tab, session: Session, typed: Record<string, unknown>, connect: () => Promise<ConnectResponse>, onUser: (user: string) => void): Promise<ConnectResponse> {
  const term = tab.term!;
  const v = { ...session.values, ...typed };
  const host = `${v.host}${v.port && Number(v.port) !== 22 ? `:${v.port}` : ''}`;
  const cancelled = () => new Error(tr('Connection cancelled.', 'Connexion annulée.'));
  if (!String(v.username ?? '').trim()) {
    const user = (await term.ask('login as: '))?.trim();
    if (!user) throw cancelled();
    typed.username = user;
    onUser(user);
  }
  const askPassword = async () => {
    const pw = await term.ask(`${typed.username ?? v.username}@${host}'s password: `, true);
    if (pw === null) throw cancelled();
    Object.assign(typed, { password: pw, auth: 'password' });
  };
  // Authentification par mot de passe sans mot de passe enregistré : demandé tout de suite.
  if (v.auth === 'password' && !session.secretKeys.includes('password') && typed.password === undefined) await askPassword();
  for (let attempt = 0; ; attempt++) {
    try {
      return await connect();
    } catch (e) {
      const reason = errorText(e);
      if (!authRefused(reason) || reason.includes(tr('Jump server', 'Serveur de rebond')) || attempt >= 4) throw e;
      // Laisse s'afficher les messages en route (« Nouveau serveur mémorisé… ») avant la question.
      await new Promise((r) => setTimeout(r, 80));
      if (typed.password !== undefined) term.write(tr('\x1b[31mAccess denied.\x1b[0m\r\n', '\x1b[31mAccès refusé.\x1b[0m\r\n'));
      await askPassword();
    }
  }
}

/** Session SSH ouverte en fichiers seulement (SFTP, deux volets), avec ses réglages : clé, rebond, Gate. */
function openSessionFiles(s: Session) {
  const files: Session = { ...s, protocol: 'sftp', name: tr(`${s.name} · files`, `${s.name} · fichiers`) };
  openSession(files, undefined, {
    connect: (typed, cols, rows, onEvent) => connectWith(s.id, typed, files.name, cols, rows, onEvent, 'sftp'),
    typing: false,
  });
}

const authRefused = (reason: string) => /Authentication refused|Authentification refusée/.test(reason);

/**
 * SFTP : pas de terminal, l'identifiant et le mot de passe manquants sont demandés dans une fenêtre,
 * avant la connexion s'ils ne sont pas enregistrés, puis après un refus. Rien n'est enregistré.
 */
async function filesLogin(session: Session, typed: Record<string, unknown>, connect: () => Promise<ConnectResponse>): Promise<ConnectResponse> {
  const v = { ...session.values, ...typed };
  const shared = typeof v.credential === 'string' && v.credential.trim();
  const ask = async (reason: string) => {
    const values = { ...session.values, ...typed };
    const cred = await askCredentials({ protocol: session.protocol, name: session.name, values }, reason, values.auth !== 'password');
    if (!cred) throw new Error(tr('Connection cancelled.', 'Connexion annulée.'));
    typed.username = cred.username;
    if (cred.password) Object.assign(typed, { password: cred.password, auth: 'password' });
  };
  if (!shared && typed.username === undefined && (!String(v.username ?? '').trim() || (v.auth === 'password' && !session.secretKeys.includes('password')))) {
    await ask(tr('Login and password for this server (not saved).', 'Identifiant et mot de passe de ce serveur (non enregistrés).'));
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await connect();
    } catch (e) {
      const reason = errorText(e);
      if (shared || !authRefused(reason) || reason.includes(tr('Jump server', 'Serveur de rebond')) || attempt >= 4) throw e;
      await ask(reason);
    }
  }
}

/** Ouverture fournie par une extension (Gate) : connexion et saisie éventuelle dans le terminal. */
interface CustomOpen {
  connect: (typed: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => Promise<ConnectResponse>;
  typing: boolean;
  /** Ajouts à l'onglet (assistance : bandeau et discussion), avant la connexion. */
  decorate?: (view: HTMLElement, screen: HTMLElement) => void;
}

async function openSession(session: Session, quick?: QuickTarget, custom?: CustomOpen) {
  if (session.id && !quick && !custom) markRecent(session.id);
  const proto = protocolOf(session.protocol);
  if (!proto) return toast(tr(`Extension « ${session.protocol} » not installed`, `Extension « ${session.protocol} » non installée`), 'error');
  if (!extensionEnabled(proto.id)) {
    if (!extensionInstalled(proto.id)) {
      if (!confirm(tr(`The extension « ${proto.name} » is in the catalogue. Install it and open « ${session.name} »?`, `L'extension « ${proto.name} » est dans le catalogue. L'installer et ouvrir « ${session.name} » ?`))) return;
      installExtension(proto.id, true);
    } else {
      if (!confirm(tr(`The extension « ${proto.name} » is disabled. Enable it and open « ${session.name} »?`, `L'extension « ${proto.name} » est désactivée. L'activer et ouvrir « ${session.name} » ?`))) return;
      setExtension(proto.id, true);
    }
  }
  // SSH : identifiant et mot de passe manquants saisis dans le terminal (connexion rapide,
  // ou session enregistrée sans eux). `typed` garde les réponses pour les reconnexions.
  const typed: Record<string, unknown> = quick ? quick.values : {};
  const connectOnce = (cols: number, rows: number, onEvent: (e: TermEvent) => void) => custom
    ? custom.connect(typed, cols, rows, onEvent)
    : quick
    ? connectQuick(quick.protocol, quick.name, quick.values, cols, rows, onEvent)
    : Object.keys(typed).length ? connectWith(session.id, typed, session.name, cols, rows, onEvent)
    : api.connect(session.id, cols, rows, onEvent);
  const typing = custom ? custom.typing : session.protocol === 'ssh' && (quick ? true : needsTyping(session));
  const opener = session.protocol === 'sftp'
    ? (cols: number, rows: number, onEvent: (e: TermEvent) => void) => filesLogin(session, typed, () => connectOnce(cols, rows, onEvent))
    : !typing ? connectOnce : (cols: number, rows: number, onEvent: (e: TermEvent) => void) =>
    sshLogin(tab, session, typed, () => connectOnce(cols, rows, onEvent), (user) => {
      if (!quick) return;
      quick.name = `${user}@${quick.values.host}${quick.values.port ? `:${quick.values.port}` : ''}${quick.values.jump ? ` via ${quick.values.jump}` : ''}`;
      tab.title = quick.name;
      renderTabs();
    });

  // Bureau à distance (client Windows) et web s'ouvrent dans leur propre fenêtre.
  if (proto.view === 'desktop' || proto.view === 'web') {
    try {
      const res = await opener(80, 24, () => {});
      toast(res.message ?? tr(`${session.name} opened`, `${session.name} ouvert`));
    } catch (e) {
      toast(errorText(e), 'error');
    }
    return;
  }

  const existing = !quick && !custom && state.tabs.find((t) => t.sessionId === session.id && !t.remoteCommand);
  if (existing) return activate(existing.id);

  const termEl = h('div', { class: 'term-view' });
  const paneHead = h('div', { class: 'pane-head', hidden: true });
  const view = h('div', { class: 'pane' }, paneHead, termEl);
  views.append(view);
  custom?.decorate?.(view, termEl);
  const tab: Tab = {
    id: crypto.randomUUID(), kind: 'session', title: session.name, sessionId: quick || custom ? undefined : session.id, protocol: session.protocol,
    quick, view, paneHead, state: 'connecting', receive: true,
  };
  // Cliquer dans un volet de l'écran partagé le rend actif.
  view.addEventListener('pointerdown', (e) => {
    if (state.active !== tab.id && !(e.target as HTMLElement).closest('.pane-head')) activate(tab.id);
  }, true);
  const filesLabel = session.protocol === 'ftp' ? (session.values.security === 'none' ? 'FTP' : 'FTPS') : session.protocol === 's3' ? 'S3' : 'SFTP';
  // Session « fichiers seulement » : deux volets (Ce PC, le serveur) et une file de transferts.
  const dual = proto.view === 'files'
    ? new DualFiles(toast, filesLabel, { remote: String(session.values.remoteDir ?? ''), local: String(session.values.localDir ?? '') })
    : undefined;
  if (proto.fileBrowser) tab.files = dual?.remote ?? new FilePanel(toast, filesLabel);
  const onState = (s: TermState, reason?: string) => {
    tab.state = s;
    if (s === 'closed' && reason && tab.id !== state.active) toast(`${session.name} : ${reason}`, 'error');
    // Connexion rapide FTP refusée : identifiants demandés dans une fenêtre (pas de terminal), puis nouvel essai.
    // (En SSH, ils sont saisis dans le terminal : voir sshLogin.)
    if (s === 'closed' && quick?.protocol === 'ftp' && reason && /Identifiants refusés/.test(reason)) {
      askCredentials(quick, reason).then((cred) => {
        if (!cred || !state.tabs.includes(tab)) return;
        Object.assign(quick.values, { username: cred.username, password: cred.password });
        reconnect(tab);
      });
    }
    const id = viewOf(tab)?.connection;
    if (s === 'connected' && id) tab.files?.attach(id);
    if (s === 'closed') { tab.files?.detach(); tab.recording = undefined; }
    if (s === 'connected' && tab.term && settings().autoRecord && allows('sessionRecording')) startRecording(tab);
    renderAll();
  };
  state.tabs.push(tab);
  if (proto.view === 'files' && tab.files) {
    tab.filesView = new FilesView(termEl, tab.files, onState, dual);
    activate(tab.id);
    await tab.filesView.connectWith(opener, session.name);
    return;
  }
  if (proto.view === 'screen') {
    tab.screen = new (await import('./screen')).ScreenView(termEl, onState);
    tab.screen.onDetached = (message) => { toast(message); closeTab(tab.id); };
    tab.screen.onFiles = () => { if (state.active === tab.id) renderToolbar(); };
    tab.screen.notify = toast;
    activate(tab.id);
    await tab.screen.connectWith(opener, session.name);
    return;
  }
  tab.term = new (await import('./terminal')).TerminalView(termEl, onState);
  activate(tab.id);
  tab.term.inputHook = (data) => broadcastFrom(tab, data);
  await tab.term.connectWith(opener, session.name);
}

// ---------- Enregistrement des sessions ----------

async function startRecording(tab: Tab) {
  const id = tab.term?.connection;
  if (!id || !tab.term) return;
  try {
    tab.recording = await recordings.start(id, stamp(), tab.title, tab.term.term.cols, tab.term.term.rows, settings().recordingDir || null);
    renderToolbar();
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

async function stopRecording(tab: Tab) {
  const id = tab.term?.connection;
  if (!id) return;
  try {
    const path = await recordings.stop(id);
    tab.recording = undefined;
    renderToolbar();
    if (path) toast(tr(`Recording saved: ${path}`, `Enregistrement sauvegardé : ${path}`));
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

/** Ouvre un enregistrement dans un onglet de lecture. */
async function openReplay(title: string, cast: string) {
  const { Player } = await import('./player');
  const view = h('div', { class: 'pane' });
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'replay', title: `▶ ${title}`, view, state: 'connected', receive: false };
  try {
    tab.player = new Player(view, cast);
  } catch (e) {
    view.remove();
    return toast(`Enregistrement illisible : ${errorText(e)}`, 'error');
  }
  state.tabs.push(tab);
  activate(tab.id);
}

function reconnect(tab: Tab) {
  viewOf(tab)?.reconnectNow();
}

async function reload() {
  try {
    [state.protocols, state.sessions, state.folders, state.snippets, state.folderColors] = await Promise.all([api.listProtocols(), api.listSessions(), api.listFolders(), api.listSnippets(), folderColors.list()]);
    state.noteIds = new Set(await notes.list().catch(() => [] as string[]));
  } catch (e) {
    toast(errorText(e), 'error');
  }
  for (const t of state.tabs) {
    const s = sessionOf(t.sessionId);
    if (s) t.title = s.name;
  }
  renderAll();
}

/** Protocoles du formulaire : ceux activés, plus celui de la session modifiée. */
const dialogProtocols = (current: string) => state.protocols.filter((p) => extensionEnabled(p.id) || p.id === current);

async function newSession(folder = '') {
  const result = await openSessionDialog({ protocols: enabledProtocols(), folders: folders(), defaultFolder: folder });
  await afterDialog(result);
}

async function editSession(session: Session) {
  const result = await openSessionDialog({ protocols: dialogProtocols(session.protocol), folders: folders(), existing: session });
  await afterDialog(result);
}

async function afterDialog(result: Awaited<ReturnType<typeof openSessionDialog>>) {
  if (!result) return;
  await reload();
  if (result.connect) await openSession(result.session);
}

async function removeSession(session: Session) {
  if (!confirm(tr(`Delete the session « ${session.name} »? Its saved passwords will also be erased.`, `Supprimer la session « ${session.name} » ? Ses mots de passe enregistrés seront aussi effacés.`))) return;
  try {
    for (const t of state.tabs.filter((t) => t.sessionId === session.id)) closeTab(t.id);
    await api.deleteSession(session.id);
    await reload();
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

function extensionsPage(): HTMLElement {
  const usage: Record<string, number> = {};
  for (const s of state.sessions) usage[s.protocol] = (usage[s.protocol] ?? 0) + 1;
  usage.gate = gatePanel.list.length;
  usage.proxmox = proxmoxPanel.list.length;
  const nameOf = (id: string) => protocolOf(id)?.name ?? (id === 'gate' ? GATE_EXTENSION.name : id === 'proxmox' ? PROXMOX_EXTENSION.name : id === 'assistance' ? ASSIST_EXTENSION.name : id);
  return renderExtensions([...state.protocols, GATE_EXTENSION, PROXMOX_EXTENSION, ASSIST_EXTENSION], usage, {
    installed: extensionInstalled,
    enabled: extensionEnabled,
    setEnabled: (id, on) => {
      setExtension(id, on);
      toast(tr(`Extension « ${nameOf(id)} » ${on ? 'enabled' : 'disabled'}`, `Extension « ${nameOf(id)} » ${on ? 'activée' : 'désactivée'}`));
    },
    install: (id, on) => {
      installExtension(id, on);
      toast(on ? tr(`Extension « ${nameOf(id)} » installed`, `Extension « ${nameOf(id)} » installée`) : tr(`Extension « ${nameOf(id)} » removed`, `Extension « ${nameOf(id)} » retirée`));
    },
  });
}

function openExtensions() {
  const existing = state.tabs.find((t) => t.kind === 'extensions');
  if (existing) {
    existing.view.replaceChildren(extensionsPage());
    return activate(existing.id);
  }
  const view = h('div', { class: 'page-view' }, extensionsPage());
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'extensions', title: 'Extensions', view, state: 'connected', receive: false };
  state.tabs.push(tab);
  activate(tab.id);
}

// ---------- Démarrage ----------

$('new-folder').append(icon('folderPlus'));
$('new-folder').addEventListener('click', () => promptNewFolder(''));
$('new-session').append(icon('plus'));
$('new-session').addEventListener('click', () => newSession());
$('quick-connect').append(icon('link'));
$('quick-connect').addEventListener('click', () => quickConnect());
/** Bouton du rail : icône seule, nom en infobulle. */
function railButton(id: string, ico: string, label: string, run: () => void) {
  const b = $(id);
  b.append(icon(ico, 20));
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', run);
}
railButton('rail-sessions', 'server', keys(tr('Sessions (Ctrl Shift K)', 'Sessions (Ctrl Maj K)')), () => showPane('sessions', true));
railButton('rail-gates', 'shield', 'Gates', () => showPane('gates', true));
railButton('rail-proxmox', 'layers', 'Proxmox', () => showPane('proxmox', true));
railButton('rail-pc', 'prompt', tr('This PC: local shells', 'Ce PC : shells locaux'), () => showPane('pc', true));
railButton('open-snippets', 'commands', tr('Saved commands', 'Commandes enregistrées'), () => openSnippetManager(snippetContext()));
railButton('open-credentials', 'user', tr('Shared credentials', 'Identifiants partagés'), () => openCredentialManager(toast, () => reload()));
railButton('open-recordings', 'play', tr('Recordings', 'Enregistrements'), () => openRecordings(toast));
railButton('open-assist', 'lifebuoy', tr('Remote assistance', 'Assistance à distance'), () => openAssistDialog({ open: openAssist, toast }));
railButton('open-nettools', 'broadcast', tr('Network tools', 'Outils réseau'), () => openNetTools());
railButton('open-import', 'upload', tr('Import / export', 'Importer / exporter'), () => openImportExport((msg) => { toast(msg); reload(); }, toast));
railButton('open-extensions', 'puzzle', 'Extensions', openExtensions);
railButton('open-settings', 'settings', tr('Settings', 'Paramètres'), () => openSettingsDialog(toast));
$('title-sessions').textContent = tr('Sessions', 'Sessions');
$('open-library').replaceChildren(icon('files', 14), h('span', { class: 'grow' }, tr('All sessions in a table', 'Toutes les sessions en tableau')), icon('chevronRight', 12));
$('open-library').addEventListener('click', () => openLibrary());
$('title-pc').textContent = tr('This PC', 'Ce PC');
setPlayerHandler(openReplay);
showAssist();
search.addEventListener('input', () => { state.filter = search.value; renderTree(); });

// Glisser-déposer depuis le Finder ou l'Explorateur sur le panneau Fichiers (chemins fournis par Tauri) = envoi au serveur.
function overFiles(pos: { x: number; y: number }) {
  if (details.hidden) return false;
  const r = details.getBoundingClientRect();
  const x = pos.x / devicePixelRatio;
  const y = pos.y / devicePixelRatio;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
getCurrentWebview().onDragDropEvent(({ payload }) => {
  // Assistance : fichiers ou dossiers déposés sur l'écran = proposés à la personne aidée.
  const view = activeTab()?.view;
  const assistPanel = view ? assistPanels.get(view) : undefined;
  if (assistPanel?.acceptsFiles()) {
    if (payload.type === 'drop') return assistPanel.offer(payload.paths);
    return assistPanel.setDropping(payload.type !== 'leave');
  }
  const files = activeTab()?.files;
  // Bureau à distance : fichiers déposés sur l'écran = mis au presse-papiers de la session.
  const screen = activeTab()?.screen;
  if (!files && screen?.filesAllowed && payload.type === 'drop') return screen.sendFiles(payload.paths);
  if (!files) return;
  if (payload.type === 'leave') return files.setDropping(false);
  // Deux volets : seul le volet du serveur reçoit les fichiers déposés.
  const fv = activeTab()?.filesView;
  const inside = fv ? (fv.dual?.acceptsDrop(payload.position.x / devicePixelRatio, payload.position.y / devicePixelRatio) ?? true) : overFiles(payload.position);
  files.setDropping(payload.type !== 'drop' && inside);
  if (payload.type === 'drop' && inside) files.uploadPaths(payload.paths);
});

// Windows : Ctrl+Maj+lettre. Mac : ⌘+Maj+lettre (sauf Q : la connexion rapide y est ⌘K, via le menu natif).
document.addEventListener('keydown', (e) => {
  const action = appShortcut(e);
  if (!action || document.querySelector('dialog[open]') || isLocked()) return;
  if (action === 'search-sessions') { e.preventDefault(); focusSessionSearch(); }
  else if (action === 'new-session') { e.preventDefault(); newSession(); }
  else if (action === 'quick-connect') { e.preventDefault(); quickConnect(); }
  else if (action === 'local-shell') { e.preventDefault(); const def = defaultShell(); if (def) openLocalShell(def); else toast(tr('No local shell found', 'Aucun shell local trouvé'), 'error'); }
  else if (action === 'close-tab' && state.active) { e.preventDefault(); closeTab(state.active); }
  else if (action === 'find') { e.preventDefault(); activeTab()?.term?.openSearch(); }
  else if (action === 'broadcast') { e.preventDefault(); toggleBroadcast(); }
  else if (action === 'commands') { e.preventDefault(); openPalette(snippetContext()); }
  else if (action === 'lock') { e.preventDefault(); lockNow(toast, () => reload()); }
  else if (action === 'palette') { e.preventDefault(); openGlobalPalette(); }
});

function focusSessionSearch() {
  document.querySelector('.app')?.classList.remove('folded');
  showPane('sessions');
  search.focus();
  search.select();
}

// Menu natif macOS : chaque élément personnalisé émet `menu://<id>` (voir src-tauri/src/appmenu.rs).
// Mêmes gardes que les raccourcis : rien sous une boîte de dialogue ouverte ou quand l'application est verrouillée.
if (IS_MAC) {
  const guarded = (fn: () => void) => () => { runUnlessBusy(document, isLocked, fn); };
  void listen('menu://new-session', guarded(() => newSession()));
  void listen('menu://quick-connect', guarded(() => quickConnect()));
  void listen('menu://settings', guarded(() => openSettingsDialog(toast)));
  void listen('menu://close-tab', guarded(() => { if (state.active) closeTab(state.active); }));
  void listen('menu://find', guarded(() => activeTab()?.term?.openSearch()));
  // Infobulles de index.html (écrites en « Ctrl Maj X ») : forme ⌘.
  localizeShortcutTitles(document);
}

initTheme();
reload();
// Vérification discrète des mises à jour, une fois l'application chargée.
if (settings().autoUpdate) setTimeout(() => checkForUpdates(toast, true), 4000);
loadLicense().then(() => {
  renderStatus();
  if (extensionEnabled('proxmox')) proxmoxPanel.load();
});
// Shells locaux : détection, section « Ce PC », ouverture au démarrage si demandé.
loadShells().then(() => {
  renderShells();
  const def = defaultShell();
  if (settings().localShells.atStartup && def) openLocalShell(def);
});
onSettingsChange(() => renderShells());
// Extension activée ou désactivée : menus, arborescence et page Extensions.
let extensionsKey = `${settings().disabledExtensions.join(',')}|${settings().installedExtensions.join(',')}`;
onSettingsChange((s) => {
  const key = `${s.disabledExtensions.join(',')}|${s.installedExtensions.join(',')}`;
  if (key === extensionsKey) return;
  extensionsKey = key;
  gatePanel.show(extensionEnabled('gate')); proxmoxPanel.show(extensionEnabled('proxmox')); syncRail();
  showAssist();
  state.tabs.find((t) => t.kind === 'extensions')?.view.replaceChildren(extensionsPage());
  renderAll();
});
monitor.start();
// Première vérification une fois les sessions chargées.
setTimeout(() => monitor.check(), 2000);
// Supervision relancée quand ses réglages changent.
let monitorKey = '';
onSettingsChange((s) => {
  const key = `${s.monitoring}|${s.monitorInterval}`;
  if (key !== monitorKey) { monitorKey = key; monitor.start(); renderAll(); }
});
monitorKey = `${settings().monitoring}|${settings().monitorInterval}`;
initLock(() => { reload(); gatePanel.show(extensionEnabled('gate')); proxmoxPanel.show(extensionEnabled('proxmox')); syncRail(); });
gatePanel.show(extensionEnabled('gate')); proxmoxPanel.show(extensionEnabled('proxmox')); syncRail();

/** Nom du dossier coloré le plus proche (affiché en étiquette dans la barre d'outils). */
function envFolder(folder: string): string {
  let path = folder;
  while (path) {
    if (state.folderColors[path] && FOLDER_COLORS[state.folderColors[path]]) return path.slice(path.lastIndexOf('/') + 1);
    path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  }
  return '';
}

// ---------- Shells locaux ----------

/** Onglet avec un terminal (session ou shell local) : écran partagé, saisie multiple… */
function isTerminalTab(t: Tab): boolean {
  return t.kind === 'session' || t.kind === 'local';
}

/** Ouvre un shell de ce PC dans un nouvel onglet. */
async function openLocalShell(shell: ShellSpec) {
  const termEl = h('div', { class: 'term-view' });
  const paneHead = h('div', { class: 'pane-head', hidden: true });
  const view = h('div', { class: 'pane' }, paneHead, termEl);
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'local', title: shell.name, protocol: 'local', shell, view, paneHead, state: 'connecting', receive: true };
  view.addEventListener('pointerdown', (e) => {
    if (state.active !== tab.id && !(e.target as HTMLElement).closest('.pane-head')) activate(tab.id);
  }, true);
  tab.term = new (await import('./terminal')).TerminalView(termEl, (s, reason) => {
    tab.state = s;
    if (s === 'closed') tab.recording = undefined;
    if (s === 'closed' && reason && tab.id !== state.active) toast(`${shell.name} : ${reason}`, 'error');
    renderAll();
  });
  // Un shell qui se termine ne se relance pas tout seul (Entrée le relance).
  tab.term.autoReconnect = false;
  state.tabs.push(tab);
  activate(tab.id);
  tab.term.inputHook = (data) => broadcastFrom(tab, data);
  await tab.term.connectWith((cols, rows, onEvent) => shells.connect(shell, cols, rows, onEvent), shell.name, tr('Opening', 'Ouverture de'));
}

function shellMenu(shell: ShellSpec, e: MouseEvent) {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    { label: tr('Open', 'Ouvrir'), icon: 'prompt', action: () => openLocalShell(shell) },
    ...(canElevate(shell) ? [{ label: tr('Open as administrator (separate window)', 'Ouvrir en administrateur (fenêtre séparée)'), icon: 'lock', action: () => shells.openElevated(shell).catch((err) => toast(errorText(err), 'error')) }] : []),
    { label: keys(tr('Default shell (Ctrl+Shift+T)', 'Shell par défaut (Ctrl+Maj+T)')), icon: 'check', action: () => setDefaultShell(shell.id) },
    'separator',
    { label: tr('Hide', 'Masquer'), icon: 'close', action: () => hideShell(shell.id) },
  ]);
}

/** Section « Ce PC » de la barre latérale. */
function renderShells() {
  const box = $('local-shells');
  const def = defaultShell();
  const list = visibleShells();
  box.replaceChildren(...(list.length ? list.map((s) => {
    const running = state.tabs.some((t) => t.kind === 'local' && t.shell?.id === s.id && t.state === 'connected');
    const btn = h('button', {
      class: 'tree-item shell-item', title: keys(tr(`${s.command} ${s.args.join(' ')}${def?.id === s.id ? '\nDefault shell (Ctrl+Shift+T)' : ''}`, `${s.command} ${s.args.join(' ')}${def?.id === s.id ? '\nShell par défaut (Ctrl+Maj+T)' : ''}`)),
      onclick: () => openLocalShell(s),
    }, shellIcon(s), h('span', { class: 'grow ellipsis' }, s.name), running && h('span', { class: 'dot on' }));
    btn.addEventListener('contextmenu', (e) => shellMenu(s, e));
    return btn;
  }) : shellsLoaded() ? [h('p', { class: 'muted small', style: 'margin: 0; padding: 4px 10px' }, tr('No shell found.', 'Aucun shell trouvé.'))] : []));
}

/** Bouton « + » des onglets : nouvelle session ou shell local. */
function openPlusMenu(e: MouseEvent) {
  const def = defaultShell();
  showMenu(e.clientX, e.clientY, [
    { label: tr('New session…', 'Nouvelle session…'), icon: 'plus', action: () => newSession() },
    'separator',
    ...visibleShells().map((s) => ({ label: s.id === def?.id ? `${s.name}  ${keys('(Ctrl+Maj+T)')}` : s.name, icon: s.icon === 'wsl' ? 'wsl' : s.icon === 'git' ? 'git' : 'prompt', action: () => openLocalShell(s) })),
    ...(def && canElevate(def) ? [{ label: `${def.name} en administrateur`, icon: 'lock', action: () => shells.openElevated(def).catch((err) => toast(errorText(err), 'error')) }] : []),
    'separator',
    { label: tr('Manage local shells…', 'Gérer les shells locaux…'), icon: 'settings', action: () => openSettingsDialog(toast) },
  ]);
}

/** Barre d'outils d'un shell local. */
function renderLocalToolbar(tab: Tab, shell: ShellSpec) {
  toolbar.hidden = false;
  paint(toolbar, undefined);
  const label = { connecting: 'ouverture…', connected: tr('ongoing', 'en cours'), reconnecting: 'ouverture…', closed: tr('ended', 'terminé') }[tab.state];
  toolbar.replaceChildren(
    h('div', { class: 'toolbar-info' },
      h('span', { class: 'env-label local' }, tr('THIS PC', 'CE PC')),
      h('strong', {}, shell.name),
      h('span', { class: 'muted ellipsis' }, tr(`· ${shell.cwd || 'home folder'}`, `· ${shell.cwd || 'dossier personnel'}`)),
      h('span', { class: 'muted' }, `· ${label}`)),
    toolbarActions([
      ...(tab.state === 'closed' ? [{ id: 'restart', icon: 'refresh', label: tr('Restart', 'Relancer'), action: () => tab.term?.reconnectNow(), cls: 'primary', fold: { label: 20 } }] : []),
      ...(tab.state === 'connected' ? [{
        id: 'record', lead: h('span', { class: 'rec-dot' }), label: tab.recording ? tr('Stop recording', 'Arrêter l’enregistrement') : tr('Record', 'Enregistrer'),
        action: () => (tab.recording ? stopRecording(tab) : startRecording(tab)), cls: tab.recording ? 'rec' : '', fold: { label: 5 },
      }] : []),
      { id: 'commands', icon: 'commands', label: tr('Commands', 'Commandes'), title: keys(tr('Saved commands (Ctrl Shift P)', 'Commandes enregistrées (Ctrl Maj P)')), action: () => openPalette(snippetContext()), fold: { label: 9 } },
      { id: 'search', icon: 'search', label: tr('Search in the terminal', 'Rechercher dans le terminal'), title: keys(tr('Search (Ctrl Shift F)', 'Rechercher (Ctrl Maj F)')), action: () => tab.term?.openSearch(), iconOnly: true },
      { id: 'split', icon: 'split', label: tr('Split screen', 'Écran partagé'), action: (e: MouseEvent) => splitMenu(e), cls: isSplit() ? 'on' : '', fold: { label: 4, menu: 10 } },
      ...(isSplit() ? [{ id: 'broadcast', icon: 'broadcast', label: state.broadcast ? tr('Multi-input: ON', 'Saisie multiple : ACTIVE') : tr('Multi-input', 'Saisie multiple'), action: () => toggleBroadcast(), cls: state.broadcast ? 'warn' : '', fold: { label: 6 } }] : []),
      { id: 'disconnect', icon: 'close', label: tr('Close', 'Fermer'), action: () => closeTab(tab.id), fold: { label: 11 } },
    ], [], '')
  );
  fitToolbar();
}

$('manage-shells').append(icon('settings', 14));
$('manage-shells').addEventListener('click', () => openSettingsDialog(toast));

// ---------- Palette globale et connexion rapide ----------

function paletteEntries(): PaletteEntry[] {
  const sessionEntries: PaletteEntry[] = state.sessions.map((s) => {
    const v = s.values;
    const target = [v.username && `${v.username}@`, v.host ?? v.url ?? v.port].filter(Boolean).join('');
    const proto = protocolOf(s.protocol);
    return {
      label: s.name, group: proto?.name ?? s.protocol, icon: proto ? viewIcon(proto.view) : 'terminal',
      hint: [extensionEnabled(s.protocol) ? '' : tr('extension disabled', 'extension désactivée'), s.folder, target].filter(Boolean).join(' · '), keywords: `${String(target)} ${s.tags.join(' ')} ${s.protocol}`,
      action: () => openSession(s),
    };
  });
  const shellEntries: PaletteEntry[] = visibleShells().map((s) => ({
    label: s.name, group: tr('Local shell', 'Shell local'), icon: s.icon === 'wsl' ? 'wsl' : s.icon === 'git' ? 'git' : 'prompt',
    hint: `${s.command} ${s.args.join(' ')}`, keywords: 'shell local terminal', action: () => openLocalShell(s),
  }));
  const actions: PaletteEntry[] = [
    { label: tr('New session', 'Nouvelle session'), group: 'Action', icon: 'plus', hint: keys(tr('Ctrl+Shift+N', 'Ctrl+Maj+N')), action: () => newSession() },
    { label: tr('All sessions in a table', 'Toutes les sessions en tableau'), group: 'Action', icon: 'files', keywords: tr('library list table sort select', 'bibliothèque liste tableau trier sélection'), action: () => openLibrary() },
    { label: tr('Quick connect', 'Connexion rapide'), group: 'Action', icon: 'link', hint: keys(tr('Ctrl+Shift+Q', 'Ctrl+Maj+Q')), keywords: tr('address server login password unsaved adresse serveur identifiant mot de passe sans enregistrer', 'adresse serveur identifiant mot de passe sans enregistrer'), action: () => quickConnect() },
    { label: tr('Saved commands', 'Commandes enregistrées'), group: 'Action', icon: 'commands', hint: keys(tr('Ctrl+Shift+P', 'Ctrl+Maj+P')), action: () => openSnippetManager(snippetContext()) },
    { label: tr('Recordings', 'Enregistrements'), group: 'Action', icon: 'play', action: () => openRecordings(toast) },
    { label: tr('Import / export', 'Importer / exporter'), group: 'Action', icon: 'upload', action: () => openImportExport((msg) => { toast(msg); reload(); }, toast) },
    { label: 'Extensions', group: 'Action', icon: 'puzzle', action: () => openExtensions() },
    { label: tr('Server monitoring', 'Supervision des serveurs'), group: 'Action', icon: 'refresh', action: () => monitor.openOverview((s) => openSession(s)) },
    { label: tr('SSH keys', 'Clés SSH'), group: 'Action', icon: 'lock', hint: tr('Create, copy, install', 'Créer, copier, installer'), keywords: 'ssh-keygen ed25519 rsa authorized_keys', action: () => { const t = activeTab(); const s = sessionOf(t?.sessionId) ?? (t?.quick && quickSession(t.quick)); if (t && s && s.protocol === 'ssh' && t.state === 'connected') openKeysFor(t, s); else openKeyManager({ toast }); } },
    { label: tr('Shared credentials', 'Identifiants partagés'), group: 'Action', icon: 'user', hint: tr('One account for several sessions', 'Un compte pour plusieurs sessions'), keywords: tr('password account login credentials mot de passe compte', 'mot de passe compte login credentials'), action: () => openCredentialManager(toast, () => reload()) },
    { label: tr('Command on several servers', 'Commande sur plusieurs serveurs'), group: 'Action', icon: 'commands', hint: 'Pro', keywords: tr('multi exec run all servers parallel ansible lancer tous serveurs parallèle', 'multi exec lancer tous serveurs parallèle ansible'), action: () => openMultiExec() },
    { label: tr('Network tools', 'Outils réseau'), group: 'Action', icon: 'broadcast', hint: 'Ping, traceroute, ports, DNS, Wake-on-LAN', keywords: 'ping tracert traceroute port scan dns nslookup wol wake', action: () => openNetTools() },
    { label: tr('Settings', 'Paramètres'), group: 'Action', icon: 'settings', action: () => openSettingsDialog(toast) },
    { label: tr('Lock Portunia', 'Verrouiller Portunia'), group: 'Action', icon: 'lock', hint: keys(tr('Ctrl+Shift+L', 'Ctrl+Maj+L')), action: () => lockNow(toast, () => reload()) },
  ];
  return [...sessionEntries, ...shellEntries, ...actions];
}

function openGlobalPalette(initial = '') {
  openCommandPalette(paletteEntries(), (target) => openQuick(target), initial, (address) => quickConnect(address));
}

// ↓ : parcourir la liste. Entrée : la première session trouvée, ou une connexion rapide
// (« user@hôte », « rdp srv-01 »…, et toute adresse qui ne correspond à aucune session).
search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); sessionTree.focusFirst(); return; }
  if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; state.filter = ''; renderTree(); return; }
  if (e.key !== 'Enter') return;
  const typed = search.value.trim();
  const firstId = sessionTree.first();
  if (firstId && (!/[@\s]|:\/\//.test(typed) || chip !== 'all')) {
    e.preventDefault();
    const s = sessionOf(firstId);
    if (s) openSession(s);
    return;
  }
  const target = parseQuick(search.value);
  if (!target) {
    // Adresse seule : fenêtre de connexion rapide (identifiant et mot de passe à la main).
    if (!looksLikeAddress(search.value)) return;
    e.preventDefault();
    const address = search.value;
    search.value = '';
    state.filter = '';
    renderTree();
    quickConnect(address);
    return;
  }
  e.preventDefault();
  rememberQuick(search.value);
  search.value = '';
  state.filter = '';
  renderTree();
  openQuick(target);
});

/** Valeurs d'une connexion rapide sans le mot de passe ; « auto » devient « clé ». */
function withoutPassword(values: Record<string, unknown>): Record<string, unknown> {
  const { password: _password, ...rest } = values;
  if (rest.auth === 'auto') rest.auth = 'key';
  return rest;
}

// ---------- Clés SSH ----------

/** Gestionnaire de clés ouvert depuis un onglet SSH : installation sur ce serveur. */
function openKeysFor(tab: Tab, session: Session) {
  const id = tab.term?.connection;
  if (!id) return;
  openKeyManager({
    toast, connectionId: id, serverLabel: session.name,
    // Session enregistrée : elle passe à l'authentification par clé.
    onUseKey: tab.quick ? undefined : async (key, passphrase) => {
      try {
        const fresh = sessionOf(session.id) ?? session;
        await api.saveSession({ ...fresh, values: { ...fresh.values, auth: 'key', keyPath: key.path } }, passphrase ? { passphrase } : {});
        await reload();
        toast(tr(`« ${session.name} » will use key ${key.name}`, `« ${session.name} » utilisera la clé ${key.name}`));
      } catch (e) {
        toast(errorText(e), 'error');
      }
    },
  });
}

// ---------- Outils réseau ----------

/** Onglet unique « Outils réseau », éventuellement visé sur une session. */
function openNetTools(host = '', session?: Session) {
  let tab = state.tabs.find((t) => t.kind === 'tools');
  if (!tab?.netTools) {
    const tools = createNetTools(() => state.sessions);
    const view = h('div', { class: 'page-view' }, tools.el);
    views.append(view);
    tab = { id: crypto.randomUUID(), kind: 'tools', title: tr('Network tools', 'Outils réseau'), view, state: 'connected', receive: false, netTools: tools };
    state.tabs.push(tab);
  }
  activate(tab.id);
  if (host) tab.netTools?.target(host, typeof session?.values.mac === 'string' ? session.values.mac : undefined, 'ping');
}

// ---------- Commande sur plusieurs serveurs (Pro) ----------

/** Session rangée dans un dossier rouge (production…) : confirmation renforcée. */
function isSensitive(s: Session): boolean {
  let path = s.folder;
  while (path) {
    if (state.folderColors[path]) return state.folderColors[path] === 'red';
    path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  }
  return false;
}

function openMultiExec(folder: string | null = null, ids?: string[]) {
  if (!allows('multiExec')) return toast(tr('Command on several servers is part of Portunia Pro (Settings › Licence)', 'La commande sur plusieurs serveurs fait partie de Portunia Pro (Paramètres › Licence)'), 'error');
  let tab = state.tabs.find((t) => t.kind === 'multi');
  if (!tab?.multi) {
    const multi = createMultiExec(() => state.sessions, () => state.snippets, isSensitive, toast);
    const view = h('div', { class: 'page-view' }, multi.el);
    views.append(view);
    tab = { id: crypto.randomUUID(), kind: 'multi', title: tr('Multi-command', 'Commande multiple'), view, state: 'connected', receive: false, multi };
    state.tabs.push(tab);
  }
  activate(tab.id);
  tab.multi?.select(folder, ids);
}

// ---------- Conteneurs (Pro) ----------

function toggleContainers(tab: Tab) {
  if (!allows('containers')) return toast(tr('Docker and Kubernetes containers are part of Portunia Pro (Settings › Licence)', 'Les conteneurs Docker et Kubernetes font partie de Portunia Pro (Paramètres › Licence)'), 'error');
  const id = tab.term?.connection;
  if (!id) return;
  if (!tab.containers || tab.containers.connectionId !== id) {
    tab.containers?.dispose();
    tab.containers = new ContainersPanel(id, tab.title, toast, (label, command) => openRemoteTerminal(tab, label, command));
  }
  showSide(tab, 'containers');
}

/** Nouvel onglet terminal sur le même serveur, qui lance une commande (shell d'un conteneur, journaux). */
async function openRemoteTerminal(parent: Tab, label: string, command: string) {
  const session = sessionOf(parent.sessionId);
  const quick = parent.quick;
  if (!session && !quick) return;
  const opener: Opener = quick
    ? (cols, rows, onEvent) => connectQuick(quick.protocol, label, { ...quick.values, remoteCommand: command }, cols, rows, onEvent)
    : (cols, rows, onEvent) => connectWith(session!.id, { remoteCommand: command }, label, cols, rows, onEvent);
  const termEl = h('div', { class: 'term-view' });
  const paneHead = h('div', { class: 'pane-head', hidden: true });
  const view = h('div', { class: 'pane' }, paneHead, termEl);
  views.append(view);
  const tab: Tab = {
    id: crypto.randomUUID(), kind: 'session', title: label, sessionId: parent.sessionId, protocol: 'ssh',
    remoteCommand: command, view, paneHead, state: 'connecting', receive: true,
  };
  view.addEventListener('pointerdown', (e) => {
    if (state.active !== tab.id && !(e.target as HTMLElement).closest('.pane-head')) activate(tab.id);
  }, true);
  tab.term = new (await import('./terminal')).TerminalView(termEl, (s, reason) => {
    tab.state = s;
    if (s === 'closed' && reason && tab.id !== state.active) toast(`${label} : ${reason}`, 'error');
    renderAll();
  });
  // Shell quitté ou journaux interrompus : pas de relance automatique (Entrée relance).
  tab.term.autoReconnect = false;
  state.tabs.push(tab);
  activate(tab.id);
  tab.term.inputHook = (data) => broadcastFrom(tab, data);
  await tab.term.connectWith(opener, label, tr('Opening', 'Ouverture de'));
}
