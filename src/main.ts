import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { api, Bastion, bastions, BastionServer, connectBastion, connectQuick, connectWith, ConnectResponse, errorText, Manifest, notes, Session, Snippet, TermEvent } from './api';
import { save } from '@tauri-apps/plugin-dialog';
import { BastionPanel, HEIMDIA_EXTENSION, renderBastionAdmin } from './bastion';
import { openKeyManager } from './keys';
import { NotesPanel } from './notes';
import { ServerPanel } from './dashboard';
import { ContainersPanel } from './containers';
import { FilesView } from './filesview';
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
import type { AuditPlayer, AuditRecording } from './auditplayer';
import type { AuditRow } from './audit';
import { folderColors, recordings, shells, ShellSpec } from './api';
import { defaultShell, hideShell, loadShells, setDefaultShell, shellIcon, shellsLoaded, visibleShells } from './localshells';
import { colorOf, FOLDER_COLORS, initTheme, paint } from './theme';
import { LOCALE, t as tr } from './i18n';

interface Tab {
  id: string;
  kind: 'session' | 'local' | 'extensions' | 'replay' | 'tools' | 'multi' | 'admin';
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
  /** Lecteur d'enregistrement (onglet « replay »). */
  player?: Player;
  /** Relecture d'une session de bastion (onglet « replay »). */
  auditPlayer?: AuditPlayer;
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
  side: 'files' as SidePanel,
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
/** Extension activée (Paramètres › Extensions). */
const extensionEnabled = (id: string) => !settings().disabledExtensions.includes(id);
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
  netTools: (s) => openNetTools(typeof s.values.host === 'string' ? s.values.host : '', s),
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

// ---------- Extension Heimdia (bastions) ----------

const bastionPanel = new BastionPanel($('bastions'), {
  toast,
  openServer: (b, s) => openBastionServer(b, s),
  sessions: () => state.sessions,
  removeSessions: async (ids) => {
    for (const id of ids) {
      for (const t of state.tabs.filter((t) => t.sessionId === id)) closeTab(t.id);
      await api.deleteSession(id).catch((e) => toast(errorText(e), 'error'));
    }
    await reload();
  },
  openAdmin: (b) => openBastionAdmin(b),
  openAudit: (b) => openBastionAudit(b),
  protocolEnabled: (id) => extensionEnabled(id),
  allowsAdmin: () => allows('bastionAdmin'),
  filter: () => state.filter,
});

/** Serveur d'un bastion : session SSH par le bastion, avec un jeton à usage unique par connexion. */
function openBastionServer(b: Bastion, s: BastionServer) {
  if (s.protocole === 'rdp') return openBastionDesktop(b, s);
  const rebond = s.mode === 'rebond';
  const session: Session = {
    id: '', name: `${s.nom} · ${b.name}`, folder: '', protocol: 'ssh', tags: [], secretKeys: [],
    // Rebond : authentification de bout en bout, identifiants demandés dans le terminal au besoin.
    values: rebond ? { host: s.hote, port: s.port, username: s.compte ?? '', auth: 'auto' } : { host: b.host, port: b.sshPort, username: `${b.login}%${s.nom}`, auth: 'key' },
  };
  const connect = async (typed: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => {
    try {
      return await connectBastion(b.id, s.nom, typed, cols, rows, onEvent);
    } catch (e) {
      if (errorText(e) !== 'SESSION_EXPIREE') throw e;
      if (await bastionPanel.reconnect(b.id)) return connectBastion(b.id, s.nom, typed, cols, rows, onEvent);
      throw new Error(tr('Bastion session expired: sign in again (Bastions section).', 'Session du bastion expirée : reconnectez-vous (section Bastions).'));
    }
  };
  return openSession(session, undefined, { connect, typing: rebond });
}

/**
 * Serveur Bureau à distance d'un bastion (mode rebond) : onglet RDP habituel, à travers un
 * tunnel par le bastion. Le serveur Windows authentifie lui-même : identifiants demandés à
 * chaque ouverture, jamais enregistrés.
 */
async function openBastionDesktop(b: Bastion, s: BastionServer) {
  const cred = await askCredentials(
    { protocol: 'rdp', name: s.nom, values: { host: s.nom, username: s.compte ?? '' } } as QuickTarget,
    s.mode === 'enregistre'
      ? tr(`Windows credentials for ${s.nom} (local account or DOMAIN\\user). The bastion relays and records the session; it does not see your password.`, `Identifiants Windows de ${s.nom} (compte local ou DOMAINE\\utilisateur). Le bastion relaie et enregistre la session ; il ne voit pas votre mot de passe.`)
      : tr(`Windows credentials for ${s.nom} (local account or DOMAIN\\user). The bastion relays the encrypted connection without reading it.`, `Identifiants Windows de ${s.nom} (compte local ou DOMAINE\\utilisateur). Le bastion relaie la connexion chiffrée sans la lire.`),
  );
  if (!cred) return;
  const session: Session = {
    id: '', name: `${s.nom} · ${b.name}`, folder: '', protocol: 'rdp', tags: [], secretKeys: [],
    values: { host: s.hote, port: s.port, username: cred.username, client: 'tab' },
  };
  const typed = { username: cred.username, password: cred.password };
  const connect = async (_t: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => {
    try {
      return await connectBastion(b.id, s.nom, typed, cols, rows, onEvent);
    } catch (e) {
      if (errorText(e) !== 'SESSION_EXPIREE') throw e;
      if (await bastionPanel.reconnect(b.id)) return connectBastion(b.id, s.nom, typed, cols, rows, onEvent);
      throw new Error(tr('Bastion session expired: sign in again (Bastions section).', 'Session du bastion expirée : reconnectez-vous (section Bastions).'));
    }
  };
  return openSession(session, undefined, { connect, typing: false });
}

function openBastionAdmin(b: Bastion) {
  if (!allows('bastionAdmin')) return toast(tr('Bastion administration is part of Portunia Teams (Settings › Licence)', 'L’administration des bastions fait partie de Portunia Équipes (Paramètres › Licence)'), 'error');
  const title = `Admin · ${b.name}`;
  const existing = state.tabs.find((t) => t.kind === 'admin' && t.title === title);
  if (existing) return activate(existing.id);
  const view = h('div', { class: 'page-view' }, renderBastionAdmin(b, bastionPanel.host));
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'admin', title, view, state: 'connected', receive: false };
  state.tabs.push(tab);
  activate(tab.id);
}

/** Audit du bastion (sessions et journal), chargé à la demande. */
async function openBastionAudit(b: Bastion) {
  if (!allows('bastionAdmin')) return toast(tr('Bastion audit is part of Portunia Teams (Settings › Licence)', 'L’audit des bastions fait partie de Portunia Équipes (Paramètres › Licence)'), 'error');
  const title = `Audit · ${b.name}`;
  const existing = state.tabs.find((t) => t.kind === 'admin' && t.title === title);
  if (existing) return activate(existing.id);
  const { renderBastionAudit } = await import('./audit');
  const view = h('div', { class: 'page-view' }, renderBastionAudit(b, { toast, openRecording: (bb, s, start) => openAuditReplay(bb, s, start) }));
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'admin', title, view, state: 'connected', receive: false };
  state.tabs.push(tab);
  activate(tab.id);
}

/** Relecture d'une session du bastion dans un onglet. `reveal` : saisies masquées en clair (administrateur). */
async function openAuditReplay(b: Bastion, s: AuditRow, start?: number, reveal = false, replace?: Tab) {
  const title = `▶ ${s.serveur} · ${new Date(s.debut).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })}`;
  const existing = !replace && start == null && state.tabs.find((t) => t.kind === 'replay' && t.title === title);
  if (existing) return activate(existing.id);
  let rec: AuditRecording;
  try {
    rec = await bastions.admin<AuditRecording>(b.id, 'GET', `/audit/sessions/${s.id}/enregistrement${reveal ? '?reveler=true' : ''}`);
  } catch (e) {
    return toast(errorText(e) === 'SESSION_EXPIREE' ? tr('Bastion session expired: sign in again (sidebar).', 'Session du bastion expirée : reconnectez-vous (barre latérale).') : errorText(e), 'error');
  }
  const { AuditPlayer } = await import('./auditplayer');
  const view = h('div', { class: 'pane audit-pane' });
  const stamp = new Date(s.debut).toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const exportFile = async (name: string, ext: string, content: string, done: string) => {
    const dest = await save({ defaultPath: `${s.serveur}-${s.compte}-${stamp}${name}.${ext}`, filters: [{ name: ext === 'cast' ? tr('asciicast recording', 'Enregistrement asciicast') : tr('Text', 'Texte'), extensions: [ext] }] });
    if (!dest) return;
    try { await bastions.exportFile(dest, content); toast(`${done} : ${dest}`); } catch (e) { toast(errorText(e), 'error'); }
  };
  let player: AuditPlayer;
  // Onglet qui affiche ce lecteur (remplacé par la version révélée).
  let owner: Tab | undefined = replace;
  try {
    player = new AuditPlayer(view, rec, {
      viewer: b.login,
      start,
      canReveal: b.role === 'admin',
      reveal: () => {
        if (!confirm(tr('Show input typed without echo (usually passwords) in clear? This replay will be written to the bastion\'s log.', 'Afficher en clair les saisies sans écho (le plus souvent des mots de passe) ? Cette relecture sera inscrite au journal du bastion.'))) return;
        openAuditReplay(b, s, undefined, true, owner);
      },
      exportCast: () => exportFile(rec.revele ? '' : '-masque', 'cast', rec.cast, rec.revele ? tr('Signed recording exported', 'Enregistrement signé exporté') : tr('Masked copy exported (not signed)', 'Copie masquée exportée (non signée)')),
      exportText: () => exportFile('-transcription', 'txt', player.transcript(), tr('Transcript exported', 'Transcription exportée')),
    });
  } catch (e) {
    return toast(`Enregistrement illisible : ${errorText(e)}`, 'error');
  }
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

function renderTree() {
  sessionTree.render(state.folders, state.sessions, state.filter);
  if (extensionEnabled('heimdia')) bastionPanel.render();
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
          t.kind === 'local' && t.shell ? shellIcon(t.shell, 14) : t.kind === 'session' ? h('span', { class: `dot ${t.state === 'connected' ? 'on' : t.state === 'connecting' || t.state === 'reconnecting' ? 'wait' : ''}` }) : icon(t.kind === 'replay' ? 'play' : 'puzzle', 14),
          h('span', { class: 'ellipsis' }, t.title),
          t.protocol && badge(t.protocol)),
        h('button', { class: 'icon-btn sm', 'aria-label': tr(`Close ${t.title}`, `Fermer ${t.title}`), title: tr('Close (Ctrl Shift W)', 'Fermer (Ctrl Maj W)'), onclick: () => closeTab(t.id) }, icon('close', 13)));
      tabEl.addEventListener('contextmenu', (e) => tabMenu(t, e));
      paint(tabEl, colorOf(sessionOf(t.sessionId)?.folder ?? '', state.folderColors));
      return tabEl;
    }),
    h('button', { class: 'icon-btn', 'aria-label': tr('Palette: sessions, shells, actions and quick connect', 'Palette : sessions, shells, actions et connexion rapide'), title: tr('Go to… or quick connect (Ctrl Shift O)', 'Aller à… ou connexion rapide (Ctrl Maj O)'), onclick: () => openGlobalPalette() }, icon('search')),
    h('button', { class: 'icon-btn', 'aria-label': tr('Open a session or a local shell', 'Ouvrir une session ou un shell local'), title: tr('New session or local shell (Ctrl Shift T: default shell)', 'Nouvelle session ou shell local (Ctrl Maj T : shell par défaut)'), onclick: (e: MouseEvent) => openPlusMenu(e) }, icon('plus')),
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
  toolbar.replaceChildren(
    h('div', { class: 'toolbar-info' },
      coloredFolder && h('span', { class: 'env-label', title: tr('Folder colour', 'Couleur du dossier') }, coloredFolder.toUpperCase()),
      icon('terminal'), h('strong', {}, target || session.name),
      session.folder && h('span', { class: 'muted' }, `· ${session.folder}`),
      typeof v.jump === 'string' && v.jump.trim() && h('span', { class: 'muted', title: tr('Jump server', 'Serveur de rebond') }, `· via ${v.jump}`),
      h('span', { class: 'muted' }, `· ${label}`)),
    h('div', { class: 'toolbar-actions' },
      tab.state === 'closed' && h('button', { class: 'btn', onclick: () => reconnect(tab) }, icon('refresh', 14), tr('Reconnect', 'Reconnecter')),
      tab.state === 'reconnecting' && h('button', { class: 'btn', onclick: () => viewOf(tab)?.cancelReconnect() }, icon('close', 14), tr('Cancel the reconnection', 'Annuler la reconnexion')),
      !tab.quick && tab.state === 'connected' && protocolOf(session.protocol)?.portForwarding && h('button', {
        class: 'btn', title: tr('Port forwards through this session', 'Redirections de ports à travers cette session'),
        onclick: () => { const id = tab.term?.connection; if (id) openTunnels(session, id, toast, () => reload()); },
      }, icon('tunnel', 14), 'Tunnels'),
      tab.state === 'connected' && session.protocol === 'ssh' && h('button', {
        class: 'btn', title: tr('Create an SSH key and install it on this server (no more password)', 'Créer une clé SSH et l’installer sur ce serveur (plus de mot de passe)'),
        onclick: () => openKeysFor(tab, session),
      }, icon('lock', 14), tr('SSH key', 'Clé SSH')),
      tab.screen && h('button', { class: 'btn', title: tr('Send Ctrl+Alt+Del to the remote screen', 'Envoyer Ctrl+Alt+Suppr à l’écran distant'), onclick: () => tab.screen?.sendCtrlAltDel() }, tr('Ctrl+Alt+Del', 'Ctrl+Alt+Suppr')),
      tab.screen && session.protocol !== 'rdp' && h('button', { class: 'btn', title: tr('Copy the Windows clipboard to the remote screen', 'Copier le presse-papiers de Windows vers l’écran distant'), onclick: () => tab.screen?.sendClipboard() }, icon('copy', 14), tr('Clipboard', 'Presse-papiers')),
      tab.screen && h('button', { class: 'btn', title: tr('Fit the image to the tab or show it at real size', 'Adapter l’image à l’onglet ou afficher en taille réelle'), onclick: () => { tab.screen?.toggleFit(); renderToolbar(); } }, tab.screen.fit ? tr('Real size', 'Taille réelle') : tr('Fit to window', 'Ajuster à la fenêtre')),
      tab.term && tab.state === 'connected' && h('button', {
        class: `btn${tab.recording ? ' rec' : ''}`, title: tab.recording ? `Enregistrement en cours : ${tab.recording}` : tr('Record this session (asciicast + text)', 'Enregistrer cette session (asciicast + texte)'),
        onclick: () => (tab.recording ? stopRecording(tab) : startRecording(tab)),
      }, h('span', { class: 'rec-dot' }), tab.recording ? tr('Stop recording', 'Arrêter l’enregistrement') : tr('Record', 'Enregistrer')),
      tab.term && h('button', { class: 'btn', title: tr('Saved commands (Ctrl Shift P)', 'Commandes enregistrées (Ctrl Maj P)'), onclick: () => openPalette(snippetContext()) }, icon('commands', 14), tr('Commands', 'Commandes')),
      tab.term && h('button', { class: 'icon-btn', 'aria-label': tr('Search in the terminal', 'Rechercher dans le terminal'), title: tr('Search (Ctrl Shift F)', 'Rechercher (Ctrl Maj F)'), onclick: () => tab.term?.openSearch() }, icon('search')),
      h('button', { class: `btn${isSplit() ? ' on' : ''}`, title: tr('Show several sessions side by side', 'Afficher plusieurs sessions côte à côte'), onclick: (e: MouseEvent) => splitMenu(e) }, icon('split', 14), tr('Split screen', 'Écran partagé')),
      isSplit() && h('button', {
        class: `btn${state.broadcast ? ' warn' : ''}`, 'aria-pressed': String(state.broadcast),
        title: tr('Send keystrokes to all displayed sessions (Ctrl Shift B)', 'Envoyer la frappe à toutes les sessions affichées (Ctrl Maj B)'),
        onclick: () => toggleBroadcast(),
      }, icon('broadcast', 14), state.broadcast ? tr('Multi-input: ON', 'Saisie multiple : ACTIVE') : tr('Multi-input', 'Saisie multiple')),
      tab.state === 'connected' && h('button', { class: 'btn', onclick: () => closeTab(tab.id) }, icon('power', 14), tr('Disconnect', 'Déconnecter')),
      tab.state === 'connected' && session.protocol === 'ssh' && h('button', {
        class: `btn${shownSide(tab) === 'containers' ? ' on' : ''}`, 'aria-pressed': String(shownSide(tab) === 'containers'),
        title: tr('Server\'s Docker / Podman containers and Kubernetes pods', 'Conteneurs Docker / Podman et pods Kubernetes du serveur'),
        onclick: () => toggleContainers(tab),
      }, icon('box', 14), tr('Containers', 'Conteneurs'), !allows('containers') && h('span', { class: 'chip pro locked' }, 'PRO')),
      tab.state === 'connected' && session.protocol === 'ssh' && h('button', {
        class: `btn${shownSide(tab) === 'server' ? ' on' : ''}`, 'aria-pressed': String(shownSide(tab) === 'server'),
        title: tr('Dashboard: CPU, memory, disks, processes, failed services', 'Tableau de bord : processeur, mémoire, disques, processus, services en échec'),
        onclick: () => toggleServer(tab),
      }, icon('chart', 14), tr('Server', 'Serveur'), !allows('serverDashboard') && h('span', { class: 'chip pro locked' }, 'PRO')),
      !tab.quick && h('button', {
        class: `btn${shownSide(tab) === 'notes' ? ' on' : ''}`, 'aria-pressed': String(shownSide(tab) === 'notes'),
        title: state.noteIds.has(session.id) ? tr('Notes for this session (a note exists)', 'Notes de cette session (une note existe)') : tr('Notes for this session (Markdown)', 'Notes de cette session (Markdown)'),
        onclick: () => toggleNotes(tab),
      }, icon('edit', 14), state.noteIds.has(session.id) ? 'Notes •' : 'Notes'),
      tab.files && !tab.filesView && h('button', {
        class: `btn${shownSide(tab) === 'files' ? ' on' : ''}`, 'aria-pressed': String(shownSide(tab) === 'files'), title: tr('Show / hide the file browser', 'Afficher / masquer l\'explorateur de fichiers'),
        onclick: () => showSide(tab, 'files'),
      }, icon('files', 14), tr('Files', 'Fichiers')),
      tab.quick
        ? h('button', { class: 'btn primary', title: tr('Keep this connection in the session list', 'Garder cette connexion dans la liste des sessions'), onclick: () => tab.quick && saveQuick(tab.quick) }, icon('plus', 14), tr('Save as a session', 'Enregistrer comme session'))
        : h('button', { class: 'btn', onclick: () => editSession(session) }, icon('edit', 14), tr('Edit', 'Modifier'))),
  );
}

