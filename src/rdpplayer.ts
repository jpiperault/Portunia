// Lecteur des sessions Bureau à distance enregistrées par une Gate.
// L'image est décodée par le moteur RDP (portunia-rdp) à partir du flux enregistré ; ce
// lecteur l'affiche, avec la souris, les clics, les copier-coller et, si la règle l'a
// enregistrée, la frappe en sous-titres. Mêmes commandes que le lecteur des sessions SSH.
import { h, icon } from './dom';
import { LOCALE, t } from './i18n';
import { detectLayout, LayoutChoice, Line, lineText, typedLines } from './rdpkeys';
import { drawPixels } from './screen';
import type { VideoSource } from './videoexport';

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
  | { t: number; k: 'voyants'; f: number }
  | { t: number; k: 'touche'; c: number; e: boolean; r: boolean }
  | { t: number; k: 'unicode'; u: number; r: boolean }
  | { t: number; k: 'clic'; x: number; y: number; b: 'g' | 'd' | 'm' }
  | { t: number; k: 'souris'; x: number; y: number }
  | { t: number; k: 'presse-papiers'; sens: 'vers-serveur' | 'vers-poste'; texte: string | null; longueur?: number; masque?: boolean }
  // Fichier copié par le presse-papiers (Portunia Gate 0.28 et suivantes).
  | { t: number; k: 'fichier'; sens: 'vers-serveur' | 'vers-poste'; nom: string; taille: number; sha256: string; copie?: boolean; incomplet?: boolean };

/** Messages du moteur RDP en relecture. */
export type ReplayMessage =
  | { type: 'ready'; duration: number; frames: number }
  | { type: 'resize'; width: number; height: number }
  | ArrayBuffer
  | { type: 'position'; t: number }
  | { type: 'closed'; reason?: string | null };

export interface ReplayEngine {
  seek(t: number): void;
  /** Session en direct : charge les images arrivées depuis ; renvoie combien. */
  more?(): Promise<number>;
  close(): void;
}

export interface RdpPlayerOptions {
  viewer: string;
  start?: number;
  canReveal: boolean;
  reveal(): void;
  exportText(): void;
  /** Vidéo MP4 de la relecture (absent : pas de bouton). */
  exportVideo?(): void;
  /** Ouvre le lecteur dans sa propre fenêtre (absent : déjà détaché). */
  detach?(): void;
  /** Démarre le moteur ; ses messages arrivent par `onMessage`. */
  open(onMessage: (m: ReplayMessage) => void): Promise<ReplayEngine>;
}

const IDLE = 5;
const LAYOUT_KEY = 'portunia.rdpReplayLayout';

const fmt = (s: number) => {
  s = Math.max(0, Math.floor(s));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};

export class RdpPlayer {
  private events: RdpEvent[] = [];
  private duration = 1;
  private idle: [number, number][] = [];
  private lines: Line[] = [];
  private sensitive: string[] = [];
  private layout: LayoutChoice = 'auto';
  private clicks: RdpEvent[] = [];
  private clips: Extract<RdpEvent, { k: 'presse-papiers' }>[] = [];
  private files: Extract<RdpEvent, { k: 'fichier' }>[] = [];
  private moves: Extract<RdpEvent, { k: 'souris' | 'clic' }>[] = [];
  private withInput = false;
  /** Session encore ouverte : la relecture suit la fin (voir `extend`). */
  private live: boolean;
  /** Relecture de l'enregistrement qui grandit, arrêtée à la fermeture du lecteur. */
  liveTimer = 0;
  private readonly liveBadge = h('span', { class: 'ap-live', hidden: true }, t('● LIVE', '● EN DIRECT'));
  private readonly headInfo = h('span', { class: 'muted small' });
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
  /** Attentes d'une image rendue (vidéo), libérées au message « position ». */
  private waiters: (() => void)[] = [];
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

  constructor(readonly el: HTMLElement, private rec: RdpRecording, private readonly opts: RdpPlayerOptions) {
    try { this.layout = (localStorage.getItem(LAYOUT_KEY) as LayoutChoice | null) ?? 'auto'; } catch { /* valeur par défaut */ }
    this.analyze(rec);
    this.live = !rec.session.fin;
    this.build();
    this.resizer = new ResizeObserver(() => this.fit());
    this.resizer.observe(this.screen);
    this.render();
    this.opts.open((m) => this.onMessage(m)).then((engine) => {
      if (this.closed) { engine.close(); return; }
      this.engine = engine;
      // En direct : on arrive à la fin, là où se passe la session.
      this.seek(this.live && opts.start == null ? this.duration : Math.max(0, (opts.start ?? 0) - 0.5));
    }).catch((e) => { this.loading.textContent = String(e?.message ?? e); this.loading.classList.add('err'); });
  }

