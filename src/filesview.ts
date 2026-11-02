// Onglet « fichiers seulement » (SFTP, FTP, S3) : Ce PC à gauche, le serveur à droite,
// la file de transferts en bas. Pas de terminal.
import { handleConfirm } from './confirm';
import { api, errorText, remoteFiles, RemoteEntry, TermEvent } from './api';
import { h, icon } from './dom';
import { FilePanel } from './files';
import { LocalPanel, localJoin, windowsName } from './localpanel';
import type { Opener, TermState } from './terminal';
import { t } from './i18n';
import { proChip } from './security';
import { openSyncDialog } from './syncdialog';
import { ExistsRule, TransferQueue } from './transfers';


/** Faut-il copier, d'après la règle « si le fichier existe » ? `null` : à demander. */
function decide(rule: ExistsRule, source: RemoteEntry, existing: RemoteEntry | undefined): boolean | null {
  if (!existing || existing.isDir || source.isDir) return true;
  if (rule === 'overwrite') return true;
  if (rule === 'skip') return false;
  if (rule === 'newer') return (source.modified ?? 0) > (existing.modified ?? 0);
  return null;
}

/** Les deux volets, les flèches entre eux et la file de transferts. */
export class DualFiles {
  readonly el: HTMLElement;
  readonly queue: TransferQueue;
  readonly local: LocalPanel;
  readonly remote: FilePanel;
  private showHidden = false;
  private readonly hiddenBtn: HTMLButtonElement;

  constructor(private readonly toast: (msg: string, kind?: 'info' | 'error') => void, protocolLabel: string, start: { remote?: string; local?: string }) {
    this.queue = new TransferQueue(toast);
    this.local = new LocalPanel(toast, (entries) => this.upload(entries));
    this.remote = new FilePanel(toast, protocolLabel, { queue: this.queue, startDir: start.remote, transfer: (entries) => this.download(entries) });
    const arrow = (name: string, label: string, onclick: () => void) =>
      h('button', { type: 'button', class: 'dual-arrow', 'aria-label': label, title: label, onclick }, icon(name, 18));
    this.hiddenBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', onclick: () => this.toggleHidden() }, icon('eye', 14), t('Hidden files', 'Fichiers masqués')) as HTMLButtonElement;
    this.el = h('div', { class: 'dual-files' },
      h('div', { class: 'dual-bar' },
        this.hiddenBtn,
        h('button', { type: 'button', class: 'btn sm', onclick: () => this.synchronise() }, icon('refresh', 14), t('Compare and synchronise', 'Comparer et synchroniser'), proChip('fileSync')),
        h('span', { class: 'grow' }),
        h('span', { class: 'muted small' }, t('F5 upload · F6 download · Ctrl+click to select several', 'F5 envoyer · F6 récupérer · Ctrl+clic pour en choisir plusieurs'))),
      h('div', { class: 'dual-panes' },
        this.local.el,
        h('div', { class: 'dual-mid' },
          arrow('arrowRight', t('Upload the selection to the server (F5)', 'Envoyer la sélection sur le serveur (F5)'), () => this.upload()),
          arrow('arrowLeft', t('Download the selection to this PC (F6)', 'Récupérer la sélection sur ce PC (F6)'), () => this.download())),
        this.remote.el),
      this.queue.el);
    this.el.addEventListener('keydown', (e) => {
      // F5 rechargerait la fenêtre : il sert ici à envoyer.
      if (e.key === 'F5') { e.preventDefault(); this.upload(); }
      else if (e.key === 'F6') { e.preventDefault(); this.download(); }
    });
    this.local.start(start.local);
  }

  /** Fenêtre « Comparer et synchroniser » (Pro) sur les deux dossiers ouverts. */
  private synchronise() {
    const id = this.remote.connection;
    if (!id) return this.toast(t('Server disconnected.', 'Serveur déconnecté.'), 'error');
    if (!this.local.dir) return this.toast(t('Open a folder of this PC first (left pane).', 'Ouvrez d\'abord un dossier de ce PC (volet de gauche).'));
    openSyncDialog({
      connectionId: id, localDir: this.local.dir, remoteDir: this.remote.dir, queue: this.queue, toast: this.toast,
      done: () => { this.local.load(this.local.dir); this.remote.load(this.remote.dir); },
    });
  }

