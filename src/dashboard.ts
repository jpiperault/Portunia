// Tableau de bord d'un serveur Linux (Pro) : panneau de droite, relevé toutes les 5 s quand il est visible.
import { errorText, ServerStats, serverStats } from './api';
import { h, icon } from './dom';
import { LOCALE, t } from './i18n';

const REFRESH_MS = 5000;
/** Points gardés pour les mini-courbes (≈ 5 min). */
const HISTORY = 60;

function size(kb: number): string {
  const units = t('KB MB GB TB', 'Ko Mo Go To').split(' ');
  let v = kb;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`.replace('.', t('.', ','));
}

function duration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const hrs = Math.floor((secs % 86400) / 3600);
  const min = Math.floor((secs % 3600) / 60);
  return d ? `${d} j ${hrs} h` : hrs ? `${hrs} h ${min} min` : `${min} min`;
}

/** Niveau de couleur d'un pourcentage. */
const level = (pct: number) => (pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'ok');

function gauge(label: string, pct: number, detail: string, history?: number[]) {
  const p = Math.max(0, Math.min(100, pct));
  return h('div', { class: 'dash-gauge' },
    h('div', { class: 'dash-gauge-head' }, h('span', {}, label), h('strong', { class: `lvl-${level(p)}` }, `${Math.round(p)} %`)),
    h('div', { class: 'dash-bar' }, h('div', { class: `dash-fill lvl-${level(p)}`, style: `width: ${p}%` })),
    h('div', { class: 'muted small' }, detail),
    history && history.length > 1 ? sparkline(history) : null);
}

function sparkline(values: number[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${HISTORY - 1} 100`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'dash-spark');
  svg.setAttribute('aria-hidden', 'true');
  const offset = HISTORY - values.length;
  const path = document.createElementNS(ns, 'polyline');
  path.setAttribute('points', values.map((v, i) => `${i + offset},${100 - Math.max(0, Math.min(100, v))}`).join(' '));
  svg.append(path);
  return svg;
}

export class ServerPanel {
  readonly el = h('section', { class: 'dash-panel', 'aria-label': t('Server dashboard', 'Tableau de bord du serveur') });
  private readonly body = h('div', { class: 'dash-body' });
  private readonly status = h('span', { class: 'muted small grow' });
  private timer = 0;
  private visible = false;
  private busy = false;
  private stats: ServerStats | null = null;
  private error = '';
  private readonly cpuHistory: number[] = [];
  private readonly memHistory: number[] = [];
  private disposed = false;

  constructor(
    readonly connectionId: string,
    private readonly title: string,
    /** Envoie une commande au terminal (ex. journal d'un service en échec). */
    private readonly send: (cmd: string) => void,
  ) {
    this.el.append(
      h('header', { class: 'notes-head' }, icon('chart', 14), h('strong', { class: 'grow ellipsis' }, t(`Server · ${title}`, `Serveur · ${title}`)),
        h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': t('Refresh', 'Actualiser'), title: t('Refresh', 'Actualiser'), onclick: () => this.refresh() }, icon('refresh', 14))),
      this.body,
      h('footer', { class: 'notes-foot' }, this.status, h('span', { class: 'muted small' }, t('Every 5 s', 'Toutes les 5 s'))));
    this.body.append(h('p', { class: 'muted', style: 'padding: 12px' }, t('Reading the metrics…', 'Lecture des mesures…')));
  }

  /** Relevés seulement quand le panneau est à l'écran. */
  setVisible(on: boolean) {
    if (on === this.visible || this.disposed) return;
    this.visible = on;
    window.clearTimeout(this.timer);
    if (on) this.refresh();
  }

  private async refresh() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    window.clearTimeout(this.timer);
    try {
      this.stats = await serverStats(this.connectionId);
      this.error = '';
      this.push(this.cpuHistory, this.stats.cpuPercent);
      this.push(this.memHistory, this.memPercent(this.stats));
      this.status.textContent = t(`Updated at ${new Date().toLocaleTimeString(LOCALE)}`, `Mis à jour à ${new Date().toLocaleTimeString(LOCALE)}`);
    } catch (e) {
      this.error = errorText(e);
      this.status.textContent = '';
    } finally {
      this.busy = false;
    }
    if (this.disposed) return;
    this.render();
    // Après une erreur définitive (pas Linux, session fermée), on ne réessaie pas en boucle.
    if (this.visible && !/Linux|fermée|Pro/.test(this.error)) this.timer = window.setTimeout(() => this.refresh(), REFRESH_MS);
  }