  /** Événements, durée, pauses et repères de l'enregistrement. */
  private analyze(rec: RdpRecording) {
    this.events = [...rec.rdp.evenements].sort((a, b) => a.t - b.t);
    this.duration = Math.max(1, rec.rdp.duree + 1);
    // Pauses : rien de la part de l'utilisateur pendant plus de IDLE secondes.
    this.idle = [];
    const activity = this.events.filter((e) => e.k !== 'clavier' && e.k !== 'voyants').map((e) => e.t);
    for (let i = 1; i < activity.length; i++) {
      if (activity[i] - activity[i - 1] > IDLE) this.idle.push([activity[i - 1] + 1, activity[i] - 0.5]);
    }
    if (activity.length && this.duration - activity[activity.length - 1] > IDLE + 2) this.idle.push([activity[activity.length - 1] + 1, this.duration - 1]);
    this.withInput = this.events.some((e) => e.k === 'touche' || e.k === 'unicode');
    this.sensitive = rec.commandes_sensibles.map((c) => c.toLowerCase()).filter(Boolean);
    this.decodeKeys();
    this.clicks = this.events.filter((e) => e.k === 'clic');
    this.clips = this.events.filter((e): e is Extract<RdpEvent, { k: 'presse-papiers' }> => e.k === 'presse-papiers');
    this.files = this.events.filter((e): e is Extract<RdpEvent, { k: 'fichier' }> => e.k === 'fichier');
    this.moves = this.events.filter((e): e is Extract<RdpEvent, { k: 'souris' | 'clic' }> => e.k === 'souris' || e.k === 'clic');
  }

  /**
   * Session en direct : événements relus, nouvelles images chargées dans le moteur ; si l'on
   * regardait la fin, on y reste.
   */
  async extend(rec: RdpRecording) {
    const following = this.live && this.position >= this.duration - 1.5;
    this.rec = rec;
    this.analyze(rec);
    this.live = !rec.session.fin;
    await this.engine?.more?.().catch(() => 0);
    this.renderTrack();
    this.renderList();
    if (following) this.seek(this.duration);
    else this.render();
    this.renderLive();
  }

