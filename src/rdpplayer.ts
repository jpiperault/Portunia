// Lecteur des sessions Bureau à distance enregistrées par un bastion Heimdia.
// L'image est décodée par le moteur RDP (portunia-rdp) à partir du flux enregistré ; ce
// lecteur l'affiche, avec la souris, les clics, les copier-coller et, si la règle l'a
// enregistrée, la frappe en sous-titres. Mêmes commandes que le lecteur des sessions SSH.
import { h, icon } from './dom';
import { LOCALE, t } from './i18n';

/** Réponse de GET /audit/sessions/{id}/enregistrement pour une session RDP. */
export interface RdpRecording {
  session: { id: string; compte: string; serveur: string; type: string; detail: string; mode: string; adresse: string; debut: string; fin: string | null; frappe: boolean; octets: number };
  rdp: { evenements: RdpEvent[]; duree: number; images: number };
  revele: boolean;
  saisies_masquees: number;
  signature: 'verifiee' | 'alteree' | 'absente';
  empreinte: string;
  commandes_sensibles: string[];
  consultations: { qui: string; date: string; evenement: string }[];
}

export type RdpEvent =
  | { t: number; k: 'clavier'; disposition: number }
  | { t: number; k: 'touche'; c: number; e: boolean; r: boolean }
  | { t: number; k: 'unicode'; u: number; r: boolean }
  | { t: number; k: 'clic'; x: number; y: number; b: 'g' | 'd' | 'm' }
  | { t: number; k: 'souris'; x: number; y: number }
  | { t: number; k: 'presse-papiers'; sens: 'vers-serveur' | 'vers-poste'; texte: string | null; longueur?: number; masque?: boolean };

/** Messages du moteur RDP en relecture. */
export type ReplayMessage =
  | { type: 'ready'; duration: number; frames: number }
  | { type: 'resize'; width: number; height: number }
  | { type: 'image'; x: number; y: number; width: number; height: number; rgba: string }
  | { type: 'position'; t: number }
  | { type: 'closed'; reason?: string | null };

export interface ReplayEngine {
  seek(t: number): void;
  close(): void;
}

export interface RdpPlayerOptions {
  viewer: string;
  start?: number;
  canReveal: boolean;
  reveal(): void;
  exportText(): void;
  /** Démarre le moteur ; ses messages arrivent par `onMessage`. */
  open(onMessage: (m: ReplayMessage) => void): Promise<ReplayEngine>;
}

const IDLE = 5;

const fmt = (s: number) => {
  s = Math.max(0, Math.floor(s));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};

// ---------- Frappe : codes de touche → caractères ----------

/** Une touche par code (jeu 1) : [normal, majuscule, AltGr]. */
type Layout = Record<number, [string, string, string?]>;

const LETTERS_US: Layout = {
  0x02: ['1', '!'], 0x03: ['2', '@'], 0x04: ['3', '#'], 0x05: ['4', '$'], 0x06: ['5', '%'], 0x07: ['6', '^'], 0x08: ['7', '&'], 0x09: ['8', '*'], 0x0a: ['9', '('], 0x0b: ['0', ')'], 0x0c: ['-', '_'], 0x0d: ['=', '+'],
  0x10: ['q', 'Q'], 0x11: ['w', 'W'], 0x12: ['e', 'E'], 0x13: ['r', 'R'], 0x14: ['t', 'T'], 0x15: ['y', 'Y'], 0x16: ['u', 'U'], 0x17: ['i', 'I'], 0x18: ['o', 'O'], 0x19: ['p', 'P'], 0x1a: ['[', '{'], 0x1b: [']', '}'],
  0x1e: ['a', 'A'], 0x1f: ['s', 'S'], 0x20: ['d', 'D'], 0x21: ['f', 'F'], 0x22: ['g', 'G'], 0x23: ['h', 'H'], 0x24: ['j', 'J'], 0x25: ['k', 'K'], 0x26: ['l', 'L'], 0x27: [';', ':'], 0x28: ['\'', '"'], 0x29: ['`', '~'], 0x2b: ['\\', '|'],
  0x2c: ['z', 'Z'], 0x2d: ['x', 'X'], 0x2e: ['c', 'C'], 0x2f: ['v', 'V'], 0x30: ['b', 'B'], 0x31: ['n', 'N'], 0x32: ['m', 'M'], 0x33: [',', '<'], 0x34: ['.', '>'], 0x35: ['/', '?'], 0x56: ['\\', '|'],
  0x39: [' ', ' '],
};

