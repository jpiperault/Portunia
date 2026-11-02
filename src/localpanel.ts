// Volet « Ce PC » d'une session de fichiers à deux volets.
import { api, errorText, RemoteEntry } from './api';
import { h, icon } from './dom';
import { formatDate, formatSize, Selection } from './files';
import { t } from './i18n';

/** Marque « caché » (attribut Windows) transmise par le cœur dans `permissions`. */
const HIDDEN = 0x8000_0000;

export const localJoin = (dir: string, name: string) => (/[\\/]$/.test(dir) ? dir + name : `${dir}\\${name}`);
/** « C:\Users\moi » → « C:\Users » ; « C:\ » → « » (liste des lecteurs). */
const localParent = (path: string) => (/^[A-Za-z]:\\?$/.test(path) ? '' : path.replace(/[\\/][^\\/]+[\\/]?$/, '').replace(/^([A-Za-z]:)$/, '$1\\'));

export class LocalPanel {
  readonly el = h('div', { class: 'files dual local' });
  private cwd = '';
  private entries: RemoteEntry[] = [];
  private readonly selection = new Selection();
  private loading = false;
  private error = '';
  showHidden = false;

  constructor(
    private readonly toast: (msg: string, kind?: 'info' | 'error') => void,
    /** Envoyer ces éléments dans le dossier ouvert sur le serveur. */
    private readonly transfer: (entries: RemoteEntry[]) => void,
  ) {
    this.render();
  }

  get dir(): string { return this.cwd; }
  get listed(): RemoteEntry[] { return this.entries; }
  get picked(): RemoteEntry[] { return this.selection.of(this.visible()); }

  private visible(): RemoteEntry[] {
    return this.showHidden ? this.entries : this.entries.filter((e) => !e.name.startsWith('.') && !((e.permissions ?? 0) & HIDDEN));
  }

  async start(dir?: string) {
    await this.load(await api.localHome(dir));
  }

  refreshIf(dir: string) {
    if (dir === this.cwd) this.load(this.cwd);
  }

  toggleHidden(on: boolean) {
    this.showHidden = on;
    this.render();
  }

  async load(path: string) {
    this.loading = true;
    this.error = '';
    this.render();
    try {
      this.entries = await api.localList(path);
      this.cwd = path;
      this.selection.clear();
    } catch (e) {
      this.error = errorText(e);
    }
    this.loading = false;
    this.render();
  }

  focusList() {
    (this.el.querySelector<HTMLElement>('.file-row.selected .file-main') ?? this.el.querySelector<HTMLElement>('.file-main'))?.focus();
  }

  private async mkdir() {
    const name = prompt(t('Name of the new folder:', 'Nom du nouveau dossier :'))?.trim();
    if (!name || !this.cwd) return;
    await this.run(() => api.localMkdir(localJoin(this.cwd, name)));
  }

  private async rename(entry: RemoteEntry) {
    const name = prompt(t('New name:', 'Nouveau nom :'), entry.name)?.trim();
    if (!name || name === entry.name) return;
    await this.run(() => api.localRename(entry.path, localJoin(this.cwd, name)));
  }

  private async run(action: () => Promise<void>) {
    try {
      await action();
    } catch (e) {
      this.toast(errorText(e), 'error');
    }
    await this.load(this.cwd);
  }

  private reveal(path: string) {
    api.localReveal(path).catch((e) => this.toast(errorText(e), 'error'));
  }

  private open(entry: RemoteEntry) {
    if (entry.isDir) this.load(entry.path);
    else this.transfer([entry]);
  }

