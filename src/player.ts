// Lecteur d'enregistrement (asciicast) : chargé seulement quand on rejoue une session, avec xterm.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { h, icon } from './dom';
import { fontStack, settings } from './settings';
import { terminalTheme } from './theme';

interface CastEvent { time: number; type: string; data: string }

function parseCast(cast: string) {
  const lines = cast.split('\n').filter(Boolean);
  const header = JSON.parse(lines[0] ?? '{}') as { width?: number; height?: number };
  const events: CastEvent[] = [];
  let shift = 0;
  let last = 0;
  for (const line of lines.slice(1)) {
    try {
      const [time, type, data] = JSON.parse(line) as [number, string, string];
      // Les longues pauses sont ramenées à 2 secondes.
      if (time - last > 2) shift += time - last - 2;
      last = time;
      events.push({ time: time - shift, type, data });
    } catch { /* ligne illisible ignorée */ }
  }
  return { cols: header.width ?? 80, rows: header.height ?? 24, events };
}

/** Lecteur d'enregistrement : terminal en lecture seule, lecture / pause / vitesse. */
export class Player {
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly events: CastEvent[];
  private readonly duration: number;
  private index = 0;
  private position = 0;
  private speed = 1;
  private playing = false;
  private timer = 0;
  private lastTick = 0;
  private readonly bar = h('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Position dans l\'enregistrement', class: 'player-bar' });
  private readonly clock = h('span', { class: 'muted small player-clock' });
  private readonly playBtn = h('button', { class: 'btn', onclick: () => this.toggle() });

  constructor(readonly el: HTMLElement, cast: string) {
    const parsed = parseCast(cast);
    this.events = parsed.events;
    this.duration = this.events[this.events.length - 1]?.time ?? 0;
    const screen = h('div', { class: 'player-screen' });
    const speedSel = h('select', { 'aria-label': 'Vitesse', onchange: (e: Event) => { this.speed = Number((e.target as HTMLSelectElement).value); } },
      ...[1, 2, 4, 8].map((v) => h('option', { value: String(v) }, `× ${v}`)));
    this.bar.addEventListener('input', () => this.seek((Number(this.bar.value) / 1000) * this.duration));
    el.classList.add('player');
    el.append(screen, h('div', { class: 'player-controls' }, this.playBtn, speedSel, this.bar, this.clock));

    const s = settings();
    this.term = new Terminal({ fontFamily: fontStack(s), fontSize: s.fontSize, cols: parsed.cols, rows: parsed.rows, disableStdin: true, cursorBlink: false, theme: terminalTheme() });
    this.term.loadAddon(this.fit);
    this.term.open(screen);
    this.renderControls();
    this.toggle();
  }

  private renderControls() {
    this.playBtn.replaceChildren(icon(this.playing ? 'pause' : 'play', 14), this.playing ? 'Pause' : 'Lire');
    const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    this.clock.textContent = `${fmt(this.position)} / ${fmt(this.duration)}`;
    this.bar.value = String(this.duration ? Math.round((this.position / this.duration) * 1000) : 0);
  }

  private toggle() {
    if (this.playing) return this.pause();
    if (this.position >= this.duration) this.seek(0);
    this.playing = true;
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => this.tick(), 30);
    this.renderControls();
  }

  private pause() {
    this.playing = false;
    window.clearInterval(this.timer);
    this.renderControls();
  }

  private tick() {
    const now = performance.now();
    this.position = Math.min(this.duration, this.position + ((now - this.lastTick) / 1000) * this.speed);
    this.lastTick = now;
    this.flush();
    if (this.position >= this.duration) this.pause();
    else this.renderControls();
  }

  /** Joue tous les événements jusqu'à la position courante. */
  private flush() {
    while (this.index < this.events.length && this.events[this.index].time <= this.position) {
      const e = this.events[this.index++];
      if (e.type === 'o') this.term.write(e.data);
      else if (e.type === 'r') {
        const [c, r] = e.data.split('x').map(Number);
        if (c && r) this.term.resize(c, r);
      }
    }
  }

  private seek(time: number) {
    this.term.reset();
    this.index = 0;
    this.position = Math.max(0, Math.min(this.duration, time));
    this.flush();
    this.lastTick = performance.now();
    this.renderControls();
  }

  dispose() {
    window.clearInterval(this.timer);
    this.term.dispose();
  }
}