const LETTERS_FR: Layout = {
  0x02: ['&', '1'], 0x03: ['é', '2', '~'], 0x04: ['"', '3', '#'], 0x05: ['\'', '4', '{'], 0x06: ['(', '5', '['], 0x07: ['-', '6', '|'], 0x08: ['è', '7', '`'], 0x09: ['_', '8', '\\'], 0x0a: ['ç', '9', '^'], 0x0b: ['à', '0', '@'], 0x0c: [')', '°', ']'], 0x0d: ['=', '+', '}'],
  0x10: ['a', 'A'], 0x11: ['z', 'Z'], 0x12: ['e', 'E', '€'], 0x13: ['r', 'R'], 0x14: ['t', 'T'], 0x15: ['y', 'Y'], 0x16: ['u', 'U'], 0x17: ['i', 'I'], 0x18: ['o', 'O'], 0x19: ['p', 'P'], 0x1a: ['^', '¨'], 0x1b: ['$', '£', '¤'],
  0x1e: ['q', 'Q'], 0x1f: ['s', 'S'], 0x20: ['d', 'D'], 0x21: ['f', 'F'], 0x22: ['g', 'G'], 0x23: ['h', 'H'], 0x24: ['j', 'J'], 0x25: ['k', 'K'], 0x26: ['l', 'L'], 0x27: ['m', 'M'], 0x28: ['ù', '%'], 0x29: ['²', '²'], 0x2b: ['*', 'µ'],
  0x2c: ['w', 'W'], 0x2d: ['x', 'X'], 0x2e: ['c', 'C'], 0x2f: ['v', 'V'], 0x30: ['b', 'B'], 0x31: ['n', 'N'], 0x32: [',', '?'], 0x33: [';', '.'], 0x34: [':', '/'], 0x35: ['!', '§'], 0x56: ['<', '>'],
  0x39: [' ', ' '],
};

/** Pavé numérique (verrouillage numérique actif). */
const NUMPAD: Record<number, string> = { 0x47: '7', 0x48: '8', 0x49: '9', 0x4a: '-', 0x4b: '4', 0x4c: '5', 0x4d: '6', 0x4e: '+', 0x4f: '1', 0x50: '2', 0x51: '3', 0x52: '0', 0x53: '.', 0x37: '*' };

/** Touches spéciales, montrées comme des pastilles. Clé : code, « e » pour une touche étendue. */
const SPECIAL: Record<string, string> = {
  '28': t('Enter', 'Entrée'), 'e28': t('Enter', 'Entrée'), '14': '⌫', '15': 'Tab', '1': t('Esc', 'Échap'),
  'e83': t('Del', 'Suppr'), 'e71': t('Home', 'Début'), 'e79': t('End', 'Fin'), 'e72': '↑', 'e80': '↓', 'e75': '←', 'e77': '→', 'e82': 'Ins', 'e73': t('PgUp', 'Pg↑'), 'e81': t('PgDn', 'Pg↓'), 'e91': 'Win', 'e92': 'Win',
  '59': 'F1', '60': 'F2', '61': 'F3', '62': 'F4', '63': 'F5', '64': 'F6', '65': 'F7', '66': 'F8', '67': 'F9', '68': 'F10', '87': 'F11', '88': 'F12',
};

/** Disposition française (France, Belgique, Suisse romande, Canada, Luxembourg) : AZERTY sauf Canada/Suisse, gardés en AZERTY par simplicité. */
const isAzerty = (id: number) => [0x040c, 0x080c, 0x140c, 0x180c].includes(id & 0xffff);

/** Une ligne de frappe : du premier caractère à Entrée (ou un clic). */
interface Line { t: number; end: number; text: string; keys: { t: number; text?: string; chip?: string }[]; level: '' | 'w' | 'x' }

