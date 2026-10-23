// Écran distant (VNC…) affiché dans un onglet : image dans un canvas, clavier et souris renvoyés.
import { api, errorText, InputEvent, ScreenEvent, TermEvent } from './api';
import { h } from './dom';
import type { TermState } from './terminal';

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

export class ScreenView {
  private readonly canvas = h('canvas', { class: 'screen-canvas', tabindex: '0', 'aria-label': 'Écran distant' });
  private readonly ctx = this.canvas.getContext('2d', { alpha: false })!;
  private readonly status = h('div', { class: 'screen-status' });
  private connectionId: string | null = null;
  private sessionId = '';
  private label = '';
  private connecting = false;
  private disposed = false;
  /** Les images JPEG se décodent de façon asynchrone : on garde l'ordre des dessins. */
  private drawing: Promise<void> = Promise.resolve();
  private pressed = new Map<string, number>();
  private buttons = 0;
  private lastMove = 0;
  /** true : l'image s'adapte à l'onglet ; false : taille réelle avec défilement. */
  fit = true;
  /** La session s'est ouverte hors de Termoria (message à afficher). */
  onDetached?: (message: string) => void;

  constructor(readonly container: HTMLElement, private readonly onState: (s: TermState, reason?: string) => void) {
    container.classList.add('screen-view');
    container.append(this.canvas, this.status);
    this.applyFit();
    this.bindInput();
  }

  get connection(): string | null {
    return this.connectionId;
  }

  async connect(sessionId: string, label: string) {
    this.sessionId = sessionId;
    this.label = label;
    this.setStatus(`Connexion à ${label}…`);
    this.onState('connecting');
    this.connecting = true;
    try {
      const res = await api.connect(sessionId, Math.max(640, this.container.clientWidth), Math.max(480, this.container.clientHeight), (e) => this.onEvent(e)).finally(() => { this.connecting = false; });
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
      this.setStatus('');
      this.onState('connected');
      this.focus();
    } catch (e) {
      const reason = errorText(e);
      this.setStatus(`${reason}\nCliquez ici ou appuyez sur Entrée pour réessayer.`, true);
      this.onState('closed', reason);
    }
  }

  reconnectNow() {
    if (this.connectionId || this.connecting || !this.sessionId) return;
    this.connect(this.sessionId, this.label);
  }

  cancelReconnect() { /* pas de reconnexion automatique pour un écran */ }

  private setStatus(text: string, error = false) {
    this.status.textContent = text;
    this.status.hidden = !text;
    this.status.classList.toggle('error', error);
  }

  private onEvent(e: TermEvent) {
    if (e.event === 'screen') this.draw(e.data);
    else if (e.event === 'closed') {
      this.connectionId = null;
      if (this.disposed) return;
      this.setStatus(e.data ? `Connexion perdue : ${e.data}\nCliquez ici pour vous reconnecter.` : 'Session terminée. Cliquez ici pour vous reconnecter.', !!e.data);
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
    }
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
      // Ctrl+Maj+… reste aux raccourcis de Termoria.
      if (e.ctrlKey && e.shiftKey && !e.altKey) return;
      const keysym = keysymOf(e);
      if (keysym === null) return;
      e.preventDefault();
      this.pressed.set(e.code, keysym);
      this.send({ type: 'key', keysym, down: true, code: e.code });
    });
    c.addEventListener('keyup', (e) => {
      const keysym = this.pressed.get(e.code) ?? keysymOf(e);
      this.pressed.delete(e.code);
      if (keysym === null) return;
      e.preventDefault();
      this.send({ type: 'key', keysym, down: false, code: e.code });
    });
    // Fenêtre quittée touches enfoncées : on les relâche côté serveur.
    c.addEventListener('blur', () => {
      for (const [code, keysym] of this.pressed) this.send({ type: 'key', keysym, down: false, code });
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

  dispose() {
    this.disposed = true;
    if (this.connectionId) api.disconnect(this.connectionId).catch(() => {});
    this.connectionId = null;
  }
}
