// Écran distant (VNC…) affiché dans un onglet : image dans un canvas, clavier et souris renvoyés.
import { handleConfirm } from './confirm';
import { api, ConnectResponse, errorText, InputEvent, ScreenEvent, TermEvent } from './api';
import { h } from './dom';
import type { TermState } from './terminal';
import { open } from '@tauri-apps/plugin-dialog';
import { t } from './i18n';
import { IS_MAC, isMod } from './platform';
import { isMacAppKey, liveKey, releaseOnMetaUp } from './rdpkeys';
import { settings } from './settings';

/** Ouvre la connexion à la taille demandée (session enregistrée ou connexion rapide). */
export type ScreenOpener = (width: number, height: number, onEvent: (e: TermEvent) => void) => Promise<ConnectResponse>;

/** Touches spéciales → « keysym » X11 (RFC 6143). */
const KEYSYMS: Record<string, number> = {
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63, ContextMenu: 0xff67,
  NumLock: 0xff7f, CapsLock: 0xffe5, ScrollLock: 0xff14, Pause: 0xff13, PrintScreen: 0xff61,
  ShiftLeft: 0xffe1, ShiftRight: 0xffe2, ControlLeft: 0xffe3, ControlRight: 0xffe4,
  AltLeft: 0xffe9, AltRight: 0xfe03, MetaLeft: 0xffeb, MetaRight: 0xffec,
};
for (let i = 1; i <= 12; i++) KEYSYMS[`F${i}`] = 0xffbd + i;

function keysymOf(e: KeyboardEvent): number | null {
  const special = KEYSYMS[e.code] ?? KEYSYMS[e.key];
  if (special) return special;
  if (e.key.length === 1) {
    const cp = e.key.codePointAt(0)!;
    // Latin-1 : même valeur ; au-delà : 0x01000000 + point de code Unicode.
    return cp < 0x100 ? cp : 0x01000000 + cp;
  }
  return null;
}

function decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Zone d'image binaire (moteur RDP, VNC) : « P », x, y, largeur, hauteur (u16 petit-boutien), puis les pixels RGBA. */
export function drawPixels(ctx: CanvasRenderingContext2D, buf: ArrayBuffer) {
  if (buf.byteLength < 9) return;
  const head = new DataView(buf, 0, 9);
  if (head.getUint8(0) !== 0x50) return;
  const x = head.getUint16(1, true), y = head.getUint16(3, true), w = head.getUint16(5, true), hgt = head.getUint16(7, true);
  if (!w || !hgt || buf.byteLength !== 9 + w * hgt * 4) return;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(buf, 9), w, hgt), x, y);
}

export class ScreenView {
  private readonly canvas = h('canvas', { class: 'screen-canvas', tabindex: '0', 'aria-label': t('Remote screen', 'Écran distant') });
  private readonly ctx = this.canvas.getContext('2d', { alpha: false })!;
  private readonly status = h('div', { class: 'screen-status' });
  /** Copie de fichiers en cours (Bureau à distance). */
  private readonly progress = h('div', { class: 'screen-progress', hidden: true });
  private progressTimer = 0;
  private connectionId: string | null = null;
  private opener: ScreenOpener | null = null;
  private label = '';
  private connecting = false;
  private disposed = false;
  /** Les images JPEG se décodent de façon asynchrone : on garde l'ordre des dessins. */
  private drawing: Promise<void> = Promise.resolve();
  private pressed = new Map<string, { keysym: number; code: string }>();
  private buttons = 0;
  private lastMove = 0;
  /** true : l'image s'adapte à l'onglet ; false : taille réelle avec défilement. */
  fit = true;
  /** La session s'est ouverte hors de Portunia (message à afficher). */
  onDetached?: (message: string) => void;
  /** Bureau à distance : copie de fichiers possible dans la session (serveur et Gate d'accord). */
  filesAllowed = false;
  /** Le presse-papiers du serveur contient des fichiers à récupérer. */
  remoteFiles = false;
  /** Les deux valeurs ci-dessus ont changé (barre d'outils). */
  onFiles?: () => void;
  notify?: (message: string, kind?: 'info' | 'error') => void;
  private observer: ResizeObserver;
  private resizeTimer = 0;
  private lastSize = { width: 0, height: 0 };

