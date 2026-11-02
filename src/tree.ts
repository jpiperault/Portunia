// Arbre des sessions : dossiers imbriqués, menu contextuel, glisser-déposer.
import { Session } from './api';
import { badge, h, icon } from './dom';
import { MenuItem, showColorPicker, showMenu } from './menu';
import { FOLDER_COLORS, paint } from './theme';
import { t } from './i18n';

export interface TreeActions {
  isConnected(sessionId: string): boolean;
  /** L'extension du protocole est activée. */
  protocolEnabled(protocol: string): boolean;
  /** Réactive l'extension d'un protocole. */
  enableProtocol(protocol: string): void;
  /** État de supervision : classe CSS (up, down, unknown, off) et infobulle. */
  health(sessionId: string): { cls: string; title: string };
  toggleMonitor(s: Session): void;
  /** Couleur résolue d'un dossier (la sienne ou celle d'un parent). */
  folderColor(path: string): string | undefined;
  /** Couleur propre au dossier (clé de FOLDER_COLORS). */
  colorKey(path: string): string | undefined;
  setFolderColor(path: string, color: string | null): void;
  activeSessionId(): string | undefined;
  /** La session a une note. */
  hasNote(sessionId: string): boolean;
  /** Session épinglée en tête de la liste. */
  isPinned(sessionId: string): boolean;
  togglePin(s: Session): void;
  /** Adresse affichée sous le nom dans les résultats (user@hôte, URL…). */
  target(s: Session): string;
  /** Outils réseau sur l'hôte de la session. */
  /** Session SSH ouverte en fichiers seulement (SFTP, deux volets). */
  openFiles(s: Session): void;
  netTools(s: Session): void;
  /** Wake-on-LAN (adresse MAC de la session). */
  wake(s: Session): void;
  /** Commande sur toutes les sessions SSH du dossier (Pro). */
  multiExec(folder: string): void;
  openSession(s: Session): void;
  editSession(s: Session): void;
  duplicateSession(s: Session): void;
  removeSession(s: Session): void;
  newSession(folder: string): void;
  newFolder(parent: string): void;
  renameFolder(path: string): void;
  deleteFolder(path: string): void;
  openAll(path: string): void;
  moveSessions(ids: string[], folder: string): void;
  /** Déplace un dossier sous `parent` ('' = racine). */
  moveFolder(path: string, parent: string): void;
}

/** Ce qui entoure l'arbre : sections du haut, ou résultats à plat. */
export interface TreeView {
  /** Filtre tapé ou puce active : liste à plat au lieu de l'arbre. */
  narrowed: boolean;
  pinned: Session[];
  recent: { session: Session; at: number }[];
  /** Ligne ajoutée sous les résultats (serveurs des Gates). */
  footer?: HTMLElement | false;
}

interface RowOptions {
  /** Ligne hors de l'arbre : sans retrait. */
  flat?: boolean;
  /** Adresse et dossier sous le nom. */
  sub?: boolean;
  /** Dernière ouverture. */
  when?: string;
}

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  sessions: Session[];
  /** Nombre total de sessions, sous-dossiers compris. */
  total: number;
}

// Clé à l'ancien nom du logiciel, gardée pour retrouver les réglages existants.
const COLLAPSED_KEY = 'termoria.collapsed';
const INDENT = 14;

export class SessionTree {
  private collapsed: Set<string>;
  /** Vrai juste après un glisser : le clic qui suit est ignoré. */
  private justDragged = false;