function typedLines(events: RdpEvent[], sensitive: string[]): Line[] {
  let layout = LETTERS_US;
  const mods = { shift: false, ctrl: false, alt: false, altgr: false, caps: false };
  const lines: Line[] = [];
  let cur: Line | null = null;
  const close = (at: number) => {
    if (cur) { cur.end = at; lines.push(cur); cur = null; }
  };
  const add = (at: number, text?: string, chip?: string) => {
    if (!cur) cur = { t: at, end: Infinity, text: '', keys: [], level: '' };
    cur.keys.push({ t: at, text, chip });
    if (text) cur.text += text;
    if (chip === '⌫') cur.text = cur.text.slice(0, -1);
  };
  for (const e of events) {
    if (e.k === 'clavier') { layout = isAzerty(e.disposition) ? LETTERS_FR : LETTERS_US; continue; }
    if (e.k === 'clic') { close(e.t); continue; }
    if (e.k === 'unicode') { if (!e.r) add(e.t, String.fromCharCode(e.u)); continue; }
    if (e.k !== 'touche') continue;
    const down = !e.r;
    // Modificateurs.
    if (e.c === 0x2a || e.c === 0x36) { mods.shift = down; continue; }
    if (e.c === 0x1d) { mods.ctrl = down; continue; }
    if (e.c === 0x38) { if (e.e) mods.altgr = down; else mods.alt = down; continue; }
    if (e.c === 0x3a) { if (down) mods.caps = !mods.caps; continue; }
    if (!down) continue;
    const special = SPECIAL[`${e.e ? 'e' : ''}${e.c}`];
    if (special) {
      add(e.t, undefined, special);
      if (e.c === 0x1c) close(e.t);
      continue;
    }
    if (!e.e && NUMPAD[e.c]) { add(e.t, NUMPAD[e.c]); continue; }
    if (e.e && e.c === 0x35) { add(e.t, '/'); continue; }
    const key = layout[e.c];
    if (!key) continue;
    if ((mods.ctrl && !mods.alt) || (mods.alt && !mods.ctrl && !mods.altgr)) {
      // Raccourci (Ctrl+C, Alt+Tab…) : une pastille.
      add(e.t, undefined, `${mods.ctrl ? 'Ctrl+' : 'Alt+'}${key[0].toUpperCase()}`);
      continue;
    }
    const altgr = mods.altgr || (mods.ctrl && mods.alt);
    const letter = /^[a-z]$/.test(key[0]);
    const upper = letter ? mods.shift !== mods.caps : mods.shift || (layout === LETTERS_FR && mods.caps && /^[0-9]$/.test(key[1]));
    add(e.t, altgr ? key[2] ?? '' : upper ? key[1] : key[0]);
  }
  close(Infinity);
  for (const l of lines) {
    const text = l.text.toLowerCase();
    l.level = sensitive.some((c) => text.includes(c)) ? 'x' : l.keys.some((k) => k.chip === 'Ctrl+C') ? 'w' : '';
  }
  return lines.filter((l) => l.keys.length);
}

export class RdpPlayer {
  private readonly events: RdpEvent[];
  private readonly duration: number;
  private readonly idle: [number, number][] = [];
  private readonly lines: Line[];
  private readonly clicks: RdpEvent[];
  private readonly clips: Extract<RdpEvent, { k: 'presse-papiers' }>[];
  private readonly moves: Extract<RdpEvent, { k: 'souris' | 'clic' }>[];
  private readonly withInput: boolean;
  private engine: ReplayEngine | null = null;
  private position = 0;
  private speed = 2;
  private skip = true;
  private subtitles = true;
  private playing = false;
  private frame = 0;
  private lastTick = 0;
  private skipTimer = 0;
  private current = -1;
  /** Temps demandé au moteur et pas encore rendu ; prochain temps à demander. */
  private inflight = false;
  private wanted: number | null = null;
  private sent = -1;
  private closed = false;
  private resizer!: ResizeObserver;

  private readonly canvas = h('canvas', { class: 'rp-canvas', width: '1280', height: '720' }) as HTMLCanvasElement;
  private readonly ctx = this.canvas.getContext('2d')!;
  private readonly cursor = h('div', { class: 'rp-cursor', hidden: true });
  private readonly ripple = h('div', { class: 'rp-click', hidden: true });
  private readonly loading = h('div', { class: 'rp-loading' }, t('Loading the recording…', 'Chargement de l\'enregistrement…'));
  private readonly stage = h('div', { class: 'rp-stage' }, this.canvas, this.cursor, this.ripple);
  private readonly screen = h('div', { class: 'ap-screen rp-screen' });
  private readonly subs = h('div', { class: 'ap-subs', hidden: true });
  private readonly skipNote = h('div', { class: 'ap-skip', hidden: true });
  private readonly track = h('div', { class: 'ap-track', role: 'slider', tabindex: '0', 'aria-label': t('Position in the session', 'Position dans la session'), 'aria-valuemin': '0' });
  private readonly done = h('div', { class: 'ap-done' });
  private readonly knob = h('div', { class: 'ap-knob' });
  private readonly clock = h('span', { class: 'ap-time' });
  private readonly playBtn = h('button', { class: 'ap-btn', 'aria-label': t('Play', 'Lire') });
  private readonly list = h('div', { class: 'ap-lines' });