  private renderLive() {
    const s = this.rec.session;
    const date = new Date(s.debut).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'medium' });
    this.liveBadge.hidden = !this.live;
    this.headInfo.textContent = `${s.compte} · ${date} · ${fmt(this.duration)}${s.fin ? '' : t(' · ongoing', ' · en cours')}`;
  }

  /** Barre de temps : pauses, frappe, clics, copier-coller, fichiers. */
  private renderTrack() {
    this.track.replaceChildren(h('div', { class: 'ap-rail' }));
    const pct = (x: number) => (100 * x) / this.duration;
    for (const [a, b] of this.idle) this.track.append(h('div', { class: 'ap-idle', style: `left:${pct(a)}%;width:${pct(b - a)}%`, title: t(`${fmt(b - a)} pause`, `Pause de ${fmt(b - a)}`) }));
    this.track.append(this.done);
    for (const l of this.lines) this.track.append(h('div', { class: `ap-mk ${l.level}`, style: `left:${pct(l.t)}%`, title: `${fmt(l.t)}  ${l.text || l.keys.map((k) => k.chip).join(' ')}` }));
    for (const c of this.clicks) this.track.append(h('div', { class: 'ap-mk rp-clic', style: `left:${pct(c.t)}%`, title: `${fmt(c.t)}  ${t('click', 'clic')}` }));
    for (const c of this.clips) this.track.append(h('div', { class: 'ap-mk rp-clip', style: `left:${pct(c.t)}%`, title: `${fmt(c.t)}  ${this.clipLabel(c)}` }));
    for (const f of this.files) this.track.append(h('div', { class: 'ap-mk rp-clip', style: `left:${pct(f.t)}%`, title: `${fmt(f.t)}  ${this.fileLabel(f)}` }));
    this.track.append(this.knob);
    this.track.setAttribute('aria-valuemax', String(Math.round(this.duration)));
  }

  /** Relit la frappe avec la disposition choisie. */
  private decodeKeys() {
    this.lines = typedLines(this.events, this.sensitive, this.layout === 'auto' ? detectLayout(this.events) : this.layout);
  }

  // ---------- Moteur ----------

  private onMessage(m: ReplayMessage) {
    // Zone d'image en binaire (voir drawPixels).
    if (m instanceof ArrayBuffer) { drawPixels(this.ctx, m); return; }
    switch (m.type) {
      case 'resize':
        this.canvas.width = m.width;
        this.canvas.height = m.height;
        this.fit();
        break;
      case 'position':
        this.loading.hidden = true;
        this.inflight = false;
        this.waiters.splice(0).forEach((w) => w());
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
      h('button', { class: 'btn sm', onclick: () => this.opts.exportText() }, icon('download', 14), t('Transcript', 'Transcription')),
      this.opts.exportVideo ? h('button', { class: 'btn sm', title: t('MP4 video with keystrokes as subtitles, the mouse and a watermark (written to the Gate\'s log)', 'Vidéo MP4 avec la frappe en sous-titres, la souris et un filigrane (inscrite au journal de la Gate)'), onclick: () => this.opts.exportVideo!() }, icon('download', 14), t('Video', 'Vidéo')) : null,
      this.opts.detach ? h('button', { class: 'btn sm', title: t('Open the player in its own window', 'Ouvrir le lecteur dans sa propre fenêtre'), onclick: () => this.opts.detach!() }, '⧉ ', t('Detach', 'Détacher')) : null);
    const head = h('div', { class: 'ap-head' },
      h('h2', {}, s.serveur, ' ', h('span', { class: 'badge proto-rdp' }, 'RDP'), ' ', h('span', { class: 'badge mode-enregistre' }, t('recorded', 'enregistré')), this.liveBadge),
      this.headInfo,
      seal, actions);
    this.renderLive();
    if (r.revele) head.append(h('div', { class: 'ap-revealed' }, t('Copied-pasted text revealed: this replay is written to the gate\'s log.', 'Texte copié-collé révélé : cette relecture est inscrite au journal de la Gate.')));

    this.screen.append(this.stage, this.loading,
      h('div', { class: 'ap-wm' }, t(`Viewed by ${this.opts.viewer}`, `Consulté par ${this.opts.viewer}`), h('br'), new Date().toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })),
      this.skipNote, this.subs);
    this.screen.addEventListener('click', () => this.toggle());

    this.renderTrack();
    const fromPointer = (e: PointerEvent) => {
      const box = this.track.getBoundingClientRect();
      this.seek(this.duration * Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)));
    };
    this.track.addEventListener('pointerdown', (e) => { this.track.setPointerCapture(e.pointerId); fromPointer(e); });
    this.track.addEventListener('pointermove', (e) => { if (this.track.hasPointerCapture(e.pointerId)) fromPointer(e); });

    const detected = detectLayout(this.events).toUpperCase();
    const layout = this.withInput ? h('select', { class: 'ap-speed', 'aria-label': t('Keyboard layout', 'Disposition du clavier'), title: t('Keyboard layout used to read the keystrokes', 'Disposition du clavier utilisée pour lire la frappe'), onchange: (e: Event) => {
      this.layout = (e.target as HTMLSelectElement).value as LayoutChoice;
      try { localStorage.setItem(LAYOUT_KEY, this.layout); } catch { /* choix non retenu */ }
      this.decodeKeys();
      this.renderList();
      this.render();
    } }, ...[['auto', `Auto (${detected})`], ['azerty', 'AZERTY'], ['qwerty', 'QWERTY']].map(([v, label]) => h('option', { value: v, selected: v === this.layout }, label))) : null;
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
        layout, speed, cc, full));

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

  private fileLabel(f: Extract<RdpEvent, { k: 'fichier' }>): string {
    const where = f.sens === 'vers-serveur' ? t('File sent to the server', 'Fichier envoyé au serveur') : t('File taken from the server', 'Fichier récupéré du serveur');
    const size = f.taille >= 1048576 ? `${(f.taille / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(f.taille / 1024))} Ko`;
    return `${where} : ${f.nom} · ${size}${f.incomplet ? t(' (incomplete)', ' (incomplet)') : ''} · SHA-256 ${f.sha256.slice(0, 16)}…${f.copie ? t(' · copy kept', ' · copie gardée') : ''}`;
  }

  private info(): HTMLElement {
    const r = this.rec;
    const s = r.session;
    const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'medium' }) : t('ongoing', 'en cours'));
    const row = (k: string, v: Node | string) => [h('dt', {}, k), h('dd', {}, v)];
    const sig = { verifiee: t('checked with the gate\'s key', 'vérifiée avec la clé de la Gate'), alteree: t('DOES NOT MATCH: file modified', 'NE CORRESPOND PAS : fichier modifié'), absente: t('not added yet (session ongoing or interrupted)', 'pas encore posée (session en cours ou interrompue)') }[r.signature];
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
        ...(this.files.length ? row(t('Files copied', 'Fichiers copiés'), String(this.files.length)) : []),
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
      // Les touches restent à leur place dans la ligne : l'ordre n'est pas toujours celui du temps.
      if (k.t > until) continue;
      if (k.chip) { flush(); out.push(h('span', { class: `${chip}${k.chip === '⌫' ? ' del' : ''}` }, k.chip)); }
      else if (k.gone !== undefined && k.gone <= until) { flush(); out.push(h('s', { class: 'ap-erased', title: t('Erased', 'Effacé') }, k.text ?? '')); }
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
      ...this.files.map((f) => ({ t: f.t, level: 'clip', nodes: [document.createTextNode(this.fileLabel(f))] })),
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

  /** Amène le moteur à ce temps et attend l'image (vidéo). */
  private async frameAt(time: number) {
    while (this.inflight) await new Promise<void>((r) => this.waiters.push(r));
    if (Math.abs(time - this.sent) < 0.001 || !this.engine) return;
    const done = new Promise<void>((r) => this.waiters.push(r));
    this.position = time;
    this.request(time);
    await done;
  }

  /** Lignes de la frappe pour les sous-titres .srt. */
  subtitleLines(): { t: number; end: number; text: string }[] {
    return this.lines.map((l) => ({ t: l.t, end: l.end, text: l.text || l.keys.map((k) => k.chip).filter(Boolean).join(' ') }));
  }

  /** Source de la vidéo : l'image décodée par le moteur, la souris et les clics. */
  videoSource(): VideoSource {
    if (this.playing) this.toggle();
    return {
      width: this.canvas.width,
      height: this.canvas.height,
      duration: this.duration,
      draw: async (ctx, time) => {
        await this.frameAt(time);
        ctx.drawImage(this.canvas, 0, 0);
        let last: (typeof this.moves)[number] | undefined;
        for (const m of this.moves) { if (m.t <= time) last = m; else break; }
        if (!last) return;
        if (last.k === 'clic' && time - last.t < 1) {
          ctx.strokeStyle = 'rgba(255,200,0,0.9)';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(last.x, last.y, 16, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Pointeur : une flèche blanche bordée de noir.
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(last.x, last.y + 18);
        ctx.lineTo(last.x + 5, last.y + 14);
        ctx.lineTo(last.x + 9, last.y + 22);
        ctx.lineTo(last.x + 12, last.y + 20);
        ctx.lineTo(last.x + 8, last.y + 12);
        ctx.lineTo(last.x + 14, last.y + 12);
        ctx.closePath();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      },
      subtitle: (time) => {
        if (!this.withInput) return null;
        let line: Line | undefined;
        for (const l of this.lines) { if (l.t <= time) line = l; else break; }
        if (!line || time - Math.max(line.end, line.t) > 2.5) return null;
        const shown = time < line.end ? line.keys.filter((k) => k.t <= time) : line.keys;
        const text = shown.map((k) => (k.gone !== undefined && k.gone <= time ? '' : k.text ?? (k.chip ? ` ${k.chip} ` : ''))).join('').trim();
        return text ? `${this.rec.session.compte.toUpperCase()}  ${text}` : null;
      },
    };
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
      this.withInput ? t('Erased text is shown between ~tildes~.', 'Le texte effacé figure entre ~tildes~.') : '',
      '',
    ];
    const rows: [number, string][] = [
      ...this.lines.map((l): [number, string] => [l.t, lineText(l)]),
      ...this.clicks.map((c): [number, string] => [c.t, t(`(click ${c.k === 'clic' ? `${c.x},${c.y}` : ''})`, `(clic ${c.k === 'clic' ? `${c.x},${c.y}` : ''})`)]),
      ...this.clips.map((c): [number, string] => [c.t, `(${this.clipLabel(c)})`]),
      ...this.files.map((f): [number, string] => [f.t, `(${this.fileLabel(f)})`]),
    ].sort((a, b) => a[0] - b[0]);
    return [...head, ...rows.map(([at, text]) => `[${fmt(at)}] ${text}`), ''].join('\n');
  }

  dispose() {
    clearInterval(this.liveTimer);
    this.closed = true;
    this.playing = false;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.skipTimer);
    this.resizer.disconnect();
    this.engine?.close();
  }
}