  constructor(private readonly root: HTMLElement, private readonly actions: TreeActions) {
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'); } catch { /* stockage indisponible */ }
    this.collapsed = new Set(saved);
    // La zone vide de l'arbre = racine (déposer ici sort une session de son dossier).
    root.dataset.drop = '';
    // ↑ ↓ d'une ligne à l'autre ; ↑ sur la première remonte au champ de filtre.
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...root.querySelectorAll<HTMLElement>('.tree-item')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && i === 0) root.dispatchEvent(new CustomEvent('tree-top'));
      else items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
    });
    root.addEventListener('contextmenu', (e) => {
      if (e.target !== root) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: t('New session', 'Nouvelle session'), icon: 'plus', action: () => actions.newSession('') },
        { label: t('New folder', 'Nouveau dossier'), icon: 'folderPlus', action: () => actions.newFolder('') },
      ]);
    });
  }

  /** Première ligne de la liste (↓ depuis le champ de filtre). */
  focusFirst() {
    this.root.querySelector<HTMLElement>('.tree-item')?.focus();
  }

  /** Première session affichée (Entrée dans le champ de filtre). */
  first(): string | undefined {
    return this.root.querySelector<HTMLElement>('.tree-item.session')?.dataset.id;
  }

  render(folders: string[], sessions: Session[], filter: string, view: TreeView = { narrowed: false, pinned: [], recent: [] }) {
    const q = filter.trim().toLowerCase();
    if (view.narrowed || q) {
      this.renderResults(sessions.filter((s) => matches(s, q)), q, view.footer);
      return;
    }
    if (!sessions.length && !folders.length) {
      this.root.replaceChildren(h('div', { class: 'empty-tree' },
        h('p', {}, t('No saved session.', 'Aucune session enregistrée.')),
        h('button', { class: 'btn primary', onclick: () => this.actions.newSession('') }, t('Create a session', 'Créer une session'))));
      return;
    }
    const rows: HTMLElement[] = [];
    if (view.pinned.length) rows.push(section(t('Pinned', 'Épinglées')), ...view.pinned.map((s) => this.renderSession(s, 0, { flat: true })));
    if (view.recent.length) rows.push(section(t('Recent', 'Récentes')), ...view.recent.map(({ session, at }) => this.renderSession(session, 0, { flat: true, when: ago(at) })));
    if (rows.length) rows.push(section(t('All', 'Toutes')));
    rows.push(...this.renderChildren(build(folders, sessions, ''), 0, false));
    this.root.replaceChildren(...rows);
  }

  /** Résultats à plat : le nom d'abord, puis l'adresse et le dossier. */
  private renderResults(found: Session[], q: string, footer?: HTMLElement | false) {
    const first = q.split(/\s+/)[0] ?? '';
    const starts = (s: Session) => (first && s.name.toLowerCase().startsWith(first) ? 0 : 1);
    const live = (s: Session) => (this.actions.isConnected(s.id) ? 0 : 1);
    found.sort((a, b) => starts(a) - starts(b) || live(a) - live(b) || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    const label = found.length
      ? t(`${found.length} result${found.length > 1 ? 's' : ''}`, `${found.length} résultat${found.length > 1 ? 's' : ''}`)
      : t('No session found. Enter on an address: quick connect.', 'Aucune session. Entrée sur une adresse : connexion rapide.');
    this.root.replaceChildren(
      h('div', { class: 'tree-section results' }, label),
      ...found.map((s) => this.renderSession(s, 0, { flat: true, sub: true })),
      ...(footer ? [footer] : []));
  }

  private renderChildren(node: FolderNode, depth: number, searching: boolean): HTMLElement[] {
    return [
      ...node.folders.flatMap((f) => this.renderFolder(f, depth, searching)),
      ...node.sessions.map((s) => this.renderSession(s, depth)),
    ];
  }

  private renderFolder(folder: FolderNode, depth: number, searching: boolean): HTMLElement[] {
    const open = searching || !this.collapsed.has(folder.path);
    const a = this.actions;
    const menu = (x = 0, y = 0): (MenuItem | 'separator')[] => [
      { label: t('New session here', 'Nouvelle session ici'), icon: 'plus', action: () => a.newSession(folder.path) },
      { label: t('New subfolder', 'Nouveau sous-dossier'), icon: 'folderPlus', action: () => a.newFolder(folder.path) },
      ...(folder.total ? [{ label: t(`Open the ${folder.total} session(s)`, `Ouvrir les ${folder.total} session(s)`), icon: 'play', action: () => a.openAll(folder.path) }] : []),
      ...(folder.total ? [{ label: t('Run a command on this folder…', 'Lancer une commande sur ce dossier…'), icon: 'commands', action: () => a.multiExec(folder.path) }] : []),
      'separator',
      { label: t('Rename', 'Renommer'), icon: 'edit', action: () => a.renameFolder(folder.path) },
      { label: t('Colour…', 'Couleur…'), icon: 'palette', action: () => showColorPicker(x, y, a.colorKey(folder.path), FOLDER_COLORS, (c) => a.setFolderColor(folder.path, c)) },
      { label: t('Delete the folder', 'Supprimer le dossier'), icon: 'trash', danger: true, action: () => a.deleteFolder(folder.path) },
    ];
    const row = h('div', { class: 'tree-row folder-row', 'data-drop': folder.path },
      h('button', {
        class: 'tree-item group-head', 'aria-expanded': String(open), style: `padding-left: ${10 + depth * INDENT}px`,
        title: folder.path,
        onclick: () => { if (this.justDragged) return; this.toggle(folder.path); },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'ArrowRight' && !open) this.toggle(folder.path);
          else if (e.key === 'ArrowLeft' && open) this.toggle(folder.path);
          else if (e.key === 'F2') a.renameFolder(folder.path);
          else if (e.key === 'Delete') a.deleteFolder(folder.path);
        },
      },
        icon(open ? 'chevronDown' : 'chevronRight', 12),
        h('span', { class: 'folder-ico' }, icon('folder', 14)),
        h('span', { class: 'grow ellipsis' }, folder.name),
        h('span', { class: 'count' }, String(folder.total))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'icon-btn sm', 'aria-label': t(`New session in ${folder.name}`, `Nouvelle session dans ${folder.name}`), title: t('New session here', 'Nouvelle session ici'), onclick: () => a.newSession(folder.path) }, icon('plus', 14)),
        h('button', { class: 'icon-btn sm', 'aria-label': t(`Actions for folder ${folder.name}`, `Actions du dossier ${folder.name}`), title: t('More actions', 'Plus d\'actions'), onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY, menu(e.clientX, e.clientY)) }, icon('more', 14))));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, menu(e.clientX, e.clientY)); });
    paint(row, a.folderColor(folder.path));
    this.enableDrag(row, { kind: 'folder', path: folder.path, label: folder.name });
    return open ? [row, ...this.renderChildren(folder, depth + 1, searching)] : [row];
  }

  private renderSession(s: Session, depth: number, opts: RowOptions = {}): HTMLElement {
    const a = this.actions;
    const enabled = a.protocolEnabled(s.protocol);
    const pinned = a.isPinned(s.id);
    const menu = (): (MenuItem | 'separator')[] => [
      ...(enabled ? [] : [{ label: t('Enable the extension', 'Activer l’extension'), icon: 'puzzle', action: () => a.enableProtocol(s.protocol) }, 'separator' as const]),
      { label: t('Open', 'Ouvrir'), icon: 'play', action: () => a.openSession(s) },
      ...(s.protocol === 'ssh' ? [{ label: t('Open as files only (SFTP)', 'Ouvrir en fichiers seulement (SFTP)'), icon: 'files', action: () => a.openFiles(s) }] : []),
      { label: pinned ? t('Unpin', 'Désépingler') : t('Pin to the top', 'Épingler en haut'), icon: 'star', action: () => a.togglePin(s) },
      { label: t('Edit', 'Modifier'), icon: 'edit', action: () => a.editSession(s) },
      { label: t('Duplicate', 'Dupliquer'), icon: 'copy', action: () => a.duplicateSession(s) },
      { label: t('Ping, traceroute, ports…', 'Ping, traceroute, ports…'), icon: 'broadcast', action: () => a.netTools(s) },
      ...(typeof s.values.mac === 'string' && s.values.mac.trim() ? [{ label: t('Wake up (Wake-on-LAN)', 'Réveiller (Wake-on-LAN)'), icon: 'power', action: () => a.wake(s) }] : []),
      { label: a.health(s.id).cls === 'off' ? t('Monitor this server', 'Surveiller ce serveur') : t('Do not monitor this server', 'Ne pas surveiller ce serveur'), icon: 'broadcast', action: () => a.toggleMonitor(s) },
      ...(s.folder ? [{ label: t('Move out of the folder', 'Sortir du dossier'), icon: 'up', action: () => a.moveSessions([s.id], '') }] : []),
      'separator',
      { label: t('Delete', 'Supprimer'), icon: 'trash', danger: true, action: () => a.removeSession(s) },
    ];
    const active = a.activeSessionId() === s.id;
    // Déposer sur une session = déposer dans son dossier.
    const row = h('div', { class: `tree-row${active ? ' active' : ''}${enabled ? '' : ' disabled'}`, 'data-drop': s.folder },
      h('button', {
        class: 'tree-item session', 'data-id': s.id, title: enabled ? t('Open', 'Ouvrir') : t('Extension disabled (right-click › Enable the extension)', 'Extension désactivée (clic droit › Activer l’extension)'), style: `padding-left: ${opts.flat ? 10 : 28 + depth * INDENT}px`,
        onclick: () => { if (!this.justDragged) a.openSession(s); },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'F2') a.editSession(s);
          else if (e.key === 'Delete') a.removeSession(s);
        },
      },
        h('span', { class: `dot${a.isConnected(s.id) ? ' on' : ''} ${a.health(s.id).cls}`, title: a.health(s.id).title }),
        opts.sub
          ? h('span', { class: 'grow session-names' }, h('span', { class: 'ellipsis' }, s.name),
            h('span', { class: 'session-sub ellipsis' }, [a.target(s), s.folder.split('/').join(' › ')].filter(Boolean).join(' · ')))
          : h('span', { class: 'grow ellipsis' }, s.name),
        a.hasNote(s.id) && h('span', { class: 'note-mark', title: t('This session has a note', 'Cette session a une note') }, icon('edit', 12)),
        pinned && !opts.flat && h('span', { class: 'pin-mark', title: t('Pinned', 'Épinglée') }, icon('star', 11)),
        opts.when && h('span', { class: 'when' }, opts.when),
        badge(s.protocol)),
      h('div', { class: 'row-actions' },
        h('button', { class: `icon-btn sm${pinned ? ' on' : ''}`, 'aria-label': pinned ? t(`Unpin ${s.name}`, `Désépingler ${s.name}`) : t(`Pin ${s.name}`, `Épingler ${s.name}`), title: pinned ? t('Unpin', 'Désépingler') : t('Pin to the top', 'Épingler en haut'), onclick: () => a.togglePin(s) }, icon('star', 14)),
        h('button', { class: 'icon-btn sm', 'aria-label': t(`Edit ${s.name}`, `Modifier ${s.name}`), title: t('Edit', 'Modifier'), onclick: () => a.editSession(s) }, icon('edit', 14)),
        h('button', { class: 'icon-btn sm', 'aria-label': `Actions de ${s.name}`, title: t('More actions', 'Plus d\'actions'), onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY, menu()) }, icon('more', 14))));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, menu()); });
    paint(row, a.folderColor(s.folder));
    this.enableDrag(row, { kind: 'session', id: s.id, folder: s.folder, label: s.name });
    return row;
  }

  private toggle(path: string) {
    if (this.collapsed.has(path)) this.collapsed.delete(path);
    else this.collapsed.add(path);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...this.collapsed])); } catch { /* ignoré */ }
    // Le rendu est relancé par l'appelant via render() : on simule un clic de rafraîchissement.
    this.root.dispatchEvent(new CustomEvent('tree-change'));
  }

  /**
   * Glisser-déposer à la souris. On n'utilise pas le drag & drop HTML5 :
   * sous Windows, il est réservé au dépôt de fichiers depuis l'Explorateur.
   */
  private enableDrag(
    row: HTMLElement,
    item: { kind: 'session'; id: string; folder: string; label: string } | { kind: 'folder'; path: string; label: string },
  ) {
    row.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || (down.target as HTMLElement).closest('.row-actions')) return;
      let ghost: HTMLElement | null = null;
      let target: HTMLElement | null = null;

      const accepts = (dest: string) =>
        item.kind === 'session'
          ? dest !== item.folder
          : dest !== item.path && !dest.startsWith(`${item.path}/`) && dest !== parentOf(item.path);

      const move = (e: PointerEvent) => {
        if (!ghost) {
          if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 6) return;
          ghost = h('div', { class: 'drag-ghost' }, icon(item.kind === 'folder' ? 'folder' : 'terminal', 13), item.label);
          document.body.append(ghost);
          document.body.classList.add('dragging');
        }
        ghost.style.left = `${e.clientX + 14}px`;
        ghost.style.top = `${e.clientY + 6}px`;
        const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-drop]') ?? null;
        const next = over && accepts(over.dataset.drop ?? '') ? over : null;
        if (next !== target) {
          target?.classList.remove('drop-target');
          target = next;
          target?.classList.add('drop-target');
        }
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        if (!ghost) return;
        ghost.remove();
        document.body.classList.remove('dragging');
        target?.classList.remove('drop-target');
        this.justDragged = true;
        setTimeout(() => { this.justDragged = false; }, 0);
        if (!target) return;
        const dest = target.dataset.drop ?? '';
        if (item.kind === 'session') this.actions.moveSessions([item.id], dest);
        else this.actions.moveFolder(item.path, dest);
        if (dest) { this.collapsed.delete(dest); }
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
    });
  }
}

