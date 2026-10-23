import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { api, errorText, Manifest, Session, Snippet } from './api';
import { badge, h, icon } from './dom';
import { openSessionDialog } from './dialog';
import { renderExtensions } from './extensions';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { FilePanel } from './files';
import { TerminalView, TermState } from './terminal';
import { leafOf, parentOf, SessionTree } from './tree';
import { showMenu } from './menu';
import { openPalette, openSnippetManager, SnippetContext } from './snippets';
import { openTunnels } from './tunnels';
import { openSettingsDialog } from './settings';

interface Tab {
  id: string;
  kind: 'session' | 'extensions';
  title: string;
  sessionId?: string;
  protocol?: string;
  view: HTMLElement;
  term?: TerminalView;
  files?: FilePanel;
  state: TermState;
  /** En-tête affiché quand l'onglet est dans l'écran partagé. */
  paneHead?: HTMLElement;
  /** Reçoit la saisie multiple. */
  receive: boolean;
}

const state = {
  protocols: [] as Manifest[],
  sessions: [] as Session[],
  tabs: [] as Tab[],
  active: null as string | null,
  filter: '',
  folders: [] as string[],
  showFiles: true,
  /** Onglets affichés côte à côte (2 à 4), vide = un seul onglet à l'écran. */
  split: [] as string[],
  /** Saisie multiple : la frappe part vers toutes les sessions de l'écran partagé. */
  broadcast: false,
  snippets: [] as Snippet[],
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

const sessionTree = new SessionTree(tree, {
  isConnected,
  activeSessionId: () => activeTab()?.sessionId,
  openSession: (s) => openSession(s),
  editSession: (s) => editSession(s),
  duplicateSession: (s) => act(async () => {
    const copy = await api.duplicateSession(s.id);
    toast(`Session dupliquée : ${copy.name}`);
  }),
  removeSession: (s) => removeSession(s),
  newSession: (folder) => newSession(folder),
  newFolder: (parent) => promptNewFolder(parent),
  renameFolder: (path) => {
    const name = prompt('Nouveau nom du dossier :', leafOf(path))?.trim();
    if (!name || name === leafOf(path)) return;
    const parent = parentOf(path);
    act(() => api.renameFolder(path, parent ? `${parent}/${name}` : name));
  },
  deleteFolder: (path) => {
    const inside = state.sessions.filter((s) => s.folder === path || s.folder.startsWith(`${path}/`)).length;
    const where = parentOf(path) ? `le dossier « ${parentOf(path)} »` : 'la racine';
    const detail = inside ? `\nSes ${inside} session(s) et sous-dossiers seront déplacés dans ${where} (rien n'est supprimé).` : '';
    if (confirm(`Supprimer le dossier « ${leafOf(path)} » ?${detail}`)) act(() => api.deleteFolder(path));
  },
  openAll: (path) => {
    const list = state.sessions.filter((s) => s.folder === path || s.folder.startsWith(`${path}/`));
    if (list.length > 8 && !confirm(`Ouvrir ${list.length} sessions ?`)) return;
    list.forEach((s) => openSession(s));
  },
  moveSessions: (ids, folder) => act(() => api.moveSessions(ids, folder)),
  moveFolder: (path, parent) => act(() => api.renameFolder(path, parent ? `${parent}/${leafOf(path)}` : leafOf(path))),
});
tree.addEventListener('tree-change', () => renderTree());

function promptNewFolder(parent: string) {
  const name = prompt(parent ? `Nouveau sous-dossier dans « ${parent} » :` : 'Nom du nouveau dossier :')?.trim();
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
}

// ---------- Onglets ----------

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
  if (base.length >= MAX_PANES) return toast(`L'écran partagé est limité à ${MAX_PANES} sessions`, 'error');
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
      if (!tab?.term?.connection) return toast('La session active n\'est pas connectée', 'error');
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
  const candidates = state.tabs.filter((t) => t.kind === 'session' && !visibleTabs().includes(t));
  showMenu(e.clientX, e.clientY, [
    ...(candidates.length
      ? candidates.map((t) => ({ label: `Afficher à côté : ${t.title}`, icon: 'split', action: () => addToSplit(t.id) }))
      : [{ label: 'Ouvrez d\'abord une autre session', action: () => {} }]),
    ...(isSplit() ? ['separator' as const, { label: 'Quitter l\'écran partagé', icon: 'close', action: leaveSplit }] : []),
  ]);
}

