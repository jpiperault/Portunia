// Lecteur d'audit des sessions Heimdia : comme une vidéo, avec la frappe en sous-titres,
// les pauses sautées, des repères sur la barre de temps et la liste des lignes tapées.
// Chargé seulement à l'ouverture d'un enregistrement (xterm).
import { Terminal } from '@xterm/xterm';
import { h, icon } from './dom';
import { fontStack, settings } from './settings';
import { terminalTheme } from './theme';

/** Réponse de GET /audit/sessions/{id}/enregistrement. */
export interface AuditRecording {
  session: { id: string; compte: string; serveur: string; type: string; detail: string; mode: string; adresse: string; debut: string; fin: string | null; frappe: boolean; octets: number };
  cast: string;
  revele: boolean;
  saisies_masquees: number;
  signature: 'verifiee' | 'alteree' | 'absente';
  empreinte: string;
  commandes_sensibles: string[];
  consultations: { qui: string; date: string; evenement: string }[];
}

export interface AuditPlayerOptions {
  /** Compte qui regarde (filigrane). */
  viewer: string;
  /** Moment où démarrer (résultat d'une recherche). */
  start?: number;
  canReveal: boolean;
  reveal(): void;
  exportCast(): void;
  exportText(): void;
}

interface Ev { t: number; k: string; d: string }
/** Une ligne tapée (ou repérée à l'écran) : de la première touche à Entrée. */
interface Line { t: number; end: number; keys: Ev[]; text: string; secret: boolean; level: '' | 'w' | 'x'; screen: boolean }

const KEYS: Record<string, string> = { '\r': 'Entrée', '\n': 'Entrée', '\t': 'Tab', '\x03': 'Ctrl+C', '\x04': 'Ctrl+D', '\x7f': '⌫', '\b': '⌫', '\x1b[A': '↑', '\x1b[B': '↓', '\x1b[C': '→', '\x1b[D': '←', '\x1bOA': '↑', '\x1bOB': '↓', '\x1bOC': '→', '\x1bOD': '←', '\x1b': 'Échap' };
const IDLE = 5;
const ERROR = /\b(error|erreur|failed|échec|denied|refusé|not found|introuvable|no such file|permission denied|segmentation fault)\b/i;

const fmt = (s: number) => {
  s = Math.max(0, Math.floor(s));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Découpe une saisie en touches : caractères, séquences d'échappement, touches de contrôle. */
function splitKeys(data: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] === '\x1b' && (data[i + 1] === '[' || data[i + 1] === 'O')) {
      let j = i + 2;
      while (j < data.length && !/[A-Za-z~]/.test(data[j])) j++;
      out.push(data.slice(i, j + 1));
      i = j;
    } else out.push(data[i]);
  }
  return out;
}

/** Texte lisible d'une sortie de terminal : sans couleurs ni déplacements du curseur. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[()#][0-9A-Za-z]|\x1b[=>78DEHMc]/g, '');
}

function parse(cast: string) {
  const lines = cast.split('\n').filter(Boolean);
  const header = JSON.parse(lines[0] ?? '{}') as { width?: number; height?: number };
  const events: Ev[] = [];
  for (const row of lines.slice(1)) {
    try {
      const [t, k, d] = JSON.parse(row) as [number, string, string];
      events.push({ t, k, d });
    } catch { /* ligne illisible ignorée */ }
  }
  // Taille absente ou absurde (client sans terminal) : 80 × 24.
  const cols = (header.width ?? 0) >= 10 ? header.width! : 80;
  const rows = (header.height ?? 0) >= 3 ? header.height! : 24;
  return { cols, rows, events };
}

