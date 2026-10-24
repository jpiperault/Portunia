// Enregistrements de sessions : liste, lecteur intégré, horodatage des fichiers.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { errorText, recordings } from './api';
import { h, icon } from './dom';
import { formatSize } from './files';
import { fontStack, settings, updateSettings } from './settings';
import { proChip } from './security';

type Toast = (message: string, kind?: 'info' | 'error') => void;

const dirSetting = () => settings().recordingDir || null;

/** Horodatage local pour le nom du fichier : 2026-10-24_14-03-12. */
export function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

// ---------- Réglages ----------

export function recordingSettings(toast: Toast): HTMLElement {
  const s = settings();
  const dir = h('input', { type: 'text', class: 'imp-path', value: s.recordingDir, spellcheck: 'false', placeholder: 'Documents\\Termoria\\Enregistrements' });
  dir.addEventListener('change', () => updateSettings({ recordingDir: dir.value.trim() }));
  recordings.defaultDir().then((d) => { dir.placeholder = d; }).catch(() => {});
  return h('div', { class: 'settings-block' },
    h('label', { class: 'check setting' },
      h('input', { type: 'checkbox', checked: s.autoRecord, onchange: (e: Event) => updateSettings({ autoRecord: (e.target as HTMLInputElement).checked }) }),
      h('span', {}, 'Enregistrer automatiquement chaque session terminal ', proChip('sessionRecording'),
        h('span', { class: 'muted small block' }, 'Seul ce que le serveur affiche est enregistré : les mots de passe tapés n\'y figurent pas.'))),
    h('div', { class: 'imp-file' }, dir,
      h('button', {
        type: 'button', class: 'btn', onclick: async () => {
          const picked = await open({ directory: true, multiple: false, title: 'Dossier des enregistrements' });
          if (typeof picked === 'string') { dir.value = picked; updateSettings({ recordingDir: picked }); }
        },
      }, 'Choisir…')),
    h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: () => openRecordings(toast) }, icon('play', 14), 'Voir les enregistrements'));
}

// ---------- Liste ----------

export function openRecordings(toast: Toast, onPlay?: (title: string, cast: string) => void) {
  const list = h('div', { class: 'snip-list' });
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'rec-title' },
    h('div', { class: 'snip-dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'rec-title' }, 'Enregistrements'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => dialog.close() }, icon('close'))),
      h('div', { class: 'dlg-body' }, list)));
  dialog.addEventListener('close', () => dialog.remove());

  const refresh = async () => {
    try {
      const items = await recordings.list(dirSetting());
      list.replaceChildren(...(items.length ? items.map((r) => h('div', { class: 'snip-row' },
        h('div', { class: 'grow', style: 'min-width: 0' },
          h('div', { class: 'ellipsis' }, h('strong', {}, r.name)),
          h('div', { class: 'muted small' }, `${new Date(r.modified * 1000).toLocaleString('fr-FR')} · ${formatSize(r.size)}`)),
        h('button', {
          class: 'btn', onclick: async () => {
            try {
              const cast = await recordings.read(dirSetting(), r.path);
              dialog.close();
              (onPlay ?? playerHandler)?.(r.name, cast);
            } catch (e) { toast(errorText(e), 'error'); }
          },
        }, icon('play', 14), 'Lire'),
        h('button', { class: 'icon-btn sm', 'aria-label': `Afficher ${r.name} dans l'Explorateur`, title: 'Afficher dans l\'Explorateur', onclick: () => revealItemInDir(r.path).catch(() => {}) }, icon('folder', 14)),
        h('button', {
          class: 'icon-btn sm', 'aria-label': `Supprimer ${r.name}`, title: 'Supprimer',
          onclick: async () => {
            if (!confirm(`Supprimer l'enregistrement « ${r.name} » ?`)) return;
            try { await recordings.remove(dirSetting(), r.path); refresh(); } catch (e) { toast(errorText(e), 'error'); }
          },
        }, icon('trash', 14))))
        : [h('p', { class: 'muted' }, 'Aucun enregistrement pour l\'instant. Utilisez le bouton « Enregistrer » d\'une session terminal.')]));
    } catch (e) {
      list.replaceChildren(h('p', { class: 'form-error' }, errorText(e)));
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  refresh();
}

/** Ouverture d'un lecteur dans un onglet (fourni par l'application). */
let playerHandler: ((title: string, cast: string) => void) | undefined;
export const setPlayerHandler = (fn: (title: string, cast: string) => void) => { playerHandler = fn; };

// ---------- Lecteur ----------

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
    this.term = new Terminal({ fontFamily: fontStack(s), fontSize: s.fontSize, cols: parsed.cols, rows: parsed.rows, disableStdin: true, cursorBlink: false, theme: { background: '#111215', foreground: '#D6D8DD' } });
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
