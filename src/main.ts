import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { api, errorText, Manifest, Session } from './api';
import { badge, h, icon } from './dom';
import { openSessionDialog } from './dialog';
import { renderExtensions } from './extensions';
import { TerminalView, TermState } from './terminal';

interface Tab {
  id: string;
  kind: 'session' | 'extensions';
  title: string;
  sessionId?: string;
  protocol?: string;
  view: HTMLElement;
  term?: TerminalView;
  state: TermState;
}

const state = {
  protocols: [] as Manifest[],
  sessions: [] as Session[],
  tabs: [] as Tab[],
  active: null as string | null,
  filter: '',
  collapsed: new Set<string>(),
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const tree = $('tree');
const tabsBar = $('tabs');
const toolbar = $('toolbar');
const views = $('views');
const details = $('details');
const statusBar = $('status');
const search = $<HTMLInputElement>('search');

const NO_FOLDER = 'Sans dossier';
const protocolOf = (id?: string) => state.protocols.find((p) => p.id === id);
const sessionOf = (id?: string) => state.sessions.find((s) => s.id === id);
const activeTab = () => state.tabs.find((t) => t.id === state.active);
const folders = () => [...new Set(state.sessions.map((s) => s.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const isConnected = (sessionId: string) => state.tabs.some((t) => t.sessionId === sessionId && t.state === 'connected');

function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

// ---------- Arbre des sessions ----------

function matches(s: Session, q: string) {
  if (!q) return true;
  const hay = [s.name, s.folder, s.protocol, ...s.tags, ...Object.values(s.values).map(String)].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function renderTree() {
  const q = state.filter.trim().toLowerCase();
  const groups = new Map<string, Session[]>();
  for (const s of state.sessions.filter((s) => matches(s, q))) {
    const key = s.folder || NO_FOLDER;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const names = [...groups.keys()].sort((a, b) => (a === NO_FOLDER ? 1 : b === NO_FOLDER ? -1 : a.localeCompare(b)));

  if (!state.sessions.length) {
    tree.replaceChildren(h('div', { class: 'empty-tree' },
      h('p', {}, 'Aucune session enregistrée.'),
      h('button', { class: 'btn primary', onclick: () => newSession() }, 'Créer une session')));
    return;
  }
  if (!names.length) {
    tree.replaceChildren(h('p', { class: 'empty-tree muted' }, 'Aucun résultat.'));
    return;
  }

  tree.replaceChildren(...names.map((folder) => {
    const open = q !== '' || !state.collapsed.has(folder);
    const items = groups.get(folder)!.sort((a, b) => a.name.localeCompare(b.name));
    return h('div', { class: 'group' },
      h('button', {
        class: 'tree-item group-head', 'aria-expanded': String(open),
        onclick: () => { state.collapsed.has(folder) ? state.collapsed.delete(folder) : state.collapsed.add(folder); renderTree(); },
      }, icon(open ? 'chevronDown' : 'chevronRight', 12), h('span', { class: 'grow' }, folder), h('span', { class: 'count' }, String(items.length))),
      open && h('div', { class: 'group-items' }, ...items.map((s) => {
        const tab = state.tabs.find((t) => t.sessionId === s.id);
        return h('div', { class: `tree-row${tab && tab.id === state.active ? ' active' : ''}` },
          h('button', { class: 'tree-item session', title: 'Ouvrir', onclick: () => openSession(s) },
            h('span', { class: `dot${isConnected(s.id) ? ' on' : ''}` }),
            h('span', { class: 'grow ellipsis' }, s.name),
            badge(s.protocol)),
          h('div', { class: 'row-actions' },
            h('button', { class: 'icon-btn sm', 'aria-label': `Modifier ${s.name}`, title: 'Modifier', onclick: () => editSession(s) }, icon('edit', 14)),
            h('button', { class: 'icon-btn sm', 'aria-label': `Supprimer ${s.name}`, title: 'Supprimer', onclick: () => removeSession(s) }, icon('trash', 14))));
      })));
  }));
}

// ---------- Onglets ----------

function renderTabs() {
  tabsBar.replaceChildren(
    ...state.tabs.map((t) => {
      const selected = t.id === state.active;
      return h('div', { class: `tab${selected ? ' active' : ''}` },
        h('button', { role: 'tab', 'aria-selected': String(selected), class: 'tab-main', onclick: () => activate(t.id) },
          t.kind === 'session' ? h('span', { class: `dot ${t.state === 'connected' ? 'on' : t.state === 'connecting' ? 'wait' : ''}` }) : icon('puzzle', 14),
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
  const label = { connecting: 'connexion…', connected: 'connecté', closed: 'déconnecté' }[tab.state];
  toolbar.replaceChildren(
    h('div', { class: 'toolbar-info' },
      icon('terminal'), h('strong', {}, target || session.name),
      session.folder && h('span', { class: 'muted' }, `· ${session.folder}`),
      h('span', { class: 'muted' }, `· ${label}`)),
    h('div', { class: 'toolbar-actions' },
      tab.state === 'closed' && h('button', { class: 'btn', onclick: () => reconnect(tab) }, icon('refresh', 14), 'Reconnecter'),
      tab.state === 'connected' && h('button', { class: 'btn', onclick: () => closeTab(tab.id) }, icon('power', 14), 'Déconnecter'),
      h('button', { class: 'btn', onclick: () => editSession(session) }, icon('edit', 14), 'Modifier')),
  );
}

function renderDetails() {
  const session = sessionOf(activeTab()?.sessionId);
  const proto = protocolOf(session?.protocol);
  if (!session || !proto) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  const rows = proto.fields
    .filter((f) => f.kind.type !== 'secret' && session.values[f.key] != null && session.values[f.key] !== '')
    .flatMap((f) => {
      let value = session.values[f.key];
      if (f.kind.type === 'choice') value = f.kind.options.find((o) => o.value === value)?.label ?? value;
      if (f.kind.type === 'bool') value = value ? 'Oui' : 'Non';
      return [h('dt', {}, f.label), h('dd', {}, String(value))];
    });
  details.replaceChildren(
    h('h2', {}, session.name),
    h('p', { class: 'muted' }, proto.name),
    h('dl', {}, ...rows),
    ...(session.tags.length ? [h('div', { class: 'chips' }, ...session.tags.map((t) => h('span', { class: 'chip' }, t)))] : []),
    h('p', { class: 'muted small foot' }, `Fourni par l'extension ${proto.name} ${proto.version}`),
  );
}

function renderStatus() {
  const open = state.tabs.filter((t) => t.kind === 'session' && t.state === 'connected').length;
  statusBar.replaceChildren(
    h('span', {}, h('span', { class: `dot${open ? ' on' : ''}` }), `${open} session(s) connectée(s)`),
    h('span', {}, `${state.sessions.length} enregistrée(s)`),
    h('span', { class: 'push' }, `${state.protocols.length} extensions`),
    h('span', {}, 'v0.2.0'),
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
  renderDetails();
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
  tab.term = new TerminalView(view, (s, reason) => {
    tab.state = s;
    if (s === 'closed' && reason && tab.id !== state.active) toast(`${session.name} : ${reason}`, 'error');
    renderAll();
  });
  state.tabs.push(tab);
  activate(tab.id);
  await tab.term.connect(session.id, session.name);
}

function reconnect(tab: Tab) {
  const session = sessionOf(tab.sessionId);
  if (!session || !tab.term) return;
  tab.term.term.reset();
  tab.term.connect(session.id, session.name);
}

async function reload() {
  try {
    [state.protocols, state.sessions] = await Promise.all([api.listProtocols(), api.listSessions()]);
  } catch (e) {
    toast(errorText(e), 'error');
  }
  for (const t of state.tabs) {
    const s = sessionOf(t.sessionId);
    if (s) t.title = s.name;
  }
  renderAll();
}

async function newSession() {
  const result = await openSessionDialog({ protocols: state.protocols, folders: folders() });
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

$('new-session').append(icon('plus'));
$('new-session').addEventListener('click', () => newSession());
$('open-extensions').append(icon('puzzle'), h('span', { class: 'grow' }, 'Extensions'));
$('open-extensions').addEventListener('click', openExtensions);
search.addEventListener('input', () => { state.filter = search.value; renderTree(); });

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || document.querySelector('dialog[open]')) return;
  const key = e.key.toLowerCase();
  if (key === 'k') { e.preventDefault(); search.focus(); search.select(); }
  else if (key === 'n') { e.preventDefault(); newSession(); }
  else if (key === 'w' && state.active) { e.preventDefault(); closeTab(state.active); }
});

reload();