/** Lignes tapées (« i », et « x » pour les saisies masquées par le bastion). */
function typedLines(events: Ev[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const e of events) {
    if (e.k !== 'i' && e.k !== 'x') continue;
    if (!cur) cur = { t: e.t, end: Infinity, keys: [], text: '', secret: false, level: '', screen: false };
    if (e.k === 'x') {
      cur.secret = true;
      cur.keys.push(e);
      continue;
    }
    for (const key of splitKeys(e.d)) {
      cur.keys.push({ t: e.t, k: 'i', d: key });
      if (key === '\x7f' || key === '\b') cur.text = cur.text.slice(0, -1);
      else if (key.length === 1 && key >= ' ') cur.text += key;
      if (key === '\r' || key === '\n' || key === '\x03') {
        cur.end = e.t;
        lines.push(cur);
        cur = null;
        break;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Sans frappe enregistrée : commandes repérées à l'écran, après une invite « … $ » ou « … # ». */
function screenLines(events: Ev[]): Line[] {
  const lines: Line[] = [];
  let buf = '';
  for (const e of events) {
    if (e.k !== 'o') continue;
    buf += e.d;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const raw = stripAnsi(buf.slice(0, nl)).replace(/\r/g, '');
      buf = buf.slice(nl + 1);
      const m = /^\S*[@:]\S*\s?[$#>]\s+(\S.*)$/.exec(raw.trimEnd()) ?? /^\S*\s?[$#]\s+(\S.*)$/.exec(raw.trimEnd());
      if (m && m[1].length < 400) lines.push({ t: e.t, end: e.t, keys: [], text: m[1], secret: false, level: '', screen: true });
      nl = buf.indexOf('\n');
    }
  }
  return lines;
}

export class AuditPlayer {
  private readonly term: Terminal;
  private readonly events: Ev[];
  private readonly duration: number;
  private readonly idle: [number, number][] = [];
  private readonly lines: Line[];
  private readonly errors: number[] = [];
  private readonly withInput: boolean;
  private index = 0;
  private position = 0;
  private speed = 2;
  private skip = true;
  private subtitles = true;
  private playing = false;
  private frame = 0;
  private lastTick = 0;
  private skipTimer = 0;
  private current = -1;

  private readonly screen = h('div', { class: 'ap-screen' });
  private readonly subs = h('div', { class: 'ap-subs', hidden: true });
  private readonly skipNote = h('div', { class: 'ap-skip', hidden: true });
  private readonly track = h('div', { class: 'ap-track', role: 'slider', tabindex: '0', 'aria-label': 'Position dans la session', 'aria-valuemin': '0' });
  private readonly done = h('div', { class: 'ap-done' });
  private readonly knob = h('div', { class: 'ap-knob' });
  private readonly clock = h('span', { class: 'ap-time' });
  private readonly playBtn = h('button', { class: 'ap-btn', 'aria-label': 'Lire' });
  private readonly list = h('div', { class: 'ap-lines' });
  private readonly search = h('input', { type: 'search', class: 'input', placeholder: 'Rechercher dans la frappe', 'aria-label': 'Rechercher dans la frappe' }) as HTMLInputElement;

  constructor(readonly el: HTMLElement, private readonly rec: AuditRecording, private readonly opts: AuditPlayerOptions) {
    const parsed = parse(rec.cast);
    this.events = parsed.events;
    this.duration = (this.events[this.events.length - 1]?.t ?? 0) + 1;
    for (let i = 1; i < this.events.length; i++) {
      const a = this.events[i - 1].t, b = this.events[i].t;
      if (b - a > IDLE) this.idle.push([a + 1, b - 0.5]);
    }
    this.withInput = this.events.some((e) => e.k === 'i' || e.k === 'x');
    this.lines = this.withInput ? typedLines(this.events) : screenLines(this.events);
    const sensitive = rec.commandes_sensibles.map((c) => c.toLowerCase()).filter(Boolean);
    for (const l of this.lines) {
      const text = l.text.toLowerCase();
      l.level = sensitive.some((c) => text.includes(c)) ? 'x' : /^sudo\b/.test(text) || l.secret || l.keys.some((k) => k.d === '\x03') ? 'w' : '';
    }
    let lastErr = -10;
    for (const e of this.events) {
      if (e.k === 'o' && e.t - lastErr > 2 && ERROR.test(stripAnsi(e.d))) { this.errors.push(e.t); lastErr = e.t; }
    }

    const s = settings();
    this.term = new Terminal({ fontFamily: fontStack(s), fontSize: s.fontSize, cols: parsed.cols, rows: parsed.rows, disableStdin: true, cursorBlink: false, theme: terminalTheme(), scrollback: 2000 });
    this.build();
    this.term.open(this.screen.querySelector('.ap-term') as HTMLElement);
    this.seek(Math.max(0, (opts.start ?? 0) - 0.5));
    if (opts.start == null) this.toggle();
  }

  // ---------- Construction ----------

  private build() {
    const r = this.rec;
    const s = r.session;
    const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' }) : '');
    const seal = r.signature === 'verifiee'
      ? h('span', { class: 'ap-seal ok', title: `SHA-256 ${r.empreinte}` }, '✓ Signature vérifiée')
      : r.signature === 'alteree'
        ? h('span', { class: 'ap-seal bad', title: `SHA-256 ${r.empreinte}` }, '✗ Fichier modifié depuis la session')
        : h('span', { class: 'ap-seal', title: 'La signature est posée à la fin de la session' }, 'Pas encore signé');
    const actions = h('div', { class: 'ap-actions' },
      this.opts.canReveal && r.saisies_masquees && !r.revele
        ? h('button', { class: 'btn sm', title: 'Affiche en clair les saisies sans écho (mots de passe). Inscrit au journal.', onclick: () => this.opts.reveal() }, `Révéler ${r.saisies_masquees} saisie(s) masquée(s)`)
        : null,
      h('button', { class: 'btn sm', title: r.revele ? 'Fichier d\'origine, signé par le bastion' : 'Copie masquée (sans les saisies sans écho), non signée', onclick: () => this.opts.exportCast() }, icon('download', 14), 'Enregistrement .cast'),
      h('button', { class: 'btn sm', onclick: () => this.opts.exportText() }, icon('download', 14), 'Transcription'));
    const head = h('div', { class: 'ap-head' },
      h('h2', {}, s.serveur, ' ', s.mode ? h('span', { class: `badge mode-${s.mode}` }, s.mode === 'enregistre' ? 'enregistré' : s.mode) : null),
      h('span', { class: 'muted small' }, `${s.compte} · ${date(s.debut)} · ${fmt(this.duration)}${s.fin ? '' : ' · en cours'}`),
      seal, actions);
    if (r.revele) head.append(h('div', { class: 'ap-revealed' }, 'Saisies masquées révélées : cette relecture est inscrite au journal du bastion.'));

    // Écran : terminal, filigrane, sous-titres.
    this.screen.append(
      h('div', { class: 'ap-term' }),
      h('div', { class: 'ap-wm' }, `Consulté par ${this.opts.viewer}`, h('br'), new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })),
      this.skipNote, this.subs);
    this.screen.addEventListener('click', () => this.toggle());

    // Barre de temps : pauses hachurées, repères.
    this.track.append(h('div', { class: 'ap-rail' }));
    for (const [a, b] of this.idle) {
      this.track.append(h('div', { class: 'ap-idle', style: `left:${(100 * a) / this.duration}%;width:${(100 * (b - a)) / this.duration}%`, title: `Pause de ${fmt(b - a)}` }));
    }
    this.track.append(this.done);
    for (const l of this.lines) {
      this.track.append(h('div', { class: `ap-mk ${l.level}`, style: `left:${(100 * l.t) / this.duration}%`, title: `${fmt(l.t)}  ${l.secret ? '(saisie masquée)' : l.text}` }));
    }
    for (const t of this.errors) this.track.append(h('div', { class: 'ap-mk err', style: `left:${(100 * t) / this.duration}%`, title: `${fmt(t)}  erreur affichée` }));
    this.track.append(this.knob);
    this.track.setAttribute('aria-valuemax', String(Math.round(this.duration)));
    const fromPointer = (e: PointerEvent) => {
      const box = this.track.getBoundingClientRect();
      this.seek(this.duration * Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)));
    };
    this.track.addEventListener('pointerdown', (e) => { this.track.setPointerCapture(e.pointerId); fromPointer(e); });
    this.track.addEventListener('pointermove', (e) => { if (this.track.hasPointerCapture(e.pointerId)) fromPointer(e); });

    const speed = h('select', { class: 'ap-speed', 'aria-label': 'Vitesse', onchange: (e: Event) => { this.speed = Number((e.target as HTMLSelectElement).value); } },
      ...[1, 2, 4, 8, 16].map((v) => h('option', { value: String(v), selected: v === this.speed }, `${v}×`)));
    const toggleBtn = (label: (Node | string)[], title: string, on: boolean, change: (on: boolean) => void, disabled = false) => {
      const b = h('button', { class: 'ap-btn', 'aria-pressed': String(on), title, disabled }, ...label);
      b.addEventListener('click', () => { const v = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(v)); change(v); });
      return b;
    };
    const cc = toggleBtn([h('span', { class: 'ap-cc' }, 'CC'), ' Frappe'], this.withInput ? 'Sous-titres : la frappe' : 'Frappe non enregistrée pour cette session',
      this.withInput, (v) => { this.subtitles = v; this.render(); }, !this.withInput);
    this.subtitles = this.withInput;
    const full = h('button', { class: 'ap-btn', 'aria-label': 'Plein écran', title: 'Plein écran', onclick: () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else this.el.querySelector('.ap-main')?.requestFullscreen().catch(() => {});
    } }, '⛶');
    this.playBtn.addEventListener('click', () => this.toggle());
    const controls = h('div', { class: 'ap-controls' }, this.track,
      h('div', { class: 'ap-bar' },
        this.playBtn,
        h('button', { class: 'ap-btn', 'aria-label': 'Reculer de 10 secondes', onclick: () => this.seek(this.position - 10) }, '−10 s'),
        h('button', { class: 'ap-btn', 'aria-label': 'Avancer de 10 secondes', onclick: () => this.seek(this.position + 10) }, '+10 s'),
        this.clock, h('span', { class: 'grow' }),
        toggleBtn(['Sauter les pauses'], `Passe les moments sans activité (plus de ${IDLE} s)`, true, (v) => { this.skip = v; }),
        speed, cc, full));

    // Panneau : frappe ou commandes, informations.
    const tabs = h('div', { class: 'ap-tabs', role: 'tablist' });
    const linesPane = h('div', { class: 'ap-pane' },
      this.search,
      this.withInput ? null : h('p', { class: 'ap-note' }, 'Frappe non enregistrée par la règle. Commandes repérées à l\'écran :'),
      this.list);
    const infoPane = h('div', { class: 'ap-pane', hidden: true }, this.info());
    const tab = (label: string, pane: HTMLElement, on: boolean) => {
      const b = h('button', { role: 'tab', 'aria-selected': String(on) }, label);
      b.addEventListener('click', () => {
        tabs.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        linesPane.hidden = pane !== linesPane;
        infoPane.hidden = pane !== infoPane;
      });
      return b;
    };
    tabs.append(tab(this.withInput ? 'Frappe' : 'Commandes', linesPane, true), tab('Informations', infoPane, false));
    this.search.addEventListener('input', () => this.renderList());
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
      h('aside', { class: 'ap-side' }, tabs, linesPane, infoPane)));
  }

  private info(): HTMLElement {
    const r = this.rec;
    const s = r.session;
    const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' }) : 'en cours');
    const row = (k: string, v: Node | string) => [h('dt', {}, k), h('dd', {}, v)];
    const sig = { verifiee: 'vérifiée avec la clé du bastion', alteree: 'NE CORRESPOND PAS : fichier modifié', absente: 'pas encore posée (session en cours ou interrompue)' }[r.signature];
    return h('div', {},
      h('dl', { class: 'ap-kv' },
        ...row('Compte', s.compte),
        ...row('Serveur', s.serveur),
        ...row('Mode', s.mode || '—'),
        ...row('Type', s.detail ? `${s.type} · ${s.detail}` : s.type),
        ...row('Depuis', s.adresse || '—'),
        ...row('Début', date(s.debut)),
        ...row('Fin', date(s.fin)),
        ...row('Frappe', s.frappe ? 'enregistrée' : 'non enregistrée'),
        ...row('Saisies masquées', r.revele ? `${r.saisies_masquees} (révélées)` : String(r.saisies_masquees)),
        ...row('Taille', `${Math.max(1, Math.round(s.octets / 1024))} Ko`),
        ...row('Empreinte', h('code', {}, `SHA-256 ${r.empreinte}`)),
        ...row('Signature', h('span', { class: r.signature === 'alteree' ? 'ap-bad' : r.signature === 'verifiee' ? 'ap-ok' : '' }, sig))),
      h('p', { class: 'ap-note' }, r.consultations.length
        ? `Relectures : ${r.consultations.map((c) => `${c.qui} (${new Date(c.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}${c.evenement.endsWith('revele') ? ', révélée' : ''})`).join(', ')}.`
        : 'Première relecture.'));
  }

  private keyChip(cls: string, text: string) {
    return h('span', { class: cls }, text);
  }

  /** Une ligne tapée en éléments : texte, touches spéciales, saisies masquées. */
  private lineNodes(l: Line, until = Infinity, chipClass = 'ap-key', maskClass = 'ap-mask'): Node[] {
    if (l.screen) return [document.createTextNode(l.text)];
    const out: Node[] = [];
    let typed = '';
    let dots = 0;
    const flush = () => {
      if (typed) { out.push(h('span', { class: 'ap-typed' }, typed)); typed = ''; }
      if (dots) { out.push(h('span', { class: 'ap-typed' }, '•'.repeat(dots)), this.keyChip(maskClass, 'saisie sans écho, masquée')); dots = 0; }
    };
    for (const k of l.keys) {
      if (k.t > until) break;
      if (k.k === 'x') { if (typed) flush(); dots += [...k.d].length; continue; }
      if (dots) flush();
      const name = KEYS[k.d];
      if (name) { flush(); out.push(this.keyChip(`${chipClass}${name === '⌫' ? ' del' : ''}`, name)); }
      else if (k.d.length === 1 && k.d >= ' ') typed += k.d;
    }
    flush();
    return out;
  }

  private renderList() {
    const q = this.search.value.trim().toLowerCase();
    this.list.replaceChildren();
    this.lines.forEach((l, i) => {
      if (q && !l.text.toLowerCase().includes(q)) return;
      const b = h('button', { class: `ap-line ${l.level}`, 'data-i': String(i) },
        h('span', { class: 't' }, fmt(l.t)),
        h('code', {}, ...this.lineNodes(l, Infinity, 'ap-key sm', 'ap-mask sm')));
      b.addEventListener('click', () => this.seek(Math.max(0, l.t - 0.4)));
      this.list.append(b);
    });
    if (!this.list.childElementCount) this.list.append(h('p', { class: 'ap-note' }, q ? 'Rien trouvé.' : 'Aucune ligne tapée.'));
    this.current = -1;
    this.markCurrent();
  }

  private markCurrent() {
    let now = -1;
    for (let i = 0; i < this.lines.length && this.lines[i].t <= this.position; i++) now = i;
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
    this.playBtn.setAttribute('aria-label', this.playing ? 'Pause' : 'Lire');
    this.renderSubs();
    this.markCurrent();
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

  /** Écrit au terminal les événements jusqu'à la position courante. */
  private flush() {
    let out = '';
    while (this.index < this.events.length && this.events[this.index].t <= this.position) {
      const e = this.events[this.index++];
      if (e.k === 'o') out += e.d;
      else if (e.k === 'r') {
        const [c, r] = e.d.split('x').map(Number);
        if (out) { this.term.write(out); out = ''; }
        if (c >= 10 && r >= 3) this.term.resize(c, r);
      }
    }
    if (out) this.term.write(out);
  }

  private seek(time: number) {
    const t = Math.max(0, Math.min(this.duration, time));
    if (t < this.position || this.index === 0) {
      this.term.reset();
      this.index = 0;
    }
    this.position = t;
    this.flush();
    this.lastTick = performance.now();
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
    let t = this.position + ((now - this.lastTick) / 1000) * this.speed;
    this.lastTick = now;
    if (this.skip) {
      for (const [a, b] of this.idle) {
        if (t > a && t < b) {
          t = b;
          this.skipNote.textContent = `⏭ Pause de ${fmt(b - a)} sautée`;
          this.skipNote.hidden = false;
          clearTimeout(this.skipTimer);
          this.skipTimer = window.setTimeout(() => { this.skipNote.hidden = true; }, 1800);
        }
      }
    }
    this.position = Math.min(this.duration, t);
    this.flush();
    if (this.position >= this.duration) this.playing = false;
    this.render();
    if (this.playing) this.frame = requestAnimationFrame(() => this.tick());
  }

  /** Transcription horodatée : les lignes tapées (ou repérées), avec l'état de la signature. */
  transcript(): string {
    const s = this.rec.session;
    const head = [
      `Session ${s.id}`,
      `Compte ${s.compte} · serveur ${s.serveur} · mode ${s.mode || '—'}`,
      `Début ${new Date(s.debut).toLocaleString('fr-FR')} · fin ${s.fin ? new Date(s.fin).toLocaleString('fr-FR') : 'en cours'}`,
      `Signature ${this.rec.signature} · SHA-256 ${this.rec.empreinte}`,
      this.withInput ? (this.rec.revele ? 'Frappe enregistrée, saisies masquées révélées' : 'Frappe enregistrée, saisies sans écho masquées') : 'Frappe non enregistrée : commandes repérées à l\'écran',
      '',
    ];
    const body = this.lines.map((l) => {
      const keys = l.screen ? l.text : l.keys.map((k) => (k.k === 'x' ? '•'.repeat([...k.d].length) : KEYS[k.d] ? `[${KEYS[k.d]}]` : k.d.length === 1 && k.d >= ' ' ? k.d : '')).join('');
      return `[${fmt(l.t)}] ${keys}`;
    });
    return [...head, ...body, ''].join('\n');
  }

  dispose() {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.skipTimer);
    this.term.dispose();
  }
}
