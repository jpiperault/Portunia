// Arbre des sessions : dossiers imbriqués, menu contextuel, glisser-déposer.
import { Session } from './api';
import { badge, h, icon } from './dom';
import { MenuItem, showMenu } from './menu';

export interface TreeActions {
  isConnected(sessionId: string): boolean;
  activeSessionId(): string | undefined;
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

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  sessions: Session[];
  /** Nombre total de sessions, sous-dossiers compris. */
  total: number;
}

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
    root.addEventListener('contextmenu', (e) => {
      if (e.target !== root) return;
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [
        { label: 'Nouvelle session', icon: 'plus', action: () => actions.newSession('') },
        { label: 'Nouveau dossier', icon: 'folderPlus', action: () => actions.newFolder('') },
      ]);
    });
  }

  render(folders: string[], sessions: Session[], filter: string) {
    const q = filter.trim().toLowerCase();
    if (!sessions.length && !folders.length) {
      this.root.replaceChildren(h('div', { class: 'empty-tree' },
        h('p', {}, 'Aucune session enregistrée.'),
        h('button', { class: 'btn primary', onclick: () => this.actions.newSession('') }, 'Créer une session')));
      return;
    }
    const tree = build(folders, sessions.filter((s) => matches(s, q)), q);
    const rows = this.renderChildren(tree, 0, q !== '');
    this.root.replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty-tree muted' }, 'Aucun résultat.')]));
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
    const menu = (): (MenuItem | 'separator')[] => [
      { label: 'Nouvelle session ici', icon: 'plus', action: () => a.newSession(folder.path) },
      { label: 'Nouveau sous-dossier', icon: 'folderPlus', action: () => a.newFolder(folder.path) },
      ...(folder.total ? [{ label: `Ouvrir les ${folder.total} session(s)`, icon: 'play', action: () => a.openAll(folder.path) }] : []),
      'separator',
      { label: 'Renommer', icon: 'edit', action: () => a.renameFolder(folder.path) },
      { label: 'Supprimer le dossier', icon: 'trash', danger: true, action: () => a.deleteFolder(folder.path) },
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
        h('button', { class: 'icon-btn sm', 'aria-label': `Nouvelle session dans ${folder.name}`, title: 'Nouvelle session ici', onclick: () => a.newSession(folder.path) }, icon('plus', 14)),
        h('button', { class: 'icon-btn sm', 'aria-label': `Actions du dossier ${folder.name}`, title: 'Plus d\'actions', onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY, menu()) }, icon('more', 14))));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, menu()); });
    this.enableDrag(row, { kind: 'folder', path: folder.path, label: folder.name });
    return open ? [row, ...this.renderChildren(folder, depth + 1, searching)] : [row];
  }

  private renderSession(s: Session, depth: number): HTMLElement {
    const a = this.actions;
    const menu = (): (MenuItem | 'separator')[] => [
      { label: 'Ouvrir', icon: 'play', action: () => a.openSession(s) },
      { label: 'Modifier', icon: 'edit', action: () => a.editSession(s) },
      { label: 'Dupliquer', icon: 'copy', action: () => a.duplicateSession(s) },
      ...(s.folder ? [{ label: 'Sortir du dossier', icon: 'up', action: () => a.moveSessions([s.id], '') }] : []),
      'separator',
      { label: 'Supprimer', icon: 'trash', danger: true, action: () => a.removeSession(s) },
    ];
    const active = a.activeSessionId() === s.id;
    // Déposer sur une session = déposer dans son dossier.
    const row = h('div', { class: `tree-row${active ? ' active' : ''}`, 'data-drop': s.folder },
      h('button', {
        class: 'tree-item session', title: 'Ouvrir', style: `padding-left: ${28 + depth * INDENT}px`,
        onclick: () => { if (!this.justDragged) a.openSession(s); },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'F2') a.editSession(s);
          else if (e.key === 'Delete') a.removeSession(s);
        },
      },
        h('span', { class: `dot${a.isConnected(s.id) ? ' on' : ''}` }),
        h('span', { class: 'grow ellipsis' }, s.name),
        badge(s.protocol)),
      h('div', { class: 'row-actions' },
        h('button', { class: 'icon-btn sm', 'aria-label': `Modifier ${s.name}`, title: 'Modifier', onclick: () => a.editSession(s) }, icon('edit', 14)),
        h('button', { class: 'icon-btn sm', 'aria-label': `Actions de ${s.name}`, title: 'Plus d\'actions', onclick: (e: MouseEvent) => showMenu(e.clientX, e.clientY, menu()) }, icon('more', 14))));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY, menu()); });
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
