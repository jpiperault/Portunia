import { handleConfirm } from './confirm';
import { Highlighter } from './highlight';
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
import { t } from './i18n';

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

const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => {});

/** Vue terminal d'un onglet : xterm.js relié à une connexion du cœur Rust. */
export class TerminalView {
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly search = new SearchAddon();
  private readonly highlighter: Highlighter;
  private readonly observer: ResizeObserver;
  private readonly unsubscribe: () => void;
  private connectionId: string | null = null;
  /** Ouvre la connexion (session enregistrée ou shell local) ; gardé pour se reconnecter. */
  private opener: Opener | null = null;
  /** Reconnexion automatique après une coupure (pas pour un shell local qui se termine). */
  autoReconnect = true;
  private verb = t('Connecting to', 'Connexion à');
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
  /** Question en cours dans le terminal (identifiant, mot de passe), avant la connexion. */
  private question: { text: string; secret: boolean; resolve: (answer: string | null) => void } | null = null;

  /**
   * Pose une question dans le terminal, comme PuTTY (« login as: », mot de passe masqué).
   * Renvoie la réponse, ou null si l'utilisateur annule (Ctrl+C, Échap).
   */
  ask(prompt: string, secret = false): Promise<string | null> {
    this.question?.resolve(null);
    this.term.write(prompt);
    this.term.focus();
    return new Promise((resolve) => { this.question = { text: '', secret, resolve }; });
  }

  /** Écrit un message dans le terminal (hors session : avant la connexion). */
  write(text: string) {
    this.term.write(text);
  }

  private answerKey(data: string) {
    const q = this.question!;
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        this.question = null;
        this.term.write('\r\n');
        q.resolve(q.text);
        return;
      }
      if (ch === '\x03' || ch === '\x1b') {
        this.question = null;
        this.term.write('^C\r\n');
        q.resolve(null);
        return;
      }
      if (ch === '\x7f' || ch === '\b') {
        if (q.text) {
          q.text = [...q.text].slice(0, -1).join('');
          if (!q.secret) this.term.write('\b \b');
        }
      } else if (ch >= ' ') {
        q.text += ch;
        if (!q.secret) this.term.write(ch);
      }
    }
  }

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
    // Collage natif (Ctrl+V, menu du navigateur) : même vérification que les autres collages.
    container.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const text = e.clipboardData?.getData('text/plain');
      if (text) this.pasteChecked(text);
    }, true);
    this.useGpu();
    this.highlighter = new Highlighter(this.term);
    // Mesures de performance (page de démonstration, développement seulement).
    if (import.meta.env.DEV) ((window as unknown as { __terms?: Terminal[] }).__terms ??= []).push(this.term);

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
      if (this.question) return this.answerKey(data);
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
        { label: t('Copy', 'Copier'), icon: 'copy', action: () => copy(this.term.getSelection()) },
        { label: t('Paste', 'Coller'), action: () => this.pasteClipboard() },
        { label: t('Search…', 'Rechercher…'), action: () => this.openSearch() },
        'separator',
        { label: t('Clear screen', 'Effacer l\'écran'), action: () => this.term.clear() },
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

    window.addEventListener('portunia-theme', this.onTheme);

    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(container);
  }

  private readonly onTheme = () => { this.term.options.theme = terminalTheme(); };

  /** Rendu par la carte graphique (bien plus rapide) ; repli sur le rendu DOM si WebGL manque ou se perd. */
  private async useGpu() {
    const mode = settings().gpu;
    if (mode === 'off' || (mode === 'auto' && !hasRealGpu())) return;
    try {
      // Module chargé seulement quand il sert (≈ 100 Ko).
      const { WebglAddon } = await import('@xterm/addon-webgl');
      if (this.disposed) return;
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      // Pas de WebGL (pilote, bureau à distance) : le rendu DOM reste en place.
    }
  }

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
  async connectWith(opener: Opener, label: string, verb = t('Connecting to', 'Connexion à')) {
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
        this.term.write(t('\x1b[90mPress Enter to try again.\x1b[0m\r\n', '\x1b[90mAppuyez sur Entrée pour réessayer.\x1b[0m\r\n'));
        this.onState('closed', reason);
      }
    }
  }

  private onEvent(e: TermEvent) {
    if (handleConfirm(e)) return;
    if (e instanceof ArrayBuffer) {
      this.term.write(new Uint8Array(e));
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
      this.term.write(t(`\r\x1b[2K\x1b[33mRetrying (${this.retry}/${MAX_RETRIES}) in ${left} s — Enter: now, Esc: cancel\x1b[0m`, `\r\x1b[2K\x1b[33mNouvelle tentative (${this.retry}/${MAX_RETRIES}) dans ${left} s — Entrée : maintenant, Échap : annuler\x1b[0m`));
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
    this.term.write(t('\r\n\x1b[90mReconnection cancelled. Press Enter to try again.\x1b[0m\r\n', '\r\n\x1b[90mReconnexion annulée. Appuyez sur Entrée pour réessayer.\x1b[0m\r\n'));
    this.onState('closed');
  }

  private pasteClipboard() {
    navigator.clipboard.readText().then((t) => { if (t) this.pasteChecked(t); }).catch(() => {});
  }

  /**
   * Collage de plusieurs lignes : confirmation, car chaque ligne partirait aussitôt comme une
   * commande (texte copié d'une page web avec des lignes cachées…). Inutile si le shell a
   * activé le collage encadré (bracketed paste) : rien ne s'exécute avant Entrée.
   */
  private async pasteChecked(text: string) {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    if (lines.length > 1 && !this.term.modes.bracketedPasteMode && settings().confirmMultilinePaste) {
      if (!(await confirmPaste(lines))) return;
    }
    this.term.paste(text);
  }

  // ---------- Recherche (Ctrl+Maj+F) ----------

  openSearch() {
    if (this.searchBar) {
      this.searchBar.querySelector('input')?.select();
      return;
    }
    const count = h('span', { class: 'muted small search-count' });
    const input = h('input', { type: 'search', placeholder: t('Search…', 'Rechercher…'), 'aria-label': t('Search in the terminal', 'Rechercher dans le terminal'), spellcheck: 'false' });
    const find = (backwards = false) => {
      const opts = { decorations: SEARCH_DECORATIONS };
      if (!input.value) { this.search.clearDecorations(); count.textContent = ''; return; }
      if (backwards) this.search.findPrevious(input.value, opts);
      else this.search.findNext(input.value, { ...opts, incremental: true });
    };
    const results = this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      count.textContent = resultCount ? `${resultIndex + 1} / ${resultCount}` : t('no result', 'aucun résultat');
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
      h('button', { class: 'icon-btn sm', 'aria-label': t('Previous result', 'Résultat précédent'), title: t('Previous (Shift+Enter)', 'Précédent (Maj+Entrée)'), onclick: () => find(true) }, icon('up', 14)),
      h('button', { class: 'icon-btn sm', 'aria-label': t('Next result', 'Résultat suivant'), title: t('Next (Enter)', 'Suivant (Entrée)'), onclick: () => find() }, icon('chevronDown', 14)),
      h('button', { class: 'icon-btn sm', 'aria-label': t('Close the search', 'Fermer la recherche'), title: t('Close (Esc)', 'Fermer (Échap)'), onclick: close }, icon('close', 14)));
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
    this.question?.resolve(null);
    this.clearTimer();
    if (this.connectionId) api.disconnect(this.connectionId).catch(() => {});
    this.connectionId = null;
    this.unsubscribe();
    window.removeEventListener('portunia-theme', this.onTheme);
    this.observer.disconnect();
    this.highlighter.dispose();
    this.term.dispose();
  }
}