type SidePanel = 'files' | 'notes' | 'server' | 'containers' | '';

/** Panneau réellement affiché pour cet onglet (celui demandé s'il existe, sinon les fichiers). */
function shownSide(tab: Tab | undefined): SidePanel {
  // Onglet « fichiers seulement » : l'explorateur est déjà au centre.
  if (!tab || !state.side || tab.filesView) return '';
  if (state.side === 'notes' && tab.notes) return 'notes';
  if (state.side === 'server' && tab.server) return 'server';
  if (state.side === 'containers' && tab.containers) return 'containers';
  return tab.files ? 'files' : '';
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
  if (details.firstChild !== panel) details.replaceChildren(panel);
}

/** Affiche un panneau, ou le masque s'il est déjà affiché. */
function showSide(tab: Tab, side: Exclude<SidePanel, ''>) {
  state.side = shownSide(tab) === side ? '' : side;
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
  if (created) state.side = '';
  showSide(tab, 'notes');
}

function renderStatus() {
  const open = state.tabs.filter((t) => t.kind === 'session' && t.state === 'connected').length;
  const localCount = state.tabs.filter((t) => t.kind === 'local' && t.state === 'connected').length;
  statusBar.replaceChildren(
    h('span', {}, h('span', { class: `dot${open ? ' on' : ''}` }), tr(`${open} session(s) connected${localCount ? ` · ${localCount} local shell(s)` : ''}`, `${open} session(s) connectée(s)${localCount ? ` · ${localCount} shell(s) local(aux)` : ''}`)),
    h('span', {}, tr(`${state.sessions.length} saved`, `${state.sessions.length} enregistrée(s)`)),
    h('span', { class: 'push' }, enabledProtocols().length < state.protocols.length
      ? `${enabledProtocols().length}/${state.protocols.length} extensions` : `${state.protocols.length} extensions`),
    ...(settings().monitoring && monitor.summary().total ? [h('button', {
      class: `status-btn${monitor.summary().up < monitor.summary().total ? ' warn' : ''}`, title: tr('Server monitoring', 'Supervision des serveurs'),
      onclick: () => monitor.openOverview((s) => openSession(s)),
    }, h('span', { class: `health ${monitor.summary().up < monitor.summary().total ? 'down' : 'up'}` }), `${monitor.summary().up}/${monitor.summary().total} en ligne`)] : []),
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
      if (!/Authentification refusée/.test(reason) || reason.includes(tr('Jump server', 'Serveur de rebond')) || attempt >= 4) throw e;
      // Laisse s'afficher les messages en route (« Nouveau serveur mémorisé… ») avant la question.
      await new Promise((r) => setTimeout(r, 80));
      if (typed.password !== undefined) term.write(tr('\x1b[31mAccess denied.\x1b[0m\r\n', '\x1b[31mAccès refusé.\x1b[0m\r\n'));
      await askPassword();
    }
  }
}