function tabMenu(t: Tab, e: MouseEvent) {
  e.preventDefault();
  const inSplit = isSplit() && visibleTabs().includes(t);
  showMenu(e.clientX, e.clientY, [
    ...(t.kind === 'session' && !inSplit && t.id !== state.active && activeTab()?.kind === 'session'
      ? [{ label: 'Afficher à côté de l\'onglet actif', icon: 'split', action: () => addToSplit(t.id) }]
      : []),
    ...(inSplit ? [{ label: 'Retirer de l\'écran partagé', icon: 'split', action: () => removeFromSplit(t.id) }] : []),
    { label: 'Fermer', icon: 'close', action: () => closeTab(t.id) },
    { label: 'Fermer les autres onglets', action: () => state.tabs.filter((o) => o !== t).forEach((o) => closeTab(o.id)) },
  ]);
}

function renderTabs() {
  tabsBar.replaceChildren(
    ...state.tabs.map((t) => {
      const selected = t.id === state.active;
      const shown = isSplit() && visibleTabs().includes(t);
      const tabEl = h('div', { class: `tab${selected ? ' active' : ''}${shown && !selected ? ' shown' : ''}` },
        h('button', { role: 'tab', 'aria-selected': String(selected), class: 'tab-main', onclick: () => activate(t.id) },
          t.kind === 'session' ? h('span', { class: `dot ${t.state === 'connected' ? 'on' : t.state === 'connecting' || t.state === 'reconnecting' ? 'wait' : ''}` }) : icon('puzzle', 14),
          h('span', { class: 'ellipsis' }, t.title),
          t.protocol && badge(t.protocol)),
        h('button', { class: 'icon-btn sm', 'aria-label': `Fermer ${t.title}`, title: 'Fermer (Ctrl Maj W)', onclick: () => closeTab(t.id) }, icon('close', 13)));
      tabEl.addEventListener('contextmenu', (e) => tabMenu(t, e));
      return tabEl;
    }),
    h('button', { class: 'icon-btn', 'aria-label': 'Nouvelle session', title: 'Nouvelle session', onclick: () => newSession() }, icon('plus')),
  );
}

function renderToolbar() {
  const tab = activeTab();
  const session = sessionOf(tab?.sessionId);
  if (!tab || tab.kind !== 'session' || !session) {
    toolbar.replaceChildren();
    toolbar.hidden = true;
    return;
  }
  toolbar.hidden = false;
  const v = session.values;
  const target = [v.username && `${v.username}@`, v.host ?? v.url, v.port && `:${v.port}`].filter(Boolean).join('');
  const label = { connecting: 'connexion…', connected: 'connecté', reconnecting: 'reconnexion…', closed: 'déconnecté' }[tab.state];
  toolbar.replaceChildren(
    h('div', { class: 'toolbar-info' },
      icon('terminal'), h('strong', {}, target || session.name),
      session.folder && h('span', { class: 'muted' }, `· ${session.folder}`),
      h('span', { class: 'muted' }, `· ${label}`)),
    h('div', { class: 'toolbar-actions' },
      tab.state === 'closed' && h('button', { class: 'btn', onclick: () => reconnect(tab) }, icon('refresh', 14), 'Reconnecter'),
      tab.state === 'reconnecting' && h('button', { class: 'btn', onclick: () => tab.term?.cancelReconnect() }, icon('close', 14), 'Annuler la reconnexion'),
      tab.state === 'connected' && protocolOf(session.protocol)?.portForwarding && h('button', {
        class: 'btn', title: 'Redirections de ports à travers cette session',
        onclick: () => { const id = tab.term?.connection; if (id) openTunnels(session, id, toast, () => reload()); },
      }, icon('tunnel', 14), 'Tunnels'),
      tab.term && h('button', { class: 'btn', title: 'Commandes enregistrées (Ctrl Maj P)', onclick: () => openPalette(snippetContext()) }, icon('commands', 14), 'Commandes'),
      tab.term && h('button', { class: 'icon-btn', 'aria-label': 'Rechercher dans le terminal', title: 'Rechercher (Ctrl Maj F)', onclick: () => tab.term?.openSearch() }, icon('search')),
      h('button', { class: `btn${isSplit() ? ' on' : ''}`, title: 'Afficher plusieurs sessions côte à côte', onclick: (e: MouseEvent) => splitMenu(e) }, icon('split', 14), 'Écran partagé'),
      isSplit() && h('button', {
        class: `btn${state.broadcast ? ' warn' : ''}`, 'aria-pressed': String(state.broadcast),
        title: 'Envoyer la frappe à toutes les sessions affichées (Ctrl Maj B)',
        onclick: () => toggleBroadcast(),
      }, icon('broadcast', 14), state.broadcast ? 'Saisie multiple : ACTIVE' : 'Saisie multiple'),
      tab.state === 'connected' && h('button', { class: 'btn', onclick: () => closeTab(tab.id) }, icon('power', 14), 'Déconnecter'),
      tab.files && h('button', {
        class: `btn${state.showFiles ? ' on' : ''}`, 'aria-pressed': String(state.showFiles), title: 'Afficher / masquer l\'explorateur de fichiers',
        onclick: () => { state.showFiles = !state.showFiles; renderAll(); requestAnimationFrame(() => tab.term?.refit()); },
      }, icon('files', 14), 'Fichiers'),
      h('button', { class: 'btn', onclick: () => editSession(session) }, icon('edit', 14), 'Modifier')),
  );
}