const END_SESSION = t('\r\n\x1b[90mSession ended. Press Enter to reconnect.\x1b[0m\r\n', '\r\n\x1b[90mSession terminée. Appuyez sur Entrée pour vous reconnecter.\x1b[0m\r\n');
const END_SHELL = t('\r\n\x1b[90mShell ended. Press Enter to restart it.\x1b[0m\r\n', '\r\n\x1b[90mShell terminé. Appuyez sur Entrée pour le relancer.\x1b[0m\r\n');

let gpuChecked: boolean | null = null;

/**
 * Vraie carte graphique ? Sans elle (machine virtuelle, bureau à distance), WebGL est
 * émulé par le processeur et plus lent que le rendu DOM : mesuré 4,2 contre 5,8 Mo/s.
 */
export function hasRealGpu(): boolean {
  if (gpuChecked !== null) return gpuChecked;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl ? String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : '';
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    gpuChecked = !!renderer && !/swiftshader|basic render|llvmpipe|software|warp/i.test(renderer);
  } catch {
    gpuChecked = false;
  }
  return gpuChecked;
}

/** Demande confirmation avant de coller plusieurs lignes ; montre ce qui partira. */
function confirmPaste(lines: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const preview = lines.slice(0, 12).map((l) => (l.length > 160 ? `${l.slice(0, 160)}…` : l)).join('\n')
      + (lines.length > 12 ? t(`\n… and ${lines.length - 12} more line(s)`, `\n… et ${lines.length - 12} ligne(s) de plus`) : '');
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'paste-title', style: 'width: min(640px, calc(100vw - 32px))' },
      h('header', { class: 'dlg-head' }, h('h2', { id: 'paste-title' }, t(`Paste ${lines.length} lines?`, `Coller ${lines.length} lignes ?`))),
      h('div', { class: 'dlg-body' },
        h('p', { style: 'margin: 0' }, t('Each line will be sent as a command, right away. Check there is nothing unexpected (text copied from a web page can contain invisible lines).', 'Chaque ligne sera envoyée comme une commande, aussitôt. Vérifiez qu’il n’y a rien d’inattendu (un texte copié depuis une page web peut contenir des lignes invisibles).')),
        h('pre', { class: 'confirm-detail', style: 'white-space: pre-wrap; max-height: 260px; overflow: auto; margin: 0' }, preview)),
      h('footer', { class: 'dlg-foot' },
        h('button', { type: 'button', class: 'btn', autofocus: true, onclick: () => dialog.close() }, t('Cancel', 'Annuler')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => { ok = true; dialog.close(); } }, t('Paste', 'Coller'))));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(ok); });
    document.body.append(dialog);
    dialog.showModal();
  });
}
