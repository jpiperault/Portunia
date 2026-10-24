import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { openUrl } from '@tauri-apps/plugin-opener';
import { api, ConnectResponse, errorText, TermEvent } from './api';
import { h, icon } from './dom';
import { showMenu } from './menu';
import { fontStack, onSettingsChange, settings, updateSettings } from './settings';
import { terminalTheme } from './theme';

export type TermState = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/** Ouvre une connexion terminal et renvoie son identifiant côté Rust. */
export type Opener = (cols: number, rows: number, onEvent: (e: TermEvent) => void) => Promise<ConnectResponse>;

/** Délais entre deux tentatives de reconnexion (secondes), le dernier se répète. */
const RETRY_DELAYS = [2, 5, 10, 20, 30];
const MAX_RETRIES = 20;

const SEARCH_DECORATIONS = {
  matchBackground: '#5B4A1C',
  activeMatchBackground: '#9A6A1F',
  matchOverviewRuler: '#F0A35B',
  activeMatchColorOverviewRuler: '#FFD08A',
};

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

/** Vue terminal d'un onglet : xterm.js relié à une connexion du cœur Rust. */
export class TerminalView {
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private readonly observer: ResizeObserver;
  private readonly unsubscribe: () => void;
  private connectionId: string | null = null;
  /** Ouvre la connexion (session enregistrée ou shell local) ; gardé pour se reconnecter. */
  private opener: Opener | null = null;
  /** Reconnexion automatique après une coupure (pas pour un shell local qui se termine). */
  autoReconnect = true;
  private verb = 'Connexion à';
  /** Saisie reçue avant que la connexion soit prête. */
  private pending: string[] = [];

  private reopen() {
    if (this.opener) this.connectWith(this.opener, this.label, this.verb);
  }
  private label = '';
  /** Une connexion a déjà réussi : une coupure déclenche la reconnexion automatique. */
  private wasConnected = false;
  private retry = 0;
  private retryTimer: number | null = null;
  private searchBar: HTMLElement | null = null;
  private disposed = false;
  private connecting = false;
  /** Renvoie true si la saisie a été prise en charge ailleurs (saisie multiple). */
  inputHook?: (data: string) => boolean;

  /** Envoie du texte à la session comme s'il était tapé (sans passer par la saisie multiple). */
  send(data: string) {
    if (this.connectionId) api.termWrite(this.connectionId, data).catch(() => {});
  }

