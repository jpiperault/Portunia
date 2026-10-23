import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, errorText, TermEvent } from './api';

export type TermState = 'connecting' | 'connected' | 'closed';

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Vue terminal d'un onglet : xterm.js relié à une connexion du cœur Rust. */
export class TerminalView {
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly observer: ResizeObserver;
  private connectionId: string | null = null;

  constructor(
    readonly container: HTMLElement,
    private readonly onState: (state: TermState, reason?: string) => void,
  ) {
    this.term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: false,
      scrollback: 5000,
      theme: {
        background: '#111215',
        foreground: '#D6D8DD',
        cursor: '#5B9BFF',
        selectionBackground: '#2F4A75',
      },
    });
    this.term.loadAddon(this.fit);
    this.term.open(container);
    // Ctrl+Maj+… est réservé à l'application (raccourcis, copier/coller) :
    // Ctrl+W, Ctrl+K… restent aux programmes du terminal.
    this.term.attachCustomKeyEventHandler((e) => {
      if (!(e.ctrlKey && e.shiftKey) || e.type !== 'keydown') return !(e.ctrlKey && e.shiftKey);
      const key = e.key.toLowerCase();
      if (key === 'c' && this.term.hasSelection()) navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
      if (key === 'v') navigator.clipboard.readText().then((t) => this.term.paste(t)).catch(() => {});
      return false;
    });
    this.term.onData((data) => {
      if (this.connectionId) api.termWrite(this.connectionId, data).catch(() => {});
    });
    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(container);
  }

  /** Identifiant de la connexion en cours côté Rust, ou null. */
  get connection(): string | null {
    return this.connectionId;
  }

  /** Recalcule la taille ; ignoré quand l'onglet est caché. */
  refit() {
    if (!this.container.clientWidth || !this.container.clientHeight) return;
    this.fit.fit();
    if (this.connectionId) {
      api.termResize(this.connectionId, this.term.cols, this.term.rows).catch(() => {});
    }
  }

  async connect(sessionId: string, label: string) {
    this.refit();
    this.onState('connecting');
    this.term.write(`\x1b[90mConnexion à ${label}…\x1b[0m\r\n`);
    try {
      const res = await api.connect(sessionId, this.term.cols, this.term.rows, (e) => this.onEvent(e));
      this.connectionId = res.connectionId;
      this.onState('connected');
      this.term.focus();
    } catch (e) {
      const reason = errorText(e);
      this.term.write(`\r\n\x1b[31m${reason.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
      this.onState('closed', reason);
    }
  }

  private onEvent(e: TermEvent) {
    if (e.event === 'data') {
      this.term.write(decode(e.data));
    } else {
      this.connectionId = null;
      const msg = e.data ? `\x1b[31mConnexion perdue : ${e.data}` : '\x1b[90mSession terminée';
      this.term.write(`\r\n${msg}\x1b[0m\r\n`);
      this.onState('closed', e.data ?? undefined);
    }
  }

  focus() {
    this.term.focus();
  }

  dispose() {
    if (this.connectionId) api.disconnect(this.connectionId).catch(() => {});
    this.connectionId = null;
    this.observer.disconnect();
    this.term.dispose();
  }
}
