// Explorateur de fichiers côté serveur : panneau des onglets SSH (SFTP), ou onglet entier (FTP, S3…).
import { open, save } from '@tauri-apps/plugin-dialog';
import { api, errorText, remoteFiles, RemoteEntry } from './api';
import { h, icon } from './dom';
import { LOCALE, t } from './i18n';

/** Fichier distant ouvert dans un éditeur local. */
interface Editing {
  id: string;
  name: string;
  path: string;
  status: string;
  error?: boolean;
}

interface Transfer {
  name: string;
  direction: 'up' | 'down';
  done: number;
  total: number;
  state: 'waiting' | 'running' | 'done' | 'error';
  error?: string;
}

const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const parent = (path: string) => (path === '/' ? '/' : path.replace(/\/[^/]+\/?$/, '') || '/');
const baseName = (localPath: string) => localPath.split(/[\\/]/).pop() ?? localPath;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toLocaleString(LOCALE, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[i]}`;
}

const formatDate = (secs: number | null) =>
  secs == null ? '' : new Date(secs * 1000).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' });

export class FilePanel {
  readonly el = h('div', { class: 'files' });
  private connectionId: string | null = null;
  private cwd = '';
  private entries: RemoteEntry[] = [];
  private selected: string | null = null;
  private loading = false;
  private error = '';
  private transfers: Transfer[] = [];
  private queue: Promise<void> = Promise.resolve();
  private dropping = false;
  private editing: Editing[] = [];

  constructor(
    private readonly toast: (msg: string, kind?: 'info' | 'error') => void,
    /** Protocole affiché dans l'en-tête (SFTP, FTPS, S3…). */
    private readonly protocolLabel = 'SFTP',
  ) {
    this.render();
  }

  /** Nouvelle connexion (ou reconnexion) : on garde le dossier courant. */
  async attach(connectionId: string) {
    this.connectionId = connectionId;
    try {
      if (!this.cwd) this.cwd = await api.fsHome(connectionId);
      await this.load(this.cwd);
    } catch (e) {
      this.error = errorText(e);
      this.render();
    }
  }

  detach() {
    for (const e of this.editing) { e.status = t('Session closed: sync stopped', 'Session fermée : synchronisation arrêtée'); e.error = true; }
    this.connectionId = null;
    this.render();
  }

  async load(path: string) {
    if (!this.connectionId) return;
    this.loading = true;
    this.error = '';
    this.render();
    try {
      this.entries = await api.fsList(this.connectionId, path);
      this.cwd = path;
      this.selected = null;
    } catch (e) {
      this.error = errorText(e);
    }
    this.loading = false;
    this.render();
  }

  setDropping(on: boolean) {
    if (this.dropping !== on) { this.dropping = on; this.render(); }
  }

  /** Fichiers glissés depuis l'Explorateur Windows. */
  uploadPaths(paths: string[]) {
    if (!this.connectionId || !paths.length) return;
    const existing = new Set(this.entries.map((e) => e.name));
    const clashes = paths.map(baseName).filter((n) => existing.has(n));
    if (clashes.length && !confirm(t(`Replace on the server: ${clashes.join(', ')}?`, `Remplacer sur le serveur : ${clashes.join(', ')} ?`))) return;
    const dir = this.cwd;
    const id = this.connectionId;
    // Fichiers ou dossiers entiers (le cœur détecte les dossiers).
    for (const local of paths) {
      this.enqueue({ name: baseName(local), direction: 'up' }, async (cb) => { await remoteFiles.uploadAny(id, local, dir, cb); }, dir);
    }
  }

  private async pickUpload(directory = false) {
    const picked = await open({ multiple: true, directory, title: directory ? t('Upload folders to the server', 'Envoyer des dossiers vers le serveur') : t('Upload to the server', 'Envoyer vers le serveur') });
    if (picked) this.uploadPaths(Array.isArray(picked) ? picked : [picked]);
  }

  private async download(entry: RemoteEntry) {
    if (!this.connectionId) return;
    const id = this.connectionId;
    if (entry.isDir) {
      const parent = await open({ directory: true, multiple: false, title: t(`Download the folder « ${entry.name} » to…`, `Télécharger le dossier « ${entry.name} » dans…`) });
      if (typeof parent !== 'string') return;
      const local = `${parent.replace(/[\\/]$/, '')}\\${entry.name.replace(/[<>:"/\\|?*]/g, '_')}`;
      this.enqueue({ name: `${entry.name}/`, direction: 'down' }, async (cb) => { await remoteFiles.downloadDir(id, entry.path, local, cb); });
      return;
    }
    const local = await save({ defaultPath: entry.name, title: t('Download from the server', 'Télécharger depuis le serveur') });
    if (!local) return;
    this.enqueue({ name: entry.name, direction: 'down' }, (cb) => api.fsDownload(id, entry.path, local, cb));
  }

  /** Ouvre le fichier dans l'éditeur de Windows ; chaque enregistrement repart sur le serveur. */
  private async edit(entry: RemoteEntry) {
    if (!this.connectionId || entry.isDir) return;
    if (entry.size > 20 * 1024 * 1024 && !confirm(t(`« ${entry.name} » is ${formatSize(entry.size)}. Open it in an editor anyway?`, `« ${entry.name} » fait ${formatSize(entry.size)}. L'ouvrir quand même dans un éditeur ?`))) return;
    const edit: Editing = { id: '', name: entry.name, path: entry.path, status: t('Opening…', 'Ouverture…') };
    this.editing.push(edit);
    this.render();
    try {
      edit.id = await remoteFiles.editStart(this.connectionId, entry.path, (e) => {
        edit.status = e.type === 'uploaded'
          ? t(`Uploaded at ${new Date(e.at * 1000).toLocaleTimeString(LOCALE)}`, `Envoyé à ${new Date(e.at * 1000).toLocaleTimeString(LOCALE)}`)
          : t(`Upload failed: ${e.message}`, `Échec de l'envoi : ${e.message}`);
        edit.error = e.type === 'error';
        if (e.type === 'error') this.toast(`${entry.name} : ${e.message}`, 'error');
        this.renderTransfers();
      });
      edit.status = t('Open: save in the editor to upload', 'Ouvert : enregistrez dans l’éditeur pour envoyer');
    } catch (e) {
      edit.status = errorText(e);
      edit.error = true;
      this.toast(errorText(e), 'error');
    }
    this.renderTransfers();
  }

  private stopEdit(edit: Editing) {
    if (edit.id) remoteFiles.editStop(edit.id).catch(() => {});
    this.editing = this.editing.filter((x) => x !== edit);
    this.renderTransfers();
  }

  /** Transferts l'un après l'autre, avec leur avancement. */
  private enqueue(
    info: Pick<Transfer, 'name' | 'direction'>,
    run: (cb: (p: { done: number; total: number }) => void) => Promise<void>,
    refreshDir?: string,
  ) {
    const t: Transfer = { ...info, done: 0, total: 0, state: 'waiting' };
    this.transfers.unshift(t);
    this.transfers = this.transfers.slice(0, 20);
    this.render();
    this.queue = this.queue.then(async () => {
      t.state = 'running';
      this.render();
      try {
        await run((p) => { t.done = p.done; t.total = p.total; this.renderTransfers(); });
        t.state = 'done';
        if (refreshDir && refreshDir === this.cwd) await this.load(this.cwd);
      } catch (e) {
        t.state = 'error';
        t.error = errorText(e);
        this.toast(`${t.name} : ${t.error}`, 'error');
      }
      this.render();
    });
  }

  private async mkdir() {
    const name = prompt(t('Name of the new folder:', 'Nom du nouveau dossier :'))?.trim();
    if (!name || !this.connectionId) return;
    await this.run(() => api.fsMkdir(this.connectionId!, join(this.cwd, name)));
  }

  private async rename(entry: RemoteEntry) {
    const name = prompt(t('New name:', 'Nouveau nom :'), entry.name)?.trim();
    if (!name || name === entry.name || !this.connectionId) return;
    await this.run(() => api.fsRename(this.connectionId!, entry.path, join(this.cwd, name)));
  }

  private async remove(entry: RemoteEntry) {
    const what = entry.isDir && !entry.isLink ? t(`the folder « ${entry.name} » and ALL its content`, `le dossier « ${entry.name} » et TOUT son contenu`) : `« ${entry.name} »`;
    if (!this.connectionId || !confirm(t(`Permanently delete ${what} on the server?`, `Supprimer définitivement ${what} sur le serveur ?`))) return;
    await this.run(() => api.fsRemove(this.connectionId!, entry.path, entry.isDir && !entry.isLink));
  }

  private async run(action: () => Promise<void>) {
    try {
      await action();
    } catch (e) {
      this.toast(errorText(e), 'error');
    }
    await this.load(this.cwd);
  }

  private openEntry(entry: RemoteEntry) {
    if (entry.isDir) this.load(entry.path);
    else this.download(entry);
  }

  // ---------- Affichage ----------

  private render() {
    const connected = this.connectionId !== null;
    const btn = (name: string, label: string, onclick: () => void, disabled = !connected) =>
      h('button', { class: 'icon-btn sm', 'aria-label': label, title: label, disabled, onclick }, icon(name, 15));

    const pathInput = h('input', {
      class: 'files-path', type: 'text', value: this.cwd, spellcheck: 'false', 'aria-label': t('Current folder', 'Dossier courant'), disabled: !connected,
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.load((e.target as HTMLInputElement).value.trim() || '/'); },
    });

    this.el.replaceChildren(
      h('div', { class: 'files-head' },
        h('strong', {}, t('Files', 'Fichiers')), h('span', { class: 'muted small grow' }, this.protocolLabel),
        btn('home', t('Home folder', 'Dossier personnel'), async () => { if (this.connectionId) this.load(await api.fsHome(this.connectionId)); }),
        btn('up', t('Parent folder', 'Dossier parent'), () => this.load(parent(this.cwd))),
        btn('refresh', t('Refresh', 'Actualiser'), () => this.load(this.cwd)),
        btn('folderPlus', t('New folder', 'Nouveau dossier'), () => this.mkdir()),
        btn('upload', t('Upload files', 'Envoyer des fichiers'), () => this.pickUpload()),
        btn('folderUp', t('Upload a folder', 'Envoyer un dossier'), () => this.pickUpload(true))),
      pathInput,
      this.renderList(connected),
      h('div', { class: 'transfers' }),
    );
    this.renderTransfers();
  }

  private renderList(connected: boolean): HTMLElement {
    const list = h('div', { class: `files-list${this.dropping ? ' dropping' : ''}`, role: 'listbox', 'aria-label': t('Server files', 'Fichiers du serveur') });
    if (!connected) {
      list.append(h('p', { class: 'files-msg muted' }, t('Session disconnected.', 'Session déconnectée.')));
      return list;
    }
    if (this.error) {
      list.append(h('p', { class: 'files-msg error' }, this.error));
      return list;
    }
    if (this.loading && !this.entries.length) {
      list.append(h('p', { class: 'files-msg muted' }, t('Loading…', 'Chargement…')));
      return list;
    }
    if (!this.entries.length) list.append(h('p', { class: 'files-msg muted' }, t('Empty folder. Drop files here to upload them.', 'Dossier vide. Glissez des fichiers ici pour les envoyer.')));

    for (const entry of this.entries) {
      const selected = entry.path === this.selected;
      const kindIcon = entry.isDir ? 'folder' : entry.isLink ? 'link' : 'file';
      list.append(
        h('div', { class: `file-row${selected ? ' selected' : ''}` },
          h('button', {
            class: 'file-main', role: 'option', 'aria-selected': String(selected),
            title: entry.isDir ? t('Double-click to open', 'Double-clic pour ouvrir') : t('Double-click to download', 'Double-clic pour télécharger'),
            onclick: () => { this.selected = entry.path; this.render(); },
            ondblclick: () => this.openEntry(entry),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter') this.openEntry(entry);
              else if (e.key === 'Delete') this.remove(entry);
              else if (e.key === 'F2') this.rename(entry);
              else if (e.key === 'Backspace') this.load(parent(this.cwd));
            },
          },
            h('span', { class: `file-ico${entry.isDir ? ' dir' : ''}` }, icon(kindIcon, 16)),
            h('span', { class: 'grow ellipsis' }, entry.name),
            h('span', { class: 'file-meta' }, entry.isDir ? '' : formatSize(entry.size)),
            h('span', { class: 'file-meta date' }, formatDate(entry.modified))),
          h('div', { class: 'row-actions' },
            h('button', { class: 'icon-btn sm', 'aria-label': t(`Download ${entry.name}`, `Télécharger ${entry.name}`), title: entry.isDir ? t('Download the whole folder', 'Télécharger le dossier entier') : t('Download', 'Télécharger'), onclick: () => this.download(entry) }, icon('download', 14)),
            !entry.isDir && h('button', { class: 'icon-btn sm', 'aria-label': t(`Edit ${entry.name}`, `Éditer ${entry.name}`), title: t('Open in my editor (uploaded again at every save)', 'Ouvrir dans mon éditeur (renvoi automatique à chaque enregistrement)'), onclick: () => this.edit(entry) }, icon('fileEdit', 14)),
            h('button', { class: 'icon-btn sm', 'aria-label': `Renommer ${entry.name}`, title: t('Rename (F2)', 'Renommer (F2)'), onclick: () => this.rename(entry) }, icon('edit', 14)),
            h('button', { class: 'icon-btn sm', 'aria-label': t(`Delete ${entry.name}`, `Supprimer ${entry.name}`), title: t('Delete (Del)', 'Supprimer (Suppr)'), onclick: () => this.remove(entry) }, icon('trash', 14)))),
      );
    }
    return list;
  }

  private renderTransfers() {
    const box = this.el.querySelector('.transfers');
    if (!box) return;
    const visible = this.transfers.filter((t) => t.state !== 'done').concat(this.transfers.filter((t) => t.state === 'done').slice(0, 3));
    const edits = this.editing.map((e) => h('div', { class: `transfer editing${e.error ? ' error' : ''}`, title: e.path },
      h('div', { class: 'transfer-line' },
        icon('fileEdit', 13),
        h('span', { class: 'grow ellipsis' }, e.name),
        h('button', { class: 'icon-btn sm', 'aria-label': t(`Stop editing ${e.name}`, `Arrêter l'édition de ${e.name}`), title: t('Stop syncing', 'Arrêter la synchronisation'), onclick: () => this.stopEdit(e) }, icon('close', 12))),
      h('div', { class: 'muted small' }, e.status)));
    box.replaceChildren(...edits, ...visible.map((tf) => {
      const pct = tf.total ? Math.min(100, Math.round((tf.done / tf.total) * 100)) : tf.state === 'done' ? 100 : 0;
      const status = tf.state === 'waiting' ? 'en attente' : tf.state === 'error' ? t('failed', 'échec') : tf.state === 'done' ? t('done', 'terminé') : `${pct} %`;
      return h('div', { class: `transfer ${tf.state}`, title: tf.error ?? '' },
        h('div', { class: 'transfer-line' },
          icon(tf.direction === 'up' ? 'upload' : 'download', 13),
          h('span', { class: 'grow ellipsis' }, tf.name),
          h('span', { class: 'muted small' }, status)),
        h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: `width: ${pct}%` })));
    }));
  }
}