/** Panneau de droite : explorateur de fichiers du serveur de l'onglet actif. */
function renderSidePanel() {
  const files = activeTab()?.files;
  if (!files || !state.showFiles) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  if (details.firstChild !== files.el) details.replaceChildren(files.el);
}

function renderStatus() {
  const open = state.tabs.filter((t) => t.kind === 'session' && t.state === 'connected').length;
  statusBar.replaceChildren(
    h('span', {}, h('span', { class: `dot${open ? ' on' : ''}` }), `${open} session(s) connectée(s)`),
    h('span', {}, `${state.sessions.length} enregistrée(s)`),
    h('span', { class: 'push' }, `${state.protocols.length} extensions`),
    h('span', {}, 'v0.8.0'),
  );
}

function toggleBroadcast() {
  if (!isSplit()) return;
  state.broadcast = !state.broadcast;
  renderAll();
  activeTab()?.term?.focus();
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
      h('h2', {}, 'Aucune session ouverte'),
      h('p', { class: 'muted' }, 'Choisissez une session à gauche, ou créez-en une.'),
      h('button', { class: 'btn primary', onclick: () => newSession() }, icon('plus', 14), 'Nouvelle session')));
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
    state.broadcast && h('label', { class: 'pane-receive', title: 'Cette session reçoit la saisie multiple' },
      h('input', { type: 'checkbox', checked: t.receive || t.id === state.active, disabled: t.id === state.active, onchange: (e: Event) => { t.receive = (e.target as HTMLInputElement).checked; renderViews(); } }),
      'reçoit'),
    h('button', { class: 'icon-btn sm', 'aria-label': `Retirer ${t.title} de l'écran partagé`, title: 'Retirer de l\'écran partagé', onclick: () => removeFromSplit(t.id) }, icon('close', 12))));
}

function renderAll() {
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
    for (const t of visibleTabs()) t.term?.refit();
    tab?.term?.focus();
  });
}