/** Ouverture fournie par une extension (bastion) : connexion et saisie éventuelle dans le terminal. */
interface CustomOpen {
  connect: (typed: Record<string, unknown>, cols: number, rows: number, onEvent: (e: TermEvent) => void) => Promise<ConnectResponse>;
  typing: boolean;
}

async function openSession(session: Session, quick?: QuickTarget, custom?: CustomOpen) {
  const proto = protocolOf(session.protocol);
  if (!proto) return toast(tr(`Extension « ${session.protocol} » not installed`, `Extension « ${session.protocol} » non installée`), 'error');
  if (!extensionEnabled(proto.id)) {
    if (!confirm(tr(`The extension « ${proto.name} » is disabled. Enable it and open « ${session.name} »?`, `L'extension « ${proto.name} » est désactivée. L'activer et ouvrir « ${session.name} » ?`))) return;
    setExtension(proto.id, true);
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
  const opener = !typing ? connectOnce : (cols: number, rows: number, onEvent: (e: TermEvent) => void) =>
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
  const tab: Tab = {
    id: crypto.randomUUID(), kind: 'session', title: session.name, sessionId: quick || custom ? undefined : session.id, protocol: session.protocol,
    quick, view, paneHead, state: 'connecting', receive: true,
  };
  // Cliquer dans un volet de l'écran partagé le rend actif.
  view.addEventListener('pointerdown', (e) => {
    if (state.active !== tab.id && !(e.target as HTMLElement).closest('.pane-head')) activate(tab.id);
  }, true);
  if (proto.fileBrowser) tab.files = new FilePanel(toast, session.protocol === 'ftp' ? (session.values.security === 'none' ? 'FTP' : 'FTPS') : session.protocol === 's3' ? 'S3' : 'SFTP');
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
    tab.filesView = new FilesView(termEl, tab.files, onState);
    activate(tab.id);
    await tab.filesView.connectWith(opener, session.name);
    return;
  }
  if (proto.view === 'screen') {
    tab.screen = new (await import('./screen')).ScreenView(termEl, onState);
    tab.screen.onDetached = (message) => { toast(message); closeTab(tab.id); };
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
  usage.heimdia = bastionPanel.list.length;
  return renderExtensions([...state.protocols, HEIMDIA_EXTENSION], usage, extensionEnabled, (id, on) => {
    setExtension(id, on);
    toast(tr(`Extension « ${protocolOf(id)?.name ?? (id === 'heimdia' ? HEIMDIA_EXTENSION.name : id)} » ${on ? 'enabled' : 'disabled'}`, `Extension « ${protocolOf(id)?.name ?? (id === 'heimdia' ? HEIMDIA_EXTENSION.name : id)} » ${on ? 'activée' : 'désactivée'}`));
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
$('open-extensions').append(icon('puzzle'), h('span', { class: 'grow' }, 'Extensions'));
$('open-extensions').addEventListener('click', openExtensions);
$('open-settings').append(icon('settings'), h('span', { class: 'grow' }, tr('Settings', 'Paramètres')));
$('open-settings').addEventListener('click', () => openSettingsDialog(toast));
$('open-snippets').append(icon('commands'), h('span', { class: 'grow' }, tr('Saved commands', 'Commandes enregistrées')));
$('open-snippets').addEventListener('click', () => openSnippetManager(snippetContext()));
$('open-recordings').append(icon('play'), h('span', { class: 'grow' }, tr('Recordings', 'Enregistrements')));
$('open-recordings').addEventListener('click', () => openRecordings(toast));
$('open-nettools').append(icon('broadcast'), h('span', { class: 'grow' }, tr('Network tools', 'Outils réseau')));
$('open-nettools').addEventListener('click', () => openNetTools());
$('open-credentials').append(icon('user'), h('span', { class: 'grow' }, tr('Shared credentials', 'Identifiants partagés')));
$('open-credentials').addEventListener('click', () => openCredentialManager(toast, () => reload()));
setPlayerHandler(openReplay);
$('open-import').append(icon('upload'), h('span', { class: 'grow' }, tr('Import / export', 'Importer / exporter')));
$('open-import').addEventListener('click', () => openImportExport((msg) => { toast(msg); reload(); }, toast));
search.addEventListener('input', () => { state.filter = search.value; renderTree(); });

// Glisser-déposer depuis l'Explorateur Windows sur le panneau Fichiers = envoi au serveur.
function overFiles(pos: { x: number; y: number }) {
  if (details.hidden) return false;
  const r = details.getBoundingClientRect();
  const x = pos.x / devicePixelRatio;
  const y = pos.y / devicePixelRatio;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
getCurrentWebview().onDragDropEvent(({ payload }) => {
  const files = activeTab()?.files;
  if (!files) return;
  if (payload.type === 'leave') return files.setDropping(false);
  const inside = !!activeTab()?.filesView || overFiles(payload.position);
  files.setDropping(payload.type !== 'drop' && inside);
  if (payload.type === 'drop' && inside) files.uploadPaths(payload.paths);
});

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || document.querySelector('dialog[open]') || isLocked()) return;
  const key = e.key.toLowerCase();
  if (key === 'k') { e.preventDefault(); search.focus(); search.select(); }
  else if (key === 'n') { e.preventDefault(); newSession(); }
  else if (key === 'q') { e.preventDefault(); quickConnect(); }
  else if (key === 't') { e.preventDefault(); const def = defaultShell(); if (def) openLocalShell(def); else toast(tr('No local shell found', 'Aucun shell local trouvé'), 'error'); }
  else if (key === 'w' && state.active) { e.preventDefault(); closeTab(state.active); }
  else if (key === 'f') { e.preventDefault(); activeTab()?.term?.openSearch(); }
  else if (key === 'b') { e.preventDefault(); toggleBroadcast(); }
  else if (key === 'p') { e.preventDefault(); openPalette(snippetContext()); }
  else if (key === 'l') { e.preventDefault(); lockNow(toast, () => reload()); }
  else if (key === 'o') { e.preventDefault(); openGlobalPalette(); }
});

initTheme();
reload();
// Vérification discrète des mises à jour, une fois l'application chargée.
if (settings().autoUpdate) setTimeout(() => checkForUpdates(toast, true), 4000);
loadLicense().then(() => renderStatus());
// Shells locaux : détection, section « Ce PC », ouverture au démarrage si demandé.
loadShells().then(() => {
  renderShells();
  const def = defaultShell();
  if (settings().localShells.atStartup && def) openLocalShell(def);
});
onSettingsChange(() => renderShells());
// Extension activée ou désactivée : menus, arborescence et page Extensions.
let extensionsKey = settings().disabledExtensions.join(',');
onSettingsChange((s) => {
  const key = s.disabledExtensions.join(',');
  if (key === extensionsKey) return;
  extensionsKey = key;
  bastionPanel.show(extensionEnabled('heimdia'));
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
initLock(() => { reload(); bastionPanel.show(extensionEnabled('heimdia')); });
bastionPanel.show(extensionEnabled('heimdia'));

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
    { label: tr('Open as administrator (separate window)', 'Ouvrir en administrateur (fenêtre séparée)'), icon: 'lock', action: () => shells.openElevated(shell).catch((err) => toast(errorText(err), 'error')) },
    { label: tr('Default shell (Ctrl+Shift+T)', 'Shell par défaut (Ctrl+Maj+T)'), icon: 'check', action: () => setDefaultShell(shell.id) },
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
      class: 'tree-item shell-item', title: tr(`${s.command} ${s.args.join(' ')}${def?.id === s.id ? '\nDefault shell (Ctrl+Shift+T)' : ''}`, `${s.command} ${s.args.join(' ')}${def?.id === s.id ? '\nShell par défaut (Ctrl+Maj+T)' : ''}`),
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
    ...visibleShells().map((s) => ({ label: s.id === def?.id ? `${s.name}  (Ctrl+Maj+T)` : s.name, icon: s.icon === 'wsl' ? 'wsl' : s.icon === 'git' ? 'git' : 'prompt', action: () => openLocalShell(s) })),
    ...(def ? [{ label: `${def.name} en administrateur`, icon: 'lock', action: () => shells.openElevated(def).catch((err) => toast(errorText(err), 'error')) }] : []),
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
    h('div', { class: 'toolbar-actions' },
      tab.state === 'closed' && h('button', { class: 'btn', onclick: () => tab.term?.reconnectNow() }, icon('refresh', 14), tr('Restart', 'Relancer')),
      tab.state === 'connected' && h('button', {
        class: `btn${tab.recording ? ' rec' : ''}`, onclick: () => (tab.recording ? stopRecording(tab) : startRecording(tab)),
      }, h('span', { class: 'rec-dot' }), tab.recording ? tr('Stop recording', 'Arrêter l’enregistrement') : tr('Record', 'Enregistrer')),
      h('button', { class: 'btn', title: tr('Saved commands (Ctrl Shift P)', 'Commandes enregistrées (Ctrl Maj P)'), onclick: () => openPalette(snippetContext()) }, icon('commands', 14), tr('Commands', 'Commandes')),
      h('button', { class: 'icon-btn', 'aria-label': tr('Search in the terminal', 'Rechercher dans le terminal'), title: tr('Search (Ctrl Shift F)', 'Rechercher (Ctrl Maj F)'), onclick: () => tab.term?.openSearch() }, icon('search')),
      h('button', { class: `btn${isSplit() ? ' on' : ''}`, onclick: (e: MouseEvent) => splitMenu(e) }, icon('split', 14), tr('Split screen', 'Écran partagé')),
      isSplit() && h('button', { class: `btn${state.broadcast ? ' warn' : ''}`, onclick: () => toggleBroadcast() }, icon('broadcast', 14), state.broadcast ? tr('Multi-input: ON', 'Saisie multiple : ACTIVE') : tr('Multi-input', 'Saisie multiple')),
      h('button', { class: 'btn', onclick: () => closeTab(tab.id) }, icon('close', 14), tr('Close', 'Fermer'))),
  );
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
    { label: tr('New session', 'Nouvelle session'), group: 'Action', icon: 'plus', hint: tr('Ctrl+Shift+N', 'Ctrl+Maj+N'), action: () => newSession() },
    { label: tr('Quick connect', 'Connexion rapide'), group: 'Action', icon: 'link', hint: tr('Ctrl+Shift+Q', 'Ctrl+Maj+Q'), keywords: tr('address server login password unsaved adresse serveur identifiant mot de passe sans enregistrer', 'adresse serveur identifiant mot de passe sans enregistrer'), action: () => quickConnect() },
    { label: tr('Saved commands', 'Commandes enregistrées'), group: 'Action', icon: 'commands', hint: tr('Ctrl+Shift+P', 'Ctrl+Maj+P'), action: () => openSnippetManager(snippetContext()) },
    { label: tr('Recordings', 'Enregistrements'), group: 'Action', icon: 'play', action: () => openRecordings(toast) },
    { label: tr('Import / export', 'Importer / exporter'), group: 'Action', icon: 'upload', action: () => openImportExport((msg) => { toast(msg); reload(); }, toast) },
    { label: 'Extensions', group: 'Action', icon: 'puzzle', action: () => openExtensions() },
    { label: tr('Server monitoring', 'Supervision des serveurs'), group: 'Action', icon: 'refresh', action: () => monitor.openOverview((s) => openSession(s)) },
    { label: tr('SSH keys', 'Clés SSH'), group: 'Action', icon: 'lock', hint: tr('Create, copy, install', 'Créer, copier, installer'), keywords: 'ssh-keygen ed25519 rsa authorized_keys', action: () => { const t = activeTab(); const s = sessionOf(t?.sessionId) ?? (t?.quick && quickSession(t.quick)); if (t && s && s.protocol === 'ssh' && t.state === 'connected') openKeysFor(t, s); else openKeyManager({ toast }); } },
    { label: tr('Shared credentials', 'Identifiants partagés'), group: 'Action', icon: 'user', hint: tr('One account for several sessions', 'Un compte pour plusieurs sessions'), keywords: tr('password account login credentials mot de passe compte', 'mot de passe compte login credentials'), action: () => openCredentialManager(toast, () => reload()) },
    { label: tr('Command on several servers', 'Commande sur plusieurs serveurs'), group: 'Action', icon: 'commands', hint: 'Pro', keywords: tr('multi exec run all servers parallel ansible lancer tous serveurs parallèle', 'multi exec lancer tous serveurs parallèle ansible'), action: () => openMultiExec() },
    { label: tr('Network tools', 'Outils réseau'), group: 'Action', icon: 'broadcast', hint: 'Ping, traceroute, ports, DNS, Wake-on-LAN', keywords: 'ping tracert traceroute port scan dns nslookup wol wake', action: () => openNetTools() },
    { label: tr('Settings', 'Paramètres'), group: 'Action', icon: 'settings', action: () => openSettingsDialog(toast) },
    { label: tr('Lock Portunia', 'Verrouiller Portunia'), group: 'Action', icon: 'lock', hint: tr('Ctrl+Shift+L', 'Ctrl+Maj+L'), action: () => lockNow(toast, () => reload()) },
  ];
  return [...sessionEntries, ...shellEntries, ...actions];
}

function openGlobalPalette(initial = '') {
  openCommandPalette(paletteEntries(), (target) => openQuick(target), initial, (address) => quickConnect(address));
}

// Entrée dans la recherche : « user@hôte », « rdp srv-01 »… = connexion rapide.
search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
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