const section = (label: string) => h('div', { class: 'tree-section' }, label);

/** « 5 min », « 3 h », « hier », « 12 j ». */
function ago(at: number): string {
  const min = Math.max(1, Math.round((Date.now() - at) / 60000));
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${Math.round(min / 60)} h`;
  if (min < 2880) return t('yesterday', 'hier');
  return t(`${Math.round(min / 1440)} d`, `${Math.round(min / 1440)} j`);
}

export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const leafOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function matches(s: Session, q: string) {
  if (!q) return true;
  const hay = [s.name, s.folder, s.protocol, ...s.tags, ...Object.values(s.values).map(String)].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** Construit l'arbre ; pendant une recherche, seuls les dossiers utiles restent. */
function build(folders: string[], sessions: Session[], q: string): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], sessions: [], total: 0 };
  const index = new Map<string, FolderNode>([['', root]]);
  const ensure = (path: string): FolderNode => {
    const existing = index.get(path);
    if (existing) return existing;
    const parent = ensure(parentOf(path));
    const node: FolderNode = { name: leafOf(path), path, folders: [], sessions: [], total: 0 };
    parent.folders.push(node);
    index.set(path, node);
    return node;
  };
  if (!q) folders.forEach(ensure);
  else folders.filter((f) => leafOf(f).toLowerCase().includes(q)).forEach(ensure);
  for (const s of sessions) ensure(s.folder).sessions.push(s);

  const finish = (node: FolderNode): number => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    node.sessions.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    node.total = node.sessions.length + node.folders.reduce((n, f) => n + finish(f), 0);
    return node.total;
  };
  finish(root);
  return root;
}
