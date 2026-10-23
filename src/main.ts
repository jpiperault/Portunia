import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { api, errorText, Manifest, Session } from './api';
import { badge, h, icon } from './dom';
import { openSessionDialog } from './dialog';
import { renderExtensions } from './extensions';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { FilePanel } from './files';
import { TerminalView, TermState } from './terminal';
import { leafOf, parentOf, SessionTree } from './tree';
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
}

const state = {
  protocols: [] as Manifest[],
  sessions: [] as Session[],
  tabs: [] as Tab[],
  active: null as string | null,
  filter: '',
  folders: [] as string[],
  showFiles: true,
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

function renderTabs() {
  tabsBar.replaceChildren(
    ...state.tabs.map((t) => {
      const selected = t.id === state.active;
      return h('div', { class: `tab${selected ? ' active' : ''}` },
        h('button', { role: 'tab', 'aria-selected': String(selected), class: 'tab-main', onclick: () => activate(t.id) },
          t.kind === 'session' ? h('span', { class: `dot ${t.state === 'connected' ? 'on' : t.state === 'connecting' || t.state === 'reconnecting' ? 'wait' : ''}` }) : icon('puzzle', 14),
          h('span', { class: 'ellipsis' }, t.title),
          t.protocol && badge(t.protocol)),
        h('button', { class: 'icon-btn sm', 'aria-label': `Fermer ${t.title}`, title: 'Fermer (Ctrl Maj W)', onclick: () => closeTab(t.id) }, icon('close', 13)));
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
      tab.term && h('button', { class: 'icon-btn', 'aria-label': 'Rechercher dans le terminal', title: 'Rechercher (Ctrl Maj F)', onclick: () => tab.term?.openSearch() }, icon('search')),
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
    h('span', {}, 'v0.5.0'),
  );
}

function renderViews() {
  for (const t of state.tabs) t.view.hidden = t.id !== state.active;
  views.querySelector('.welcome')?.remove();
  if (!state.tabs.length) {
    views.append(h('div', { class: 'welcome' },
      h('h2', {}, 'Aucune session ouverte'),
      h('p', { class: 'muted' }, 'Choisissez une session à gauche, ou créez-en une.'),
      h('button', { class: 'btn primary', onclick: () => newSession() }, icon('plus', 14), 'Nouvelle session')));
  }
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
  requestAnimationFrame(() => { tab?.term?.refit(); tab?.term?.focus(); });
}

function closeTab(id: string) {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  const [tab] = state.tabs.splice(index, 1);
  tab.term?.dispose();
  tab.view.remove();
  if (state.active === id) state.active = state.tabs[Math.min(index, state.tabs.length - 1)]?.id ?? null;
  renderAll();
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

  const view = h('div', { class: 'term-view' });
  views.append(view);
  const tab: Tab = { id: crypto.randomUUID(), kind: 'session', title: session.name, sessionId: session.id, protocol: session.protocol, view, state: 'connecting' };
  if (proto.fileBrowser) tab.files = new FilePanel(toast);
  tab.term = new TerminalView(view, (s, reason) => {
    tab.state = s;
    if (s === 'closed' && reason && tab.id !== state.active) toast(`${session.name} : ${reason}`, 'error');
    const id = tab.term?.connection;
    if (s === 'connected' && id) tab.files?.attach(id);
    if (s === 'closed') tab.files?.detach();
    renderAll();
  });
  state.tabs.push(tab);
  activate(tab.id);
  await tab.term.connect(session.id, session.name);
}

function reconnect(tab: Tab) {
  tab.term?.reconnectNow();
}

async function reload() {
  try {
    [state.protocols, state.sessions, state.folders] = await Promise.all([api.listProtocols(), api.listSessions(), api.listFolders()]);
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
  const tab: Tab = { id: crypto.randomUUID(), kind: 'extensions', title: 'Extensions', view, state: 'connected' };
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
});

reload();