  private render() {
    const drives = this.cwd === '';
    const btn = (name: string, label: string, onclick: () => void, disabled = false) =>
      h('button', { class: 'icon-btn sm', 'aria-label': label, title: label, disabled, onclick }, icon(name, 15));
    const pathInput = h('input', {
      class: 'files-path', type: 'text', value: this.cwd, placeholder: t('Drives', 'Lecteurs'), spellcheck: 'false', 'aria-label': t('Folder of this PC', 'Dossier de ce PC'),
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.load((e.target as HTMLInputElement).value.trim()); },
    });
    this.el.replaceChildren(
      h('div', { class: 'files-head' },
        h('strong', {}, t('This PC', 'Ce PC')), h('span', { class: 'grow' }),
        btn('drive', t('Drives', 'Lecteurs'), () => this.load(''), drives),
        btn('home', t('My user folder', 'Mon dossier utilisateur'), async () => this.load(await api.localHome())),
        btn('up', t('Parent folder', 'Dossier parent'), () => this.load(localParent(this.cwd)), drives),
        btn('refresh', t('Refresh', 'Actualiser'), () => this.load(this.cwd)),
        btn('folderPlus', t('New folder', 'Nouveau dossier'), () => this.mkdir(), drives),
        btn('reveal', t('Show in the Windows Explorer', 'Afficher dans l\'Explorateur Windows'), () => this.reveal(this.picked[0]?.path ?? this.cwd), drives && !this.picked.length)),
      pathInput,
      this.renderList(),
    );
  }

  private renderList(): HTMLElement {
    const list = h('div', { class: 'files-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': t('Files of this PC', 'Fichiers de ce PC') });
    if (this.error) {
      list.append(h('p', { class: 'files-msg error' }, this.error));
      return list;
    }
    if (this.loading && !this.entries.length) {
      list.append(h('p', { class: 'files-msg muted' }, t('Loading…', 'Chargement…')));
      return list;
    }
    list.addEventListener('keydown', (e) => {
      if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); this.selection.all(this.visible()); this.render(); this.focusList(); }
    });
    const shown = this.visible();
    if (!shown.length) list.append(h('p', { class: 'files-msg muted' }, t('Empty folder.', 'Dossier vide.')));
    for (const entry of shown) {
      const selected = this.selection.has(entry.path);
      const drive = this.cwd === '';
      list.append(
        h('div', { class: `file-row${selected ? ' selected' : ''}` },
          h('button', {
            class: 'file-main', role: 'option', 'aria-selected': String(selected),
            title: entry.isDir ? t('Double-click to open', 'Double-clic pour ouvrir') : t('Double-click to upload to the server', 'Double-clic pour envoyer sur le serveur'),
            onclick: (e: MouseEvent) => { this.selection.click(entry, shown, e); this.render(); this.focusRow(shown, entry.path); },
            ondblclick: () => this.open(entry),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter') this.open(entry);
              else if (e.key === 'F2' && !drive) this.rename(entry);
              else if (e.key === 'Backspace') this.load(localParent(this.cwd));
            },
          },
            h('span', { class: `file-ico${entry.isDir ? ' dir' : ''}` }, icon(drive ? 'drive' : entry.isDir ? 'folder' : entry.isLink ? 'link' : 'file', 16)),
            h('span', { class: 'grow ellipsis' }, entry.name),
            h('span', { class: 'file-meta' }, entry.isDir ? '' : formatSize(entry.size)),
            h('span', { class: 'file-meta date' }, formatDate(entry.modified))),
          !drive && h('div', { class: 'row-actions' },
            h('button', { class: 'icon-btn sm', 'aria-label': t(`Upload ${entry.name}`, `Envoyer ${entry.name}`), title: t('Upload to the folder open on the server (F5)', 'Envoyer dans le dossier ouvert sur le serveur (F5)'), onclick: () => this.transfer([entry]) }, icon('upload', 14)),
            h('button', { class: 'icon-btn sm', 'aria-label': t(`Rename ${entry.name}`, `Renommer ${entry.name}`), title: t('Rename (F2)', 'Renommer (F2)'), onclick: () => this.rename(entry) }, icon('edit', 14)),
            h('button', { class: 'icon-btn sm', 'aria-label': t(`Show ${entry.name} in the Explorer`, `Afficher ${entry.name} dans l'Explorateur`), title: t('Show in the Windows Explorer', 'Afficher dans l\'Explorateur Windows'), onclick: () => this.reveal(entry.path) }, icon('reveal', 14)))),
      );
    }
    return list;
  }

  private focusRow(shown: RemoteEntry[], path: string) {
    const i = shown.findIndex((e) => e.path === path);
    this.el.querySelectorAll<HTMLElement>('.file-row .file-main')[i]?.focus();
  }
}