  /** Dépôt depuis l'Explorateur Windows : seulement sur le volet du serveur. */
  acceptsDrop(x: number, y: number): boolean {
    const r = this.remote.el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  private toggleHidden() {
    this.showHidden = !this.showHidden;
    this.hiddenBtn.setAttribute('aria-pressed', String(this.showHidden));
    this.hiddenBtn.classList.toggle('on', this.showHidden);
    this.local.toggleHidden(this.showHidden);
    this.remote.toggleHidden(this.showHidden);
  }

  /** Garde les éléments à copier : la règle de la file, ou une seule question pour tous les fichiers déjà présents. */
  private filter(entries: RemoteEntry[], existing: RemoteEntry[], where: string): RemoteEntry[] {
    const byName = new Map(existing.map((e) => [e.name.toLowerCase(), e]));
    const keep: RemoteEntry[] = [];
    const ask: RemoteEntry[] = [];
    for (const e of entries) {
      const verdict = decide(this.queue.rule, e, byName.get(e.name.toLowerCase()));
      if (verdict === null) ask.push(e);
      else if (verdict) keep.push(e);
    }
    if (ask.length) {
      const names = ask.slice(0, 8).map((e) => e.name).join(', ') + (ask.length > 8 ? '…' : '');
      if (confirm(t(`Already ${where}: ${names}.\nReplace? (Cancel = skip them)`, `Déjà ${where} : ${names}.\nRemplacer ? (Annuler = les ignorer)`))) keep.push(...ask);
    }
    return keep;
  }

  upload(entries = this.local.picked) {
    const id = this.remote.connection;
    if (!id) return this.toast(t('Server disconnected.', 'Serveur déconnecté.'), 'error');
    if (!entries.length) return this.toast(t('Select files of this PC first (left pane).', 'Sélectionnez d\'abord des fichiers de ce PC (volet de gauche).'));
    const dir = this.remote.dir;
    for (const e of this.filter(entries, this.remote.listed, t('on the server', 'sur le serveur'))) {
      this.queue.add({
        name: e.isDir ? `${e.name}/` : e.name, direction: 'up', target: dir,
        run: (cb) => remoteFiles.uploadAny(id, e.path, dir, cb),
        after: () => this.remote.refreshIf(dir),
      });
    }
  }

  download(entries = this.remote.picked) {
    const id = this.remote.connection;
    if (!id) return this.toast(t('Server disconnected.', 'Serveur déconnecté.'), 'error');
    if (!entries.length) return this.toast(t('Select files of the server first (right pane).', 'Sélectionnez d\'abord des fichiers du serveur (volet de droite).'));
    const dir = this.local.dir;
    if (!dir) return this.toast(t('Open a folder of this PC first (left pane).', 'Ouvrez d\'abord un dossier de ce PC (volet de gauche).'));
    for (const e of this.filter(entries, this.local.listed, t('on this PC', 'sur ce PC'))) {
      const local = localJoin(dir, windowsName(e.name));
      this.queue.add({
        name: e.isDir ? `${e.name}/` : e.name, direction: 'down', target: dir,
        run: (cb) => (e.isDir ? remoteFiles.downloadDir(id, e.path, local, cb) : api.fsDownload(id, e.path, local, cb, e.modified)),
        after: () => this.local.refreshIf(dir),
      });
    }
  }
}

export class FilesView {
  private connectionId: string | null = null;
  private opener: Opener | null = null;
  private label = '';
  private connecting = false;
  private disposed = false;
  private readonly status = h('div', { class: 'screen-status' });

  constructor(
    container: HTMLElement,
    private readonly panel: FilePanel,
    private readonly onState: (state: TermState, reason?: string) => void,
    readonly dual?: DualFiles,
  ) {
    container.classList.add('files-view');
    container.append(dual?.el ?? panel.el, this.status);
    this.status.addEventListener('click', () => this.reconnectNow());
  }

  get connection(): string | null {
    return this.connectionId;
  }

  async connectWith(opener: Opener, label: string) {
    this.opener = opener;
    this.label = label;
    this.connecting = true;
    this.setStatus(t(`Connecting to ${label}…`, `Connexion à ${label}…`));
    this.onState('connecting');
    try {
      const res = await opener(80, 24, (e) => this.onEvent(e));
      if (this.disposed) {
        if (res.connectionId) api.disconnect(res.connectionId).catch(() => {});
        return;
      }
      this.connectionId = res.connectionId;
      this.setStatus('');
      // L'onglet rattache alors l'explorateur à la connexion (onState).
      this.onState('connected');
    } catch (e) {
      const reason = errorText(e);
      this.setStatus(t(`${reason}\nClick here to try again.`, `${reason}\nCliquez ici pour réessayer.`), true);
      this.onState('closed', reason);
    } finally {
      this.connecting = false;
    }
  }

  private onEvent(e: TermEvent) {
    if (handleConfirm(e) || e instanceof ArrayBuffer || e.event !== 'closed') return;
    this.connectionId = null;
    this.panel.detach();
    if (this.disposed) return;
    this.setStatus(e.data ? t(`Connection lost: ${e.data}\nClick here to reconnect.`, `Connexion perdue : ${e.data}\nCliquez ici pour vous reconnecter.`) : t('Connection closed. Click here to reconnect.', 'Connexion fermée. Cliquez ici pour vous reconnecter.'), !!e.data);
    this.onState('closed', e.data ?? undefined);
  }

  private setStatus(text: string, error = false) {
    this.status.textContent = text;
    this.status.hidden = !text;
    this.status.classList.toggle('error', error);
  }

  reconnectNow() {
    if (this.connectionId || this.connecting || !this.opener) return;
    this.connectWith(this.opener, this.label);
  }

  cancelReconnect() { /* pas de reconnexion automatique */ }
  refit() { /* rien à recalculer */ }
  focus() { /* l'explorateur gère son focus */ }

  dispose() {
    this.disposed = true;
    if (this.connectionId) api.disconnect(this.connectionId).catch(() => {});
    this.connectionId = null;
    this.panel.detach();
  }
}