  constructor(readonly el: HTMLElement, private readonly rec: RdpRecording, private readonly opts: RdpPlayerOptions) {
    this.events = [...rec.rdp.evenements].sort((a, b) => a.t - b.t);
    this.duration = Math.max(1, rec.rdp.duree + 1);
    // Pauses : rien de la part de l'utilisateur pendant plus de IDLE secondes.
    const activity = this.events.filter((e) => e.k !== 'clavier').map((e) => e.t);
    for (let i = 1; i < activity.length; i++) {
      if (activity[i] - activity[i - 1] > IDLE) this.idle.push([activity[i - 1] + 1, activity[i] - 0.5]);
    }
    if (activity.length && this.duration - activity[activity.length - 1] > IDLE + 2) this.idle.push([activity[activity.length - 1] + 1, this.duration - 1]);
    this.withInput = this.events.some((e) => e.k === 'touche' || e.k === 'unicode');
    this.lines = typedLines(this.events, rec.commandes_sensibles.map((c) => c.toLowerCase()).filter(Boolean));
    this.clicks = this.events.filter((e) => e.k === 'clic');
    this.clips = this.events.filter((e): e is Extract<RdpEvent, { k: 'presse-papiers' }> => e.k === 'presse-papiers');
    this.moves = this.events.filter((e): e is Extract<RdpEvent, { k: 'souris' | 'clic' }> => e.k === 'souris' || e.k === 'clic');
    this.build();
    this.resizer = new ResizeObserver(() => this.fit());
    this.resizer.observe(this.screen);
    this.render();
    this.opts.open((m) => this.onMessage(m)).then((engine) => {
      if (this.closed) { engine.close(); return; }
      this.engine = engine;
      this.seek(Math.max(0, (opts.start ?? 0) - 0.5));
    }).catch((e) => { this.loading.textContent = String(e?.message ?? e); this.loading.classList.add('err'); });
  }

  // ---------- Moteur ----------

  private onMessage(m: ReplayMessage) {
    switch (m.type) {
      case 'resize':
        this.canvas.width = m.width;
        this.canvas.height = m.height;
        this.fit();
        break;
      case 'image': {
        const bytes = Uint8ClampedArray.from(atob(m.rgba), (c) => c.charCodeAt(0));
        this.ctx.putImageData(new ImageData(bytes, m.width, m.height), m.x, m.y);
        break;
      }
      case 'position':
        this.loading.hidden = true;
        this.inflight = false;
        if (this.wanted != null) { const w = this.wanted; this.wanted = null; this.request(w); }
        break;
      case 'closed':
        this.loading.hidden = false;
        this.loading.textContent = m.reason || t('The RDP engine stopped', 'Le moteur RDP s\'est arrêté');
        this.loading.classList.add('err');
        break;
    }
  }

  /** Demande l'image à ce temps ; une seule demande à la fois, la dernière gagne. */
  private request(time: number) {
    if (!this.engine) return;
    if (this.inflight) { this.wanted = time; return; }
    if (Math.abs(time - this.sent) < 0.001) return;
    // En arrière : le moteur redécode depuis le début.
    if (time < this.sent) { this.loading.hidden = false; this.loading.textContent = t('Rewinding…', 'Retour en arrière…'); }
    this.inflight = true;
    this.sent = time;
    this.engine.seek(time);
  }

  /** L'image tient dans la place disponible, proportions gardées (souris et clics alignés dessus). */
  private fit() {
    const box = this.screen.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const scale = Math.min(box.width / this.canvas.width, box.height / this.canvas.height);
    this.stage.style.width = `${Math.floor(this.canvas.width * scale)}px`;
    this.stage.style.height = `${Math.floor(this.canvas.height * scale)}px`;
  }

  // ---------- Construction ----------