  constructor(readonly container: HTMLElement, private readonly onState: (s: TermState, reason?: string) => void) {
    container.classList.add('screen-view');
    container.append(this.canvas, this.status, this.progress);
    this.applyFit();
    this.bindInput();
    // L'onglet change de taille : on demande au bureau distant de s'adapter
    // (RDP ; un serveur VNC garde sa résolution). Attente de la fin du redimensionnement.
    this.observer = new ResizeObserver(() => {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.sendSize(), 600);
    });
    this.observer.observe(container);
  }

  get connection(): string | null {
    return this.connectionId;
  }

  connect(sessionId: string, label: string) {
    return this.connectWith((width, height, onEvent) => api.connect(sessionId, width, height, onEvent), label);
  }

  async connectWith(opener: ScreenOpener, label: string) {
    this.opener = opener;
    this.label = label;
    this.setStatus(t(`Connecting to ${label}…`, `Connexion à ${label}…`));
    this.onState('connecting');
    this.connecting = true;
    try {
      const res = await opener(Math.max(640, this.container.clientWidth), Math.max(480, this.container.clientHeight), (e) => this.onEvent(e)).finally(() => { this.connecting = false; });
      if (this.disposed) {
        if (res.connectionId) api.disconnect(res.connectionId).catch(() => {});
        return;
      }
      if (!res.connectionId) {
        // Ouvert ailleurs (client Bureau à distance de Windows) : l'onglet n'a plus d'utilité.
        this.onDetached?.(res.message ?? `${label} ouvert`);
        return;
      }
      this.connectionId = res.connectionId;
      this.lastSize = { width: this.container.clientWidth, height: this.container.clientHeight };
      this.setStatus('');
      this.onState('connected');
      this.focus();
    } catch (e) {
      const reason = errorText(e);
      this.setStatus(t(`${reason}\nClick here or press Enter to try again.`, `${reason}\nCliquez ici ou appuyez sur Entrée pour réessayer.`), true);
      this.onState('closed', reason);
    }
  }

  reconnectNow() {
    if (this.connectionId || this.connecting || !this.opener) return;
    this.connectWith(this.opener, this.label);
  }

  cancelReconnect() { /* pas de reconnexion automatique pour un écran */ }

  private setStatus(text: string, error = false) {
    this.status.textContent = text;
    this.status.hidden = !text;
    this.status.classList.toggle('error', error);
  }

  private onEvent(e: TermEvent) {
    if (e instanceof ArrayBuffer) {
      this.drawing = this.drawing.then(() => drawPixels(this.ctx, e));
      return;
    }
    if (handleConfirm(e)) return;
    if (e.event === 'screen') this.draw(e.data);
    else if (e.event === 'closed') {
      this.connectionId = null;
      if (this.disposed) return;
      this.setFiles(false, false);
      this.setStatus(e.data ? t(`Connection lost: ${e.data}\nClick here to reconnect.`, `Connexion perdue : ${e.data}\nCliquez ici pour vous reconnecter.`) : t('Session ended. Click here to reconnect.', 'Session terminée. Cliquez ici pour vous reconnecter.'), !!e.data);
      this.onState('closed', e.data ?? undefined);
    }
  }

  private draw(ev: ScreenEvent) {
    switch (ev.type) {
      case 'resize':
        this.drawing = this.drawing.then(() => {
          this.canvas.width = ev.width;
          this.canvas.height = ev.height;
          this.ctx.fillStyle = '#000';
          this.ctx.fillRect(0, 0, ev.width, ev.height);
        });
        break;
      case 'image': {
        const pixels = new Uint8ClampedArray(decode(ev.rgba).buffer as ArrayBuffer);
        if (pixels.length !== ev.width * ev.height * 4 || !ev.width || !ev.height) return;
        const image = new ImageData(pixels, ev.width, ev.height);
        this.drawing = this.drawing.then(() => this.ctx.putImageData(image, ev.x, ev.y));
        break;
      }
      case 'jpeg': {
        const blob = new Blob([decode(ev.data)], { type: 'image/jpeg' });
        const bitmap = createImageBitmap(blob);
        this.drawing = this.drawing.then(async () => {
          try {
            this.ctx.drawImage(await bitmap, ev.x, ev.y, ev.width, ev.height);
          } catch { /* image illisible : ignorée */ }
        });
        break;
      }
      case 'copy':
        this.drawing = this.drawing.then(() =>
          this.ctx.drawImage(this.canvas, ev.srcX, ev.srcY, ev.width, ev.height, ev.x, ev.y, ev.width, ev.height));
        break;
      case 'clipboard':
        navigator.clipboard.writeText(ev.text).catch(() => {});
        break;
      case 'bell':
        break;
      case 'files':
        this.setFiles(ev.allowed, this.remoteFiles && ev.allowed);
        break;
      case 'remoteFiles':
        this.setFiles(this.filesAllowed, ev.available);
        break;
      case 'filesOffered':
        this.notify?.(t(`${ev.count} file(s) ready: paste them on the server (Ctrl+V in the Explorer).`, `${ev.count} fichier(s) prêt(s) : collez-les sur le serveur (Ctrl+V dans l'Explorateur).`));
        break;
      case 'fileSent':
        this.showProgress(t(`${ev.name} sent`, `${ev.name} envoyé`), true);
        break;
      case 'fileProgress':
        this.showProgress(`${ev.name} · ${ev.total ? Math.floor((ev.done / ev.total) * 100) : 100} %`, ev.done >= ev.total);
        break;
      case 'filesSaved':
        this.showProgress('', true);
        this.notify?.(t(`${ev.count} file(s) saved in ${ev.dir}`, `${ev.count} fichier(s) enregistré(s) dans ${ev.dir}`));
        break;
      case 'fileError': {
        const name = ev.name ?? '';
        const messages: Record<string, string> = {
          not_allowed: t('File copy is not allowed on this server.', 'La copie de fichiers n\'est pas permise sur ce serveur.'),
          nothing_to_send: t('No file to send (folders are not sent).', 'Aucun fichier à envoyer (les dossiers ne sont pas envoyés).'),
          no_remote_files: t('The server\'s clipboard holds no files: copy them on the server first (Ctrl+C in the Explorer).', 'Le presse-papiers du serveur ne contient pas de fichiers : copiez-les d\'abord sur le serveur (Ctrl+C dans l\'Explorateur).'),
          busy: t('Files are already being retrieved.', 'Une récupération de fichiers est déjà en cours.'),
          name_refused: t(`${name}: name refused`, `${name} : nom refusé`),
          write: t(`Cannot write ${name}`, `Écriture impossible : ${name}`),
          refused: t(`${name}: refused by the server`, `${name} : refusé par le serveur`),
          size: t(`${name}: unreadable size`, `${name} : taille illisible`),
          no_list: t('The server did not give the list of files.', 'Le serveur n\'a pas donné la liste des fichiers.'),
        };
        this.notify?.(messages[ev.code] ?? ev.code, 'error');
        break;
      }
    }
  }

  private setFiles(allowed: boolean, remote: boolean) {
    if (allowed === this.filesAllowed && remote === this.remoteFiles) return;
    this.filesAllowed = allowed;
    this.remoteFiles = remote;
    this.onFiles?.();
  }

  /** Ligne d'avancement en bas à droite ; `done` : s'efface après quelques secondes. */
  private showProgress(text: string, done: boolean) {
    window.clearTimeout(this.progressTimer);
    this.progress.textContent = text;
    this.progress.hidden = !text;
    if (done) this.progressTimer = window.setTimeout(() => { this.progress.hidden = true; }, 3000);
  }

  /** Fichiers de ce poste mis au presse-papiers de la session (bouton ou glisser-déposer). */
  sendFiles(paths: string[]) {
    if (paths.length) this.send({ type: 'sendFiles', paths });
    this.focus();
  }

  async chooseFiles() {
    const chosen = await open({ multiple: true, title: t('Files to send to the server', 'Fichiers à envoyer au serveur') });
    if (chosen) this.sendFiles(Array.isArray(chosen) ? chosen : [chosen]);
  }

  /** Enregistre dans un dossier de ce poste les fichiers copiés sur le serveur. */
  async fetchFiles() {
    const dir = await open({ directory: true, title: t('Folder for the server\'s files', 'Dossier pour les fichiers du serveur') });
    if (typeof dir === 'string') this.send({ type: 'fetchFiles', dir });
    this.focus();
  }

  private send(event: InputEvent) {
    if (this.connectionId) api.screenInput(this.connectionId, event).catch(() => {});
  }

  /** Position de la souris en pixels de l'écran distant. */
  private point(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * this.canvas.width);
    const y = Math.round(((e.clientY - r.top) / r.height) * this.canvas.height);
    return { x: Math.max(0, Math.min(this.canvas.width - 1, x)), y: Math.max(0, Math.min(this.canvas.height - 1, y)) };
  }

  private bindInput() {
    const c = this.canvas;
    // Boutons du navigateur (gauche 1, droit 2, milieu 4) → VNC (gauche 1, milieu 2, droit 4).
    const vncButtons = (b: number) => (b & 1) | ((b & 4) >> 1) | ((b & 2) << 1);

    c.addEventListener('pointerdown', (e) => {
      c.focus();
      c.setPointerCapture(e.pointerId);
      this.buttons = vncButtons(e.buttons);
      this.send({ type: 'pointer', ...this.point(e), buttons: this.buttons });
      e.preventDefault();
    });
    c.addEventListener('pointerup', (e) => {
      this.buttons = vncButtons(e.buttons);
      this.send({ type: 'pointer', ...this.point(e), buttons: this.buttons });
    });
    c.addEventListener('pointermove', (e) => {
      const now = performance.now();
      if (now - this.lastMove < 16 && !this.buttons) return; // ~60 mouvements par seconde
      this.lastMove = now;
      this.send({ type: 'pointer', ...this.point(e), buttons: vncButtons(e.buttons) });
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const wheel = e.deltaY < 0 ? 8 : 16;
      const p = this.point(e);
      this.send({ type: 'pointer', ...p, buttons: this.buttons | wheel });
      this.send({ type: 'pointer', ...p, buttons: this.buttons });
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('keydown', (e) => {
      // Ctrl+Maj+… (⌘+Maj+… sur Mac) reste aux raccourcis de Portunia.
      if (isMod(e) && e.shiftKey && !e.altKey) return;
      // Mac : ⌘Q, ⌘H, ⌘M et ⌘, restent à macOS et à l'application (ni interceptés ni envoyés).
      if (isMacAppKey(e, IS_MAC)) return;
      const raw = keysymOf(e);
      if (raw === null) return;
      e.preventDefault();
      // Sur Mac, ⌘ part comme Ctrl (ou comme la touche Windows, selon le réglage) ; ⌥ reste Alt.
      const key = liveKey(e, raw, settings().metaKeyAs, IS_MAC);
      this.send({ type: 'key', keysym: key.keysym, down: true, code: key.code });
      if (key.releaseNow) this.send({ type: 'key', keysym: key.keysym, down: false, code: key.code });
      else this.pressed.set(e.code, { keysym: key.keysym, code: key.code });
    });
    c.addEventListener('keyup', (e) => {
      if (isMacAppKey({ key: e.key, metaKey: true, shiftKey: e.shiftKey }, IS_MAC) && !this.pressed.has(e.code)) return;
      const held = this.pressed.get(e.code);
      this.pressed.delete(e.code);
      // ⌘ relâchée : WebKit a pu avaler les keyup des touches pressées sous ⌘, on les libère côté serveur.
      if (IS_MAC) {
        for (const stuck of releaseOnMetaUp(this.pressed, e.code)) {
          this.pressed.delete(stuck.held);
          this.send({ type: 'key', keysym: stuck.keysym, down: false, code: stuck.code });
        }
      }
      if (!held) {
        const raw = keysymOf(e);
        if (raw === null) return;
        const key = liveKey(e, raw, settings().metaKeyAs, IS_MAC);
        e.preventDefault();
        this.send({ type: 'key', keysym: key.keysym, down: false, code: key.code });
        return;
      }
      e.preventDefault();
      this.send({ type: 'key', keysym: held.keysym, down: false, code: held.code });
    });
    // Fenêtre quittée touches enfoncées : on les relâche côté serveur.
    c.addEventListener('blur', () => {
      for (const held of this.pressed.values()) this.send({ type: 'key', keysym: held.keysym, down: false, code: held.code });
      this.pressed.clear();
    });

    this.status.addEventListener('click', () => this.reconnectNow());
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !this.connectionId) this.reconnectNow(); });
  }

  /** Ctrl+Alt+Suppr, impossible à taper directement sous Windows. */
  sendCtrlAltDel() {
    const keys: [number, string][] = [[0xffe3, 'ControlLeft'], [0xffe9, 'AltLeft'], [0xffff, 'Delete']];
    for (const [keysym, code] of keys) this.send({ type: 'key', keysym, down: true, code });
    for (const [keysym, code] of [...keys].reverse()) this.send({ type: 'key', keysym, down: false, code });
    this.focus();
  }

  /** Copie le presse-papiers de Windows dans celui de l'écran distant. */
  async sendClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.send({ type: 'clipboard', text });
    } catch { /* presse-papiers indisponible */ }
    this.focus();
  }

  toggleFit() {
    this.fit = !this.fit;
    this.applyFit();
  }

  private applyFit() {
    this.container.classList.toggle('fit', this.fit);
  }

  refit() { /* le canvas s'adapte en CSS */ }

  focus() {
    this.canvas.focus();
  }

  private sendSize() {
    const width = Math.round(this.container.clientWidth);
    const height = Math.round(this.container.clientHeight);
    if (!this.connectionId || !this.fit || width < 200 || height < 150) return;
    if (Math.abs(width - this.lastSize.width) < 8 && Math.abs(height - this.lastSize.height) < 8) return;
    this.lastSize = { width, height };
    this.send({ type: 'resize', width, height });
  }

  dispose() {
    window.clearTimeout(this.resizeTimer);
    this.observer.disconnect();
    this.disposed = true;
    if (this.connectionId) api.disconnect(this.connectionId).catch(() => {});
    this.connectionId = null;
  }
}