  constructor(
    readonly container: HTMLElement,
    private readonly onState: (state: TermState, reason?: string) => void,
  ) {
    const s = settings();
    this.term = new Terminal({
      fontFamily: fontStack(s),
      fontSize: s.fontSize,
      cursorStyle: s.cursorStyle,
      scrollback: s.scrollback,
      cursorBlink: true,
      allowProposedApi: true, // requis par la recherche (surlignage des résultats)
      theme: terminalTheme(),
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    // Ctrl+clic sur un lien : ouvert dans le navigateur (un simple clic sélectionne).
    this.term.loadAddon(new WebLinksAddon((event, uri) => {
      if (event.ctrlKey) openUrl(uri).catch(() => {});
    }));
    this.term.open(container);

    // Ctrl+Maj+… est réservé à l'application : Ctrl+W, Ctrl+K… restent aux programmes du terminal.
    this.term.attachCustomKeyEventHandler((e) => {
      if (!(e.ctrlKey && e.shiftKey)) return true;
      if (e.type !== 'keydown') return false;
      const key = e.key.toLowerCase();
      if (key === 'c' && this.term.hasSelection()) copy(this.term.getSelection());
      else if (key === 'v') this.pasteClipboard();
      else if (key === 'f') this.openSearch();
      return false;
    });

    this.term.onData((data) => {
      if (!this.connectionId && this.connecting) {
        this.pending.push(data);
        return;
      }
      if (this.connectionId) {
        // Saisie multiple : l'application peut rediriger la frappe vers plusieurs sessions.
        if (this.inputHook?.(data)) return;
        api.termWrite(this.connectionId, data).catch(() => {});
      } else if (data === '\r' && this.opener && !this.retryTimer) {
        this.reconnectNow(); // Entrée sur une session fermée = se reconnecter
      } else if (data === '\x1b' && this.retryTimer) {
        this.cancelReconnect();
      } else if (data === '\r' && this.retryTimer) {
        this.reconnectNow();
      }
    });

    this.term.onSelectionChange(() => {
      if (settings().copyOnSelect && this.term.hasSelection()) copy(this.term.getSelection());
    });

    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (settings().rightClickPaste) {
        if (this.term.hasSelection()) {
          copy(this.term.getSelection());
          this.term.clearSelection();
        } else {
          this.pasteClipboard();
        }
        return;
      }
      showMenu(e.clientX, e.clientY, [
        { label: 'Copier', icon: 'copy', action: () => copy(this.term.getSelection()) },
        { label: 'Coller', action: () => this.pasteClipboard() },
        { label: 'Rechercher…', action: () => this.openSearch() },
        'separator',
        { label: 'Effacer l\'écran', action: () => this.term.clear() },
      ]);
    });

    // Ctrl + molette : taille du texte (pour tous les terminaux).
    container.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      updateSettings({ fontSize: settings().fontSize + (e.deltaY < 0 ? 1 : -1) });
    }, { passive: false, capture: true });

    this.unsubscribe = onSettingsChange((next) => {
      this.term.options.fontFamily = fontStack(next);
      this.term.options.fontSize = next.fontSize;
      this.term.options.cursorStyle = next.cursorStyle;
      this.term.options.scrollback = next.scrollback;
      this.term.options.theme = terminalTheme();
      this.refit();
    });

    window.addEventListener('termoria-theme', this.onTheme);

    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(container);
  }

  private readonly onTheme = () => { this.term.options.theme = terminalTheme(); };

  /** Identifiant de la connexion en cours côté Rust, ou null. */
  get connection(): string | null {
    return this.connectionId;
  }

  /** Recalcule la taille ; ignoré quand l'onglet est caché. */
  refit() {
    if (this.disposed || !this.container.clientWidth || !this.container.clientHeight) return;
    this.fit.fit();
    if (this.connectionId) {
      api.termResize(this.connectionId, this.term.cols, this.term.rows).catch(() => {});
    }
  }

  /** Session enregistrée. */
  connect(sessionId: string, label: string) {
    return this.connectWith((cols, rows, onEvent) => api.connect(sessionId, cols, rows, onEvent), label);
  }

  /** N'importe quelle source de terminal (session, shell local…). */
  async connectWith(opener: Opener, label: string, verb = 'Connexion à') {
    this.opener = opener;
    this.label = label;
    this.verb = verb;
    this.refit();
    this.onState(this.retry ? 'reconnecting' : 'connecting');
    this.term.write(`\x1b[90m${verb} ${label}…\x1b[0m\r\n`);
    this.connecting = true;
    try {
      const res = await opener(this.term.cols, this.term.rows, (e) => this.onEvent(e))
        .finally(() => { this.connecting = false; });
      if (this.disposed) {
        if (res.connectionId) api.disconnect(res.connectionId).catch(() => {});
        return;
      }
      this.connectionId = res.connectionId;
      // Frappe (ou réponse automatique du terminal) arrivée pendant l'ouverture.
      const queued = this.pending.splice(0).join('');
      if (queued && this.connectionId) api.termWrite(this.connectionId, queued).catch(() => {});
      this.wasConnected = true;
      this.retry = 0;
      this.onState('connected');
      this.term.focus();
    } catch (e) {
      this.pending = [];
      const reason = errorText(e);
      this.term.write(`\x1b[31m${reason.replace(/\n/g, '\r\n')}\x1b[0m\r\n`);
      if (this.retry && this.retry < MAX_RETRIES) {
        this.scheduleReconnect();
      } else {
        this.retry = 0;
        this.term.write('\x1b[90mAppuyez sur Entrée pour réessayer.\x1b[0m\r\n');
        this.onState('closed', reason);
      }
    }
  }

  private onEvent(e: TermEvent) {
    if (e.event === 'data') {
      this.term.write(decode(e.data));
      return;
    }
    if (e.event !== 'closed') return;
    this.connectionId = null;
    if (this.disposed) return;
    if (e.data) {
      this.term.write(`\r\n\x1b[31mConnexion perdue : ${e.data}\x1b[0m\r\n`);
      // Coupure réseau, mise en veille… : on se reconnecte tout seul.
      if (settings().autoReconnect && this.autoReconnect && this.wasConnected) {
        this.scheduleReconnect();
        return;
      }
    } else {
      this.term.write(this.autoReconnect
        ? END_SESSION
        : END_SHELL);
    }
    this.onState('closed', e.data ?? undefined);
  }

  private scheduleReconnect() {
    const delay = RETRY_DELAYS[Math.min(this.retry, RETRY_DELAYS.length - 1)];
    this.retry++;
    this.onState('reconnecting');
    let left = delay;
    const tick = () => {
      this.term.write(`\r\x1b[2K\x1b[33mNouvelle tentative (${this.retry}/${MAX_RETRIES}) dans ${left} s — Entrée : maintenant, Échap : annuler\x1b[0m`);
      if (left-- <= 0) {
        this.clearTimer();
        this.term.write('\r\n');
        this.reopen();
        return;
      }
      this.retryTimer = window.setTimeout(tick, 1000);
    };
    tick();
  }

  private clearTimer() {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Reconnexion immédiate (bouton « Reconnecter », Entrée). */
  reconnectNow() {
    if (this.connectionId || this.connecting || !this.opener) return;
    const waiting = this.retryTimer !== null;
    this.clearTimer();
    if (!waiting) this.retry = 0;
    this.term.write('\r\n');
    this.reopen();
  }

  cancelReconnect() {
    this.clearTimer();
    this.retry = 0;
    this.term.write('\r\n\x1b[90mReconnexion annulée. Appuyez sur Entrée pour réessayer.\x1b[0m\r\n');
    this.onState('closed');
  }

  private pasteClipboard() {
    navigator.clipboard.readText().then((t) => { if (t) this.term.paste(t); }).catch(() => {});
  }

  // ---------- Recherche (Ctrl+Maj+F) ----------

  openSearch() {
    if (this.searchBar) {
      this.searchBar.querySelector('input')?.select();
      return;
    }
    const count = h('span', { class: 'muted small search-count' });
    const input = h('input', { type: 'search', placeholder: 'Rechercher…', 'aria-label': 'Rechercher dans le terminal', spellcheck: 'false' });
    const find = (backwards = false) => {
      const opts = { decorations: SEARCH_DECORATIONS };
      if (!input.value) { this.search.clearDecorations(); count.textContent = ''; return; }
      if (backwards) this.search.findPrevious(input.value, opts);
      else this.search.findNext(input.value, { ...opts, incremental: true });
    };
    const results = this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      count.textContent = resultCount ? `${resultIndex + 1} / ${resultCount}` : 'aucun résultat';
    });
    const close = () => {
      results.dispose();
      this.search.clearDecorations();
      this.searchBar?.remove();
      this.searchBar = null;
      this.term.focus();
    };
    input.addEventListener('input', () => find());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    this.searchBar = h('div', { class: 'term-search' },
      input, count,
      h('button', { class: 'icon-btn sm', 'aria-label': 'Résultat précédent', title: 'Précédent (Maj+Entrée)', onclick: () => find(true) }, icon('up', 14)),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Résultat suivant', title: 'Suivant (Entrée)', onclick: () => find() }, icon('chevronDown', 14)),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Fermer la recherche', title: 'Fermer (Échap)', onclick: close }, icon('close', 14)));
    this.container.append(this.searchBar);
    if (this.term.hasSelection()) input.value = this.term.getSelection();
    input.focus();
    find();
  }

  focus() {
    this.term.focus();
  }

  dispose() {
    this.disposed = true;
    this.clearTimer();
    if (this.connectionId) api.disconnect(this.connectionId).catch(() => {});
    this.connectionId = null;
    this.unsubscribe();
    window.removeEventListener('termoria-theme', this.onTheme);
    this.observer.disconnect();
    this.term.dispose();
  }
}

const END_SESSION = '\r\n\x1b[90mSession terminée. Appuyez sur Entrée pour vous reconnecter.\x1b[0m\r\n';
const END_SHELL = '\r\n\x1b[90mShell terminé. Appuyez sur Entrée pour le relancer.\x1b[0m\r\n';