  private build() {
    const r = this.rec;
    const s = r.session;
    const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'medium' }) : '');
    const seal = r.signature === 'verifiee'
      ? h('span', { class: 'ap-seal ok', title: `SHA-256 ${r.empreinte}` }, t('✓ Signature checked', '✓ Signature vérifiée'))
      : r.signature === 'alteree'
        ? h('span', { class: 'ap-seal bad', title: `SHA-256 ${r.empreinte}` }, t('✗ File modified since the session', '✗ Fichier modifié depuis la session'))
        : h('span', { class: 'ap-seal', title: t('The signature is added at the end of the session', 'La signature est posée à la fin de la session') }, t('Not signed yet', 'Pas encore signé'));
    const masked = this.clips.filter((c) => c.masque).length;
    const actions = h('div', { class: 'ap-actions' },
      this.opts.canReveal && masked && !r.revele
        ? h('button', { class: 'btn sm', title: t('Shows the copied-pasted text. Written to the log.', 'Affiche le texte copié-collé. Inscrit au journal.'), onclick: () => this.opts.reveal() }, t(`Reveal ${masked} copy-paste(s)`, `Révéler ${masked} copier-coller`))
        : null,
      h('button', { class: 'btn sm', onclick: () => this.opts.exportText() }, icon('download', 14), t('Transcript', 'Transcription')));
    const head = h('div', { class: 'ap-head' },
      h('h2', {}, s.serveur, ' ', h('span', { class: 'badge proto-rdp' }, 'RDP'), ' ', h('span', { class: 'badge mode-enregistre' }, t('recorded', 'enregistré'))),
      h('span', { class: 'muted small' }, `${s.compte} · ${date(s.debut)} · ${fmt(this.duration)}${s.fin ? '' : t(' · ongoing', ' · en cours')}`),
      seal, actions);
    if (r.revele) head.append(h('div', { class: 'ap-revealed' }, t('Copied-pasted text revealed: this replay is written to the bastion\'s log.', 'Texte copié-collé révélé : cette relecture est inscrite au journal du bastion.')));

    this.screen.append(this.stage, this.loading,
      h('div', { class: 'ap-wm' }, t(`Viewed by ${this.opts.viewer}`, `Consulté par ${this.opts.viewer}`), h('br'), new Date().toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })),
      this.skipNote, this.subs);
    this.screen.addEventListener('click', () => this.toggle());

    // Barre de temps : pauses, frappe, clics, copier-coller.
    this.track.append(h('div', { class: 'ap-rail' }));
    const pct = (x: number) => (100 * x) / this.duration;
    for (const [a, b] of this.idle) this.track.append(h('div', { class: 'ap-idle', style: `left:${pct(a)}%;width:${pct(b - a)}%`, title: t(`${fmt(b - a)} pause`, `Pause de ${fmt(b - a)}`) }));
    this.track.append(this.done);
    for (const l of this.lines) this.track.append(h('div', { class: `ap-mk ${l.level}`, style: `left:${pct(l.t)}%`, title: `${fmt(l.t)}  ${l.text || l.keys.map((k) => k.chip).join(' ')}` }));
    for (const c of this.clicks) this.track.append(h('div', { class: 'ap-mk rp-clic', style: `left:${pct(c.t)}%`, title: `${fmt(c.t)}  ${t('click', 'clic')}` }));
    for (const c of this.clips) this.track.append(h('div', { class: 'ap-mk rp-clip', style: `left:${pct(c.t)}%`, title: `${fmt(c.t)}  ${this.clipLabel(c)}` }));
    this.track.append(this.knob);
    this.track.setAttribute('aria-valuemax', String(Math.round(this.duration)));
    const fromPointer = (e: PointerEvent) => {
      const box = this.track.getBoundingClientRect();
      this.seek(this.duration * Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)));
    };
    this.track.addEventListener('pointerdown', (e) => { this.track.setPointerCapture(e.pointerId); fromPointer(e); });
    this.track.addEventListener('pointermove', (e) => { if (this.track.hasPointerCapture(e.pointerId)) fromPointer(e); });

    const speed = h('select', { class: 'ap-speed', 'aria-label': t('Speed', 'Vitesse'), onchange: (e: Event) => { this.speed = Number((e.target as HTMLSelectElement).value); } },
      ...[1, 2, 4, 8, 16].map((v) => h('option', { value: String(v), selected: v === this.speed }, `${v}×`)));
    const toggleBtn = (label: (Node | string)[], title: string, on: boolean, change: (on: boolean) => void, disabled = false) => {
      const b = h('button', { class: 'ap-btn', 'aria-pressed': String(on), title, disabled }, ...label);
      b.addEventListener('click', () => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(v)); change(v); });
      return b;
    };
    const cc = toggleBtn([h('span', { class: 'ap-cc' }, 'CC'), t(' Keystrokes', ' Frappe')], this.withInput ? t('Subtitles: the keystrokes', 'Sous-titres : la frappe') : t('Keystrokes not recorded for this session', 'Frappe non enregistrée pour cette session'),
      this.withInput, (v) => { this.subtitles = v; this.render(); }, !this.withInput);
    this.subtitles = this.withInput;
    const full = h('button', { class: 'ap-btn', 'aria-label': t('Full screen', 'Plein écran'), title: t('Full screen', 'Plein écran'), onclick: () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else this.el.querySelector('.ap-main')?.requestFullscreen().catch(() => {});
    } }, '⛶');
    this.playBtn.addEventListener('click', () => this.toggle());
    const controls = h('div', { class: 'ap-controls' }, this.track,
      h('div', { class: 'ap-bar' },
        this.playBtn,
        h('button', { class: 'ap-btn', 'aria-label': t('Back 10 seconds', 'Reculer de 10 secondes'), onclick: () => this.seek(this.position - 10) }, '−10 s'),
        h('button', { class: 'ap-btn', 'aria-label': t('Forward 10 seconds', 'Avancer de 10 secondes'), onclick: () => this.seek(this.position + 10) }, '+10 s'),
        this.clock, h('span', { class: 'grow' }),
        toggleBtn([t('Skip pauses', 'Sauter les pauses')], t(`Skips moments without activity (more than ${IDLE} s)`, `Passe les moments sans activité (plus de ${IDLE} s)`), true, (v) => { this.skip = v; }),
        speed, cc, full));

    // Panneau : événements, informations.
    const tabs = h('div', { class: 'ap-tabs', role: 'tablist' });
    const evPane = h('div', { class: 'ap-pane' },
      this.withInput ? null : h('p', { class: 'ap-note' }, t('Keystrokes not recorded by the rule: clicks and copy-pastes only.', 'Frappe non enregistrée par la règle : clics et copier-coller seulement.')),
      this.list);
    const infoPane = h('div', { class: 'ap-pane', hidden: true }, this.info());
    const tab = (label: string, pane: HTMLElement, on: boolean) => {
      const b = h('button', { role: 'tab', 'aria-selected': String(on) }, label);
      b.addEventListener('click', () => {
        tabs.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        evPane.hidden = pane !== evPane;
        infoPane.hidden = pane !== infoPane;
      });
      return b;
    };
    tabs.append(tab(t('Events', 'Événements'), evPane, true), tab(t('Information', 'Informations'), infoPane, false));
    this.renderList();

    this.el.classList.add('audit-player');
    this.el.tabIndex = -1;
    this.el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); this.toggle(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.seek(this.position - 5); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.seek(this.position + 5); }
    });
    this.el.append(head, h('div', { class: 'ap-body' },
      h('div', { class: 'ap-main' }, this.screen, controls),
      h('aside', { class: 'ap-side' }, tabs, evPane, infoPane)));
  }

  private clipLabel(c: Extract<RdpEvent, { k: 'presse-papiers' }>): string {
    const where = c.sens === 'vers-serveur' ? t('Paste into the server', 'Collé vers le serveur') : t('Copied from the server', 'Copié depuis le serveur');
    if (c.texte != null) return `${where} : « ${c.texte.length > 200 ? `${c.texte.slice(0, 200)}…` : c.texte} »`;
    return t(`${where} · ${c.longueur ?? 0} characters (masked)`, `${where} · ${c.longueur ?? 0} caractères (masqué)`);
  }

  private info(): HTMLElement {
    const r = this.rec;
    const s = r.session;
    const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'medium' }) : t('ongoing', 'en cours'));
    const row = (k: string, v: Node | string) => [h('dt', {}, k), h('dd', {}, v)];
    const sig = { verifiee: t('checked with the bastion\'s key', 'vérifiée avec la clé du bastion'), alteree: t('DOES NOT MATCH: file modified', 'NE CORRESPOND PAS : fichier modifié'), absente: t('not added yet (session ongoing or interrupted)', 'pas encore posée (session en cours ou interrompue)') }[r.signature];
    return h('div', {},
      h('dl', { class: 'ap-kv' },
        ...row(t('Account', 'Compte'), s.compte),
        ...row(t('Server', 'Serveur'), s.serveur),
        ...row(t('From', 'Depuis'), s.adresse || '—'),
        ...row(t('Start', 'Début'), date(s.debut)),
        ...row(t('End', 'Fin'), date(s.fin)),
        ...row(t('Keystrokes', 'Frappe'), s.frappe ? t('recorded', 'enregistrée') : t('not recorded', 'non enregistrée')),
        ...row(t('Clicks', 'Clics'), String(this.clicks.length)),
        ...row(t('Copy-pastes', 'Copier-coller'), r.revele ? t(`${this.clips.length} (revealed)`, `${this.clips.length} (révélés)`) : String(this.clips.length)),
        ...row(t('Size', 'Taille'), `${Math.max(1, Math.round(s.octets / 1024 / 1024))} Mo`),
        ...row(t('Fingerprint', 'Empreinte'), h('code', {}, `SHA-256 ${r.empreinte}`)),
        ...row('Signature', h('span', { class: r.signature === 'alteree' ? 'ap-bad' : r.signature === 'verifiee' ? 'ap-ok' : '' }, sig))),
      h('p', { class: 'ap-note' }, r.consultations.length
        ? t('Replays: ', 'Relectures : ') + r.consultations.map((c) => `${c.qui} (${new Date(c.date).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })}${c.evenement.endsWith('revele') ? t(', revealed', ', révélée') : ''})`).join(', ') + '.'
        : t('First replay.', 'Première relecture.')));
  }

  /** Une ligne de frappe en éléments : texte et pastilles. */
  private lineNodes(l: Line, until = Infinity, chip = 'ap-key'): Node[] {
    const out: Node[] = [];
    let typed = '';
    const flush = () => { if (typed) { out.push(h('span', { class: 'ap-typed' }, typed)); typed = ''; } };
    for (const k of l.keys) {
      if (k.t > until) break;
      if (k.chip) { flush(); out.push(h('span', { class: `${chip}${k.chip === '⌫' ? ' del' : ''}` }, k.chip)); }
      else if (k.text) typed += k.text;
    }
    flush();
    return out;
  }

  /** Liste des événements : lignes tapées, copier-coller (les clics restent sur la barre). */
  private renderList() {
    type Item = { t: number; level: string; nodes: Node[] };
    const items: Item[] = [
      ...this.lines.map((l) => ({ t: l.t, level: l.level, nodes: this.lineNodes(l, Infinity, 'ap-key sm') })),
      ...this.clips.map((c) => ({ t: c.t, level: 'clip', nodes: [document.createTextNode(this.clipLabel(c))] })),
    ].sort((a, b) => a.t - b.t);
    this.list.replaceChildren();
    items.forEach((it, i) => {
      const b = h('button', { class: `ap-line ${it.level}`, 'data-i': String(i), 'data-t': String(it.t) }, h('span', { class: 't' }, fmt(it.t)), h('code', {}, ...it.nodes));
      b.addEventListener('click', () => this.seek(Math.max(0, it.t - 0.4)));
      this.list.append(b);
    });
    if (!items.length) this.list.append(h('p', { class: 'ap-note' }, t(`No keystrokes or copy-paste. ${this.clicks.length} click(s) on the timeline.`, `Ni frappe ni copier-coller. ${this.clicks.length} clic(s) sur la barre de temps.`)));
    this.current = -1;
    this.markCurrent();
  }

  private markCurrent() {
    let now = -1;
    this.list.querySelectorAll<HTMLElement>('.ap-line').forEach((row, i) => { if (Number(row.dataset.t) <= this.position) now = i; });
    if (now === this.current) return;
    this.current = now;
    this.list.querySelectorAll('.ap-line.now').forEach((x) => x.classList.remove('now'));
    const row = this.list.querySelector(`.ap-line[data-i="${now}"]`);
    if (row) {
      row.classList.add('now');
      if (this.playing) row.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------- Lecture ----------

  private render() {
    const p = (100 * this.position) / this.duration;
    this.done.style.width = `${p}%`;
    this.knob.style.left = `${p}%`;
    this.clock.textContent = `${fmt(this.position)} / ${fmt(this.duration)}`;
    this.track.setAttribute('aria-valuenow', String(Math.round(this.position)));
    this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play', 14));
    this.playBtn.setAttribute('aria-label', this.playing ? 'Pause' : t('Play', 'Lire'));
    this.renderPointer();
    this.renderSubs();
    this.markCurrent();
  }

  /** Souris : dernière position connue ; un cercle pendant une seconde après un clic. */
  private renderPointer() {
    let last: (typeof this.moves)[number] | undefined;
    for (const m of this.moves) { if (m.t <= this.position) last = m; else break; }
    if (!last) { this.cursor.hidden = true; this.ripple.hidden = true; return; }
    const left = `${(100 * last.x) / this.canvas.width}%`;
    const top = `${(100 * last.y) / this.canvas.height}%`;
    this.cursor.hidden = false;
    this.cursor.style.left = left;
    this.cursor.style.top = top;
    const click = last.k === 'clic' && this.position - last.t < 1;
    this.ripple.hidden = !click;
    if (click) { this.ripple.style.left = left; this.ripple.style.top = top; }
  }

  private renderSubs() {
    if (!this.subtitles || !this.withInput) { this.subs.hidden = true; return; }
    let line: Line | undefined;
    for (const l of this.lines) { if (l.t <= this.position) line = l; else break; }
    const ended = !!line && line.end <= this.position;
    if (!line || (ended && this.position - line.end > 2.5)) { this.subs.hidden = true; return; }
    this.subs.hidden = false;
    this.subs.classList.toggle('fade', ended);
    this.subs.replaceChildren(h('span', { class: 'ap-who' }, this.rec.session.compte.toUpperCase()), ...this.lineNodes(line, this.position), ended ? '' : h('span', { class: 'ap-caret' }));
  }

  private seek(time: number) {
    this.position = Math.max(0, Math.min(this.duration, time));
    this.lastTick = performance.now();
    this.request(this.position);
    this.render();
  }

  private toggle() {
    if (this.playing) {
      this.playing = false;
      cancelAnimationFrame(this.frame);
    } else {
      if (this.position >= this.duration) this.seek(0);
      this.playing = true;
      this.lastTick = performance.now();
      this.frame = requestAnimationFrame(() => this.tick());
    }
    this.render();
  }

  private tick() {
    if (!this.playing) return;
    const now = performance.now();
    let pos = this.position + ((now - this.lastTick) / 1000) * this.speed;
    this.lastTick = now;
    if (this.skip) {
      for (const [a, b] of this.idle) {
        if (pos > a && pos < b) {
          pos = b;
          this.skipNote.textContent = t(`⏭ ${fmt(b - a)} pause skipped`, `⏭ Pause de ${fmt(b - a)} sautée`);
          this.skipNote.hidden = false;
          clearTimeout(this.skipTimer);
          this.skipTimer = window.setTimeout(() => { this.skipNote.hidden = true; }, 1800);
        }
      }
    }
    this.position = Math.min(this.duration, pos);
    this.request(this.position);
    if (this.position >= this.duration) this.playing = false;
    this.render();
    if (this.playing) this.frame = requestAnimationFrame(() => this.tick());
  }

  /** Transcription horodatée : frappe, clics et copier-coller, avec l'état de la signature. */
  transcript(): string {
    const s = this.rec.session;
    const head = [
      t(`Remote Desktop session ${s.id}`, `Session Bureau à distance ${s.id}`),
      t(`Account ${s.compte} · server ${s.serveur}`, `Compte ${s.compte} · serveur ${s.serveur}`),
      t(`Start ${new Date(s.debut).toLocaleString(LOCALE)} · end ${s.fin ? new Date(s.fin).toLocaleString(LOCALE) : 'ongoing'}`,
        `Début ${new Date(s.debut).toLocaleString(LOCALE)} · fin ${s.fin ? new Date(s.fin).toLocaleString(LOCALE) : 'en cours'}`),
      `Signature ${this.rec.signature} · SHA-256 ${this.rec.empreinte}`,
      this.withInput ? t('Keystrokes recorded', 'Frappe enregistrée') : t('Keystrokes not recorded', 'Frappe non enregistrée'),
      '',
    ];
    const rows: [number, string][] = [
      ...this.lines.map((l): [number, string] => [l.t, l.keys.map((k) => k.text ?? `[${k.chip}]`).join('')]),
      ...this.clicks.map((c): [number, string] => [c.t, t(`(click ${c.k === 'clic' ? `${c.x},${c.y}` : ''})`, `(clic ${c.k === 'clic' ? `${c.x},${c.y}` : ''})`)]),
      ...this.clips.map((c): [number, string] => [c.t, `(${this.clipLabel(c)})`]),
    ].sort((a, b) => a[0] - b[0]);
    return [...head, ...rows.map(([at, text]) => `[${fmt(at)}] ${text}`), ''].join('\n');
  }

  dispose() {
    this.closed = true;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.skipTimer);
    this.resizer.disconnect();
    this.engine?.close();
  }
}