function closeTab(id: string) {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  const [tab] = state.tabs.splice(index, 1);
  tab.term?.dispose();
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

async function openSession(session: Session) {
  const proto = protocolOf(session.protocol);
  if (!proto) return toast(`Extension « ${session.protocol} » non installée`, 'error');

  // Bureau à distance et web s'ouvrent dans leur propre fenêtre.
  if (proto.view !== 'terminal') {
    try {
      const res = await api.connect(session.id, 80, 24, () => {});
      toast(res.message ?? `${session.name} ouvert`);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    return;
  }

  const existing = state.tabs.find((t) => t.sessionId === session.id);
  if (existing) return activate(existing.id);

  const termEl = h('div', { class: 'term-view' });
  const paneHead = h('div', { class: 'pane-head', hidden: true });
  const view = h('div', { class: 'pane' }, paneHead, termEl);
  views.append(view);
  const tab: Tab = {
    id: crypto.randomUUID(), kind: 'session', title: session.name, sessionId: session.id, protocol: session.protocol,
    view, paneHead, state: 'connecting', receive: true,
  };
  // Cliquer dans un volet de l'écran partagé le rend actif.
  view.addEventListener('pointerdown', (e) => {
    if (state.active !== tab.id && !(e.target as HTMLElement).closest('.pane-head')) activate(tab.id);
  }, true);
  if (proto.fileBrowser) tab.files = new FilePanel(toast);
  tab.term = new TerminalView(termEl, (s, reason) => {
    tab.state = s;
    if (s === 'closed' && reason && tab.id !== state.active) toast(`${session.name} : ${reason}`, 'error');
    const id = tab.term?.connection;
    if (s === 'connected' && id) tab.files?.attach(id);
    if (s === 'closed') tab.files?.detach();
    renderAll();
  });
  state.tabs.push(tab);
  activate(tab.id);
  tab.term.inputHook = (data) => broadcastFrom(tab, data);
  await tab.term.connect(session.id, session.name);
}

function reconnect(tab: Tab) {
  tab.term?.reconnectNow();
}

async function reload() {
  try {
    [state.protocols, state.sessions, state.folders, state.snippets] = await Promise.all([api.listProtocols(), api.listSessions(), api.listFolders(), api.listSnippets()]);
  } catch (e) {
    toast(errorText(e), 'error');
  }
  for (const t of state.tabs) {
    const s = sessionOf(t.sessionId);
    if (s) t.title = s.name;
  }
  renderAll();
}

async function newSession(folder = '') {
  const result = await openSessionDialog({ protocols: state.protocols, folders: folders(), defaultFolder: folder });
  await afterDialog(result);
}

async function editSession(session: Session) {
  const result = await openSessionDialog({ protocols: state.protocols, folders: folders(), existing: session });
  await afterDialog(result);
}

async function afterDialog(result: Awaited<ReturnType<typeof openSessionDialog>>) {
  if (!result) return;
  await reload();
  if (result.connect) await openSession(result.session);
}

async function removeSession(session: Session) {
  if (!confirm(`Supprimer la session « ${session.name} » ? Ses mots de passe enregistrés seront aussi effacés.`)) return;
  try {
    for (const t of state.tabs.filter((t) => t.sessionId === session.id)) closeTab(t.id);
    await api.deleteSession(session.id);
    await reload();
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

function openExtensions() {
  const existing = state.tabs.find((t) => t.kind === 'extensions');
  if (existing) existing.view.remove();
  const usage: Record<string, number> = {};
  for (const s of state.sessions) usage[s.protocol] = (usage[s.protocol] ?? 0) + 1;
  const view = h('div', { class: 'page-view' }, renderExtensions(state.protocols, usage));
  views.append(view);
  if (existing) {
    existing.view = view;
    return activate(existing.id);
  }
  const tab: Tab = { id: crypto.randomUUID(), kind: 'extensions', title: 'Extensions', view, state: 'connected', receive: false };
  state.tabs.push(tab);
  activate(tab.id);
}

// ---------- Démarrage ----------

$('new-folder').append(icon('folderPlus'));
$('new-folder').addEventListener('click', () => promptNewFolder(''));
$('new-session').append(icon('plus'));
$('new-session').addEventListener('click', () => newSession());
$('open-extensions').append(icon('puzzle'), h('span', { class: 'grow' }, 'Extensions'));
$('open-extensions').addEventListener('click', openExtensions);
$('open-settings').append(icon('settings'), h('span', { class: 'grow' }, 'Paramètres'));
$('open-settings').addEventListener('click', openSettingsDialog);
$('open-snippets').append(icon('commands'), h('span', { class: 'grow' }, 'Commandes enregistrées'));
$('open-snippets').addEventListener('click', () => openSnippetManager(snippetContext()));
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
  const inside = overFiles(payload.position);
  files.setDropping(payload.type !== 'drop' && inside);
  if (payload.type === 'drop' && inside) files.uploadPaths(payload.paths);
});

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || document.querySelector('dialog[open]')) return;
  const key = e.key.toLowerCase();
  if (key === 'k') { e.preventDefault(); search.focus(); search.select(); }
  else if (key === 'n') { e.preventDefault(); newSession(); }
  else if (key === 'w' && state.active) { e.preventDefault(); closeTab(state.active); }
  else if (key === 'f') { e.preventDefault(); activeTab()?.term?.openSearch(); }
  else if (key === 'b') { e.preventDefault(); toggleBroadcast(); }
  else if (key === 'p') { e.preventDefault(); openPalette(snippetContext()); }
});

reload();