  private push(list: number[], v: number) {
    list.push(v);
    if (list.length > HISTORY) list.shift();
  }

  private memPercent(s: ServerStats) {
    return s.memTotalKb ? (100 * (s.memTotalKb - s.memAvailableKb)) / s.memTotalKb : 0;
  }

  private render() {
    const s = this.stats;
    if (!s) {
      this.body.replaceChildren(h('p', { class: 'form-error', style: 'padding: 12px; white-space: pre-line' }, this.error));
      return;
    }
    const swapUsed = s.swapTotalKb - s.swapFreeKb;
    const loadPct = (100 * s.load[0]) / s.cpus;
    this.body.replaceChildren(
      this.error ? h('p', { class: 'form-error small', style: 'margin: 0' }, this.error) : '',
      h('div', { class: 'dash-id' },
        h('strong', {}, s.hostname || this.title),
        h('span', { class: 'muted small' }, s.os),
        h('span', { class: 'muted small' }, t(`Kernel ${s.kernel} · up for ${duration(s.uptimeSecs)}`, `Noyau ${s.kernel} · démarré depuis ${duration(s.uptimeSecs)}`))),
      gauge(t('CPU', 'Processeur'), s.cpuPercent, t(`${s.cpus} core${s.cpus > 1 ? 's' : ''}`, `${s.cpus} cœur${s.cpus > 1 ? 's' : ''}`), this.cpuHistory),
      gauge(t('Memory', 'Mémoire'), this.memPercent(s), t(`${size(s.memTotalKb - s.memAvailableKb)} used of ${size(s.memTotalKb)}`, `${size(s.memTotalKb - s.memAvailableKb)} utilisés sur ${size(s.memTotalKb)}`), this.memHistory),
      s.swapTotalKb > 0 ? gauge('Swap', (100 * swapUsed) / s.swapTotalKb, t(`${size(swapUsed)} of ${size(s.swapTotalKb)}`, `${size(swapUsed)} sur ${size(s.swapTotalKb)}`)) : '',
      h('div', { class: 'dash-gauge' },
        h('div', { class: 'dash-gauge-head' }, h('span', {}, t('Load (1 / 5 / 15 min)', 'Charge (1 / 5 / 15 min)')),
          h('strong', { class: `lvl-${level(loadPct)}` }, s.load.map((l) => l.toFixed(2).replace('.', t('.', ','))).join(' · ')))),
      h('h4', { class: 'dash-title' }, t('Disks', 'Disques')),
      ...s.disks.map((d) => gauge(d.mount, (100 * d.usedKb) / d.totalKb, t(`${size(d.usedKb)} of ${size(d.totalKb)} · ${d.fs}`, `${size(d.usedKb)} sur ${size(d.totalKb)} · ${d.fs}`))),
      s.failedServices.length ? h('h4', { class: 'dash-title lvl-crit' }, t(`Failed services (${s.failedServices.length})`, `Services en échec (${s.failedServices.length})`)) : '',
      ...s.failedServices.map((svc) => h('div', { class: 'dash-row' },
        h('span', { class: 'net-dot down' }), h('span', { class: 'grow mono ellipsis' }, svc),
        h('button', {
          type: 'button', class: 'btn sm', title: t('Show the service\'s status and log in the terminal', 'Afficher l\'état et le journal du service dans le terminal'),
          onclick: () => this.send(`systemctl status ${svc.replace(/[^\w@.:-]/g, '')} --no-pager -l\n`),
        }, t('View', 'Voir')))),
      h('h4', { class: 'dash-title' }, t('Busiest processes', 'Processus les plus actifs')),
      h('table', { class: 'dash-procs' },
        h('thead', {}, h('tr', {}, h('th', {}, t('Processes', 'Processus')), h('th', {}, 'PID'), h('th', {}, 'CPU'), h('th', {}, t('Mem.', 'Mém.')))),
        h('tbody', {}, ...s.processes.map((p) => h('tr', {},
          h('td', { class: 'ellipsis' }, p.name), h('td', { class: 'muted' }, String(p.pid)),
          h('td', {}, `${p.cpu.toFixed(1).replace('.', t('.', ','))} %`), h('td', {}, `${p.mem.toFixed(1).replace('.', t('.', ','))} %`))))));
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.timer);
  }
}
