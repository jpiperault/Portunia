// Supervision d'un serveur Proxmox (onglet) : ensemble du cluster, nœuds avec leurs courbes
// (processeur, mémoire, réseau, charge), stockages, et machines triées par consommation.
// Tout vient de l'API (/cluster/resources, rrddata), relue toutes les 10 secondes.
import { errorText, proxmox, Pve, PveResource } from './api';
import { h, icon } from './dom';
import { LOCALE, t } from './i18n';
import { bytes, guestLabel, rightsHint } from './proxmox';

const REFRESH_MS = 10 * 1000;

type Timeframe = 'hour' | 'day' | 'week' | 'month';
/** Un point des relevés de Proxmox (les champs manquent quand le relevé n'existait pas). */
type Rrd = { time: number } & Record<string, number | undefined>;
type SortKey = 'name' | 'cpu' | 'mem' | 'disk' | 'net' | 'io' | 'uptime';

const TIMEFRAMES: [Timeframe, string][] = [
  ['hour', t('Hour', 'Heure')], ['day', t('Day', 'Jour')], ['week', t('Week', 'Semaine')], ['month', t('Month', 'Mois')],
];

/** Niveau de couleur d'un pourcentage, comme le tableau de bord des serveurs. */
const level = (pct: number) => (pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : 'ok');
const percent = (v: number) => `${v < 10 ? v.toFixed(1).replace('.', t('.', ',')) : Math.round(v)} %`;
const rate = (n: number) => `${n ? bytes(n) : t('0 B', '0 o')}/s`;

function uptime(secs?: number): string {
  if (!secs) return '';
  const d = Math.floor(secs / 86400);
  const hrs = Math.floor((secs % 86400) / 3600);
  const min = Math.floor((secs % 3600) / 60);
  return d ? t(`${d} d ${hrs} h`, `${d} j ${hrs} h`) : hrs ? `${hrs} h ${min} min` : `${min} min`;
}

function gauge(label: string, used: number, total: number, detail: string) {
  const p = total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
  return h('div', { class: 'dash-gauge' },
    h('div', { class: 'dash-gauge-head' }, h('span', {}, label), h('strong', { class: `lvl-${level(p)}` }, total > 0 ? percent(p) : '–')),
    h('div', { class: 'dash-bar' }, h('div', { class: `dash-fill lvl-${level(p)}`, style: `width: ${p}%` })),
    h('div', { class: 'muted small' }, detail));
}

interface Series {
  label: string;
  values: (number | undefined)[];
}

/** Courbes d'une période : une à trois séries, l'échelle part de 0 ; survol : valeurs à cet instant. */
function chart(title: string, times: number[], series: Series[], format: (v: number) => string, timeframe: Timeframe, max?: number): HTMLElement {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 600;
  const H = 120;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== undefined && Number.isFinite(v)));
  const top = max ?? Math.max(1e-9, ...all) * 1.1;
  const n = times.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : 0);
  const y = (v: number) => H - Math.max(0, Math.min(1, v / top)) * H;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'pmon-svg');
  for (const frac of [0.25, 0.5, 0.75]) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '0'); line.setAttribute('x2', String(W));
    line.setAttribute('y1', String(H * frac)); line.setAttribute('y2', String(H * frac));
    line.setAttribute('class', 'pmon-grid');
    svg.append(line);
  }
  series.forEach((s, k) => {
    // Un trou dans les relevés coupe la courbe au lieu de la relier.
    let points: string[] = [];
    const flush = () => {
      if (points.length > 1) {
        const path = document.createElementNS(ns, 'polyline');
        path.setAttribute('points', points.join(' '));
        path.setAttribute('class', `pmon-s${k + 1}`);
        svg.append(path);
      }
      points = [];
    };
    s.values.forEach((v, i) => (v === undefined || !Number.isFinite(v) ? flush() : points.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`)));
    flush();
  });
  const cursor = document.createElementNS(ns, 'line');
  cursor.setAttribute('y1', '0'); cursor.setAttribute('y2', String(H));
  cursor.setAttribute('class', 'pmon-cursor');
  cursor.style.display = 'none';
  svg.append(cursor);

  const clock = (s: number) => new Date(s * 1000).toLocaleString(LOCALE, timeframe === 'hour' || timeframe === 'day' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const last = (s: Series) => [...s.values].reverse().find((v) => v !== undefined && Number.isFinite(v));
  const legendFor = (i?: number) => series.map((s, k) => {
    const v = i === undefined ? last(s) : s.values[i];
    const peak = Math.max(...s.values.filter((x): x is number => x !== undefined && Number.isFinite(x)), 0);
    return h('span', { class: 'pmon-key' }, h('i', { class: `pmon-k${k + 1}` }), `${s.label} `, h('strong', {}, v === undefined ? '–' : format(v)),
      i === undefined ? h('span', { class: 'muted' }, t(` · peak ${format(peak)}`, ` · pic ${format(peak)}`)) : null);
  });
  const legend = h('div', { class: 'pmon-legend' }, ...legendFor());
  const when = h('span', { class: 'muted small' });
  const plot = h('div', { class: 'pmon-plot' }, svg, h('span', { class: 'pmon-max muted' }, format(top)));
  plot.addEventListener('mousemove', (e: MouseEvent) => {
    if (n < 2) return;
    const box = plot.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left) / box.width) * (n - 1));
    if (i < 0 || i >= n) return;
    cursor.setAttribute('x1', String(x(i))); cursor.setAttribute('x2', String(x(i)));
    cursor.style.display = '';
    legend.replaceChildren(...legendFor(i));
    when.textContent = clock(times[i]);
  });
  plot.addEventListener('mouseleave', () => { cursor.style.display = 'none'; legend.replaceChildren(...legendFor()); when.textContent = ''; });
  return h('div', { class: 'pmon-chart' },
    h('div', { class: 'pmon-chart-head' }, h('span', { class: 'pmon-chart-title' }, title), when),
    plot,
    h('div', { class: 'pmon-axis muted small' }, h('span', {}, n ? clock(times[0]) : ''), h('span', {}, n ? clock(times[n - 1]) : '')),
    legend);
}

const pick = (rows: Rrd[], f: (r: Rrd) => number | undefined) => rows.map((r) => { const v = f(r); return v === undefined || Number.isNaN(v) ? undefined : v; });

/** Courbes d'un nœud : processeur et attente disque, mémoire, réseau, charge. */
function nodeCharts(rows: Rrd[], timeframe: Timeframe): HTMLElement {
  const times = rows.map((r) => r.time);
  const memMax = Math.max(0, ...rows.map((r) => r.memtotal ?? 0)) || undefined;
  return h('div', { class: 'pmon-charts' },
    chart(t('CPU', 'Processeur'), times, [
      { label: t('CPU', 'Processeur'), values: pick(rows, (r) => (r.cpu === undefined ? undefined : r.cpu * 100)) },
      { label: t('IO wait', 'Attente disque'), values: pick(rows, (r) => (r.iowait === undefined ? undefined : r.iowait * 100)) },
    ], percent, timeframe, 100),
    chart(t('Memory', 'Mémoire'), times, [
      { label: t('Used', 'Utilisée'), values: pick(rows, (r) => r.memused) },
      { label: 'Swap', values: pick(rows, (r) => r.swapused) },
    ], bytes, timeframe, memMax),
    chart(t('Network', 'Réseau'), times, [
      { label: t('In', 'Entrée'), values: pick(rows, (r) => r.netin) },
      { label: t('Out', 'Sortie'), values: pick(rows, (r) => r.netout) },
    ], rate, timeframe),
    chart(t('Load average', 'Charge moyenne'), times, [
      { label: t('Load', 'Charge'), values: pick(rows, (r) => r.loadavg) },
    ], (v) => v.toFixed(2).replace('.', t('.', ',')), timeframe));
}

/** Courbes d'une machine : processeur, mémoire, réseau, lectures et écritures disque. */
function guestCharts(rows: Rrd[], timeframe: Timeframe): HTMLElement {
  const times = rows.map((r) => r.time);
  const memMax = Math.max(0, ...rows.map((r) => r.maxmem ?? 0)) || undefined;
  return h('div', { class: 'pmon-charts' },
    chart(t('CPU', 'Processeur'), times, [{ label: t('CPU', 'Processeur'), values: pick(rows, (r) => (r.cpu === undefined ? undefined : r.cpu * 100)) }], percent, timeframe, 100),
    chart(t('Memory', 'Mémoire'), times, [{ label: t('Used', 'Utilisée'), values: pick(rows, (r) => r.mem) }], bytes, timeframe, memMax),
    chart(t('Network', 'Réseau'), times, [
      { label: t('In', 'Entrée'), values: pick(rows, (r) => r.netin) },
      { label: t('Out', 'Sortie'), values: pick(rows, (r) => r.netout) },
    ], rate, timeframe),
    chart(t('Disk', 'Disque'), times, [
      { label: t('Read', 'Lecture'), values: pick(rows, (r) => r.diskread) },
      { label: t('Write', 'Écriture'), values: pick(rows, (r) => r.diskwrite) },
    ], rate, timeframe));
}

/** Onglet « Supervision » d'un serveur Proxmox (ou d'un seul de ses nœuds). */
export class ProxmoxMonitor {
  readonly el = h('div', { class: 'ext-page pmon' });
  private timer = 0;
  private timeframe: Timeframe = 'hour';
  private sort: SortKey = 'cpu';
  private running = false;
  /** Compteurs cumulés du relevé précédent, pour en tirer des débits. */
  private counters = new Map<string, { at: number; net: number; io: number }>();
  private rates = new Map<string, { net: number; io: number }>();
  /** Machines dont les courbes sont dépliées. */
  private expanded = new Set<string>();
  private res: PveResource[] = [];
  private nodeRrd = new Map<string, Rrd[] | string>();
  private guestRrd = new Map<string, Rrd[] | string>();
  private hint = '';
  private error = '';
  private updated = 0;

  constructor(private readonly p: Pve, private readonly onlyNode?: string) {
    this.el.append(h('p', { class: 'muted' }, t('Loading…', 'Chargement…')));
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), REFRESH_MS);
  }

  dispose() {
    window.clearInterval(this.timer);
  }

  private async refresh() {
    if (this.running) return;
    this.running = true;
    try {
      const res = await proxmox.api<PveResource[]>(this.p.id, 'GET', '/cluster/resources');
      const now = Date.now() / 1000;
      for (const r of res) {
        if (r.type !== 'qemu' && r.type !== 'lxc') continue;
        const net = (r.netin ?? 0) + (r.netout ?? 0);
        const io = (r.diskread ?? 0) + (r.diskwrite ?? 0);
        const before = this.counters.get(r.id);
        // Compteur revenu à zéro (redémarrage) : pas de débit pour ce tour.
        if (before && now > before.at && net >= before.net && io >= before.io) this.rates.set(r.id, { net: (net - before.net) / (now - before.at), io: (io - before.io) / (now - before.at) });
        else if (r.status !== 'running') this.rates.delete(r.id);
        this.counters.set(r.id, { at: now, net, io });
      }
      this.res = res;
      this.error = '';
      this.hint = res.some((r) => r.type === 'qemu' || r.type === 'lxc') ? '' : await rightsHint(this.p.id);
      const params = { timeframe: this.timeframe, cf: 'AVERAGE' };
      const nodes = this.nodes().filter((n) => n.status === 'online');
      const guests = this.guests().filter((g) => this.expanded.has(g.id));
      await Promise.all([
        ...nodes.map(async (n) => this.nodeRrd.set(n.node, await proxmox.api<Rrd[]>(this.p.id, 'GET', `/nodes/${n.node}/rrddata`, params).catch((e) => errorText(e)))),
        ...guests.map(async (g) => this.guestRrd.set(g.id, await proxmox.api<Rrd[]>(this.p.id, 'GET', `/nodes/${g.node}/${g.type}/${g.vmid}/rrddata`, params).catch((e) => errorText(e)))),
      ]);
      this.updated = Date.now();
    } catch (e) {
      this.error = errorText(e);
    } finally {
      this.running = false;
    }
    this.render();
  }

  private nodes() {
    return this.res.filter((r) => r.type === 'node' && (!this.onlyNode || r.node === this.onlyNode)).sort((a, b) => a.node.localeCompare(b.node));
  }

  private guests() {
    return this.res.filter((r) => (r.type === 'qemu' || r.type === 'lxc') && r.template !== 1 && (!this.onlyNode || r.node === this.onlyNode));
  }

  private render() {
    const scroll = this.el.parentElement?.scrollTop ?? 0;
    const periods = h('div', { class: 'pmon-seg' }, ...TIMEFRAMES.map(([tf, label]) => h('button', {
      type: 'button', class: `pmon-seg-btn${tf === this.timeframe ? ' on' : ''}`, onclick: () => { this.timeframe = tf; this.nodeRrd.clear(); this.guestRrd.clear(); this.refresh(); },
    }, label)));
    const head = h('header', { class: 'pmon-head' },
      h('div', {},
        h('h2', {}, t(`Monitoring · ${this.onlyNode ?? this.p.name}`, `Supervision · ${this.onlyNode ?? this.p.name}`)),
        h('p', { class: 'muted small' }, `${this.p.host}:${this.p.port}`, this.updated ? t(` · updated at ${new Date(this.updated).toLocaleTimeString(LOCALE)}, every 10 s`, ` · mis à jour à ${new Date(this.updated).toLocaleTimeString(LOCALE)}, toutes les 10 s`) : '')),
      h('div', { class: 'pmon-tools' }, periods,
        h('button', { type: 'button', class: 'btn', title: t('Refresh now', 'Actualiser maintenant'), onclick: () => this.refresh() }, icon('refresh', 14))));
    const parts: (HTMLElement | null)[] = [head];
    if (this.error) parts.push(h('p', { class: 'form-error' }, this.error));
    if (this.hint) parts.push(h('p', { class: 'pmon-note' }, this.hint));
    if (this.res.length) parts.push(this.summary(), ...this.nodes().map((n) => this.node(n)), this.storage(), this.table());
    this.el.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
    if (this.el.parentElement) this.el.parentElement.scrollTop = scroll;
  }

  /** Ensemble : processeur et mémoire de tous les nœuds, stockage, machines en marche. */
  private summary(): HTMLElement {
    const nodes = this.nodes().filter((n) => n.status === 'online' && n.maxcpu);
    const cores = nodes.reduce((s, n) => s + (n.maxcpu ?? 0), 0);
    const cpu = nodes.reduce((s, n) => s + (n.cpu ?? 0) * (n.maxcpu ?? 0), 0);
    const mem = nodes.reduce((s, n) => s + (n.mem ?? 0), 0);
    const maxmem = nodes.reduce((s, n) => s + (n.maxmem ?? 0), 0);
    // Un stockage partagé apparaît sous chaque nœud : compté une fois.
    const seen = new Set<string>();
    let disk = 0;
    let maxdisk = 0;
    for (const s of this.storages()) {
      const key = s.shared ? s.storage ?? s.id : s.id;
      if (seen.has(key) || s.status !== 'available') continue;
      seen.add(key);
      disk += s.disk ?? 0;
      maxdisk += s.maxdisk ?? 0;
    }
    const guests = this.guests();
    const on = guests.filter((g) => g.status === 'running');
    const vms = guests.filter((g) => g.type === 'qemu').length;
    return h('section', { class: 'pmon-summary' },
      gauge(t('CPU', 'Processeur'), cpu, cores, t(`${cores} cores on ${nodes.length} node(s)`, `${cores} cœurs sur ${nodes.length} nœud(s)`)),
      gauge(t('Memory', 'Mémoire'), mem, maxmem, `${bytes(mem)} / ${bytes(maxmem)}`),
      gauge(t('Storage', 'Stockage'), disk, maxdisk, `${bytes(disk)} / ${bytes(maxdisk)}`),
      h('div', { class: 'dash-gauge' },
        h('div', { class: 'dash-gauge-head' }, h('span', {}, t('Guests', 'Machines')), h('strong', {}, `${on.length} / ${guests.length}`)),
        h('div', { class: 'muted small' }, t(`running · ${vms} VM(s), ${guests.length - vms} container(s)`, `en marche · ${vms} VM, ${guests.length - vms} conteneur(s)`))));
  }

  private node(n: PveResource): HTMLElement {
    const online = n.status === 'online';
    const rrd = this.nodeRrd.get(n.node);
    return h('section', { class: 'pmon-node' },
      h('h3', { class: 'pmon-node-head' }, icon('server', 16), n.node,
        h('span', { class: `badge${online ? '' : ' off'}` }, online ? t('online', 'en ligne') : t('offline', 'hors ligne')),
        online && n.uptime ? h('span', { class: 'muted small' }, t(`up ${uptime(n.uptime)}`, `en marche depuis ${uptime(n.uptime)}`)) : null),
      online && n.maxcpu ? h('div', { class: 'pmon-gauges' },
        gauge(t('CPU', 'Processeur'), n.cpu ?? 0, 1, t(`${n.maxcpu} cores`, `${n.maxcpu} cœurs`)),
        gauge(t('Memory', 'Mémoire'), n.mem ?? 0, n.maxmem ?? 0, `${bytes(n.mem)} / ${bytes(n.maxmem)}`),
        gauge(t('Root disk', 'Disque système'), n.disk ?? 0, n.maxdisk ?? 0, `${bytes(n.disk)} / ${bytes(n.maxdisk)}`)) : null,
      !online ? null
        : Array.isArray(rrd) ? nodeCharts(rrd, this.timeframe)
          : h('p', { class: 'muted small' }, typeof rrd === 'string' ? t(`No history: ${rrd}`, `Pas d'historique : ${rrd}`) : t('Loading…', 'Chargement…')));
  }

  private storages() {
    return this.res.filter((r) => r.type === 'storage' && (!this.onlyNode || r.node === this.onlyNode));
  }

  private storage(): HTMLElement {
    const list = this.storages().sort((a, b) => (a.storage ?? '').localeCompare(b.storage ?? '') || a.node.localeCompare(b.node));
    if (!list.length) return h('span', {});
    const rows = list.map((s) => {
      const p = s.maxdisk ? ((s.disk ?? 0) / s.maxdisk) * 100 : 0;
      const up = s.status === 'available';
      return h('tr', { class: up ? '' : 'pmon-off' },
        h('td', {}, s.storage ?? ''), h('td', {}, s.node), h('td', {}, s.plugintype ?? ''), h('td', { class: 'small' }, (s.content ?? '').replace(/,/g, ', ')),
        h('td', { class: 'pmon-barcell' }, up ? h('div', { class: 'dash-bar' }, h('div', { class: `dash-fill lvl-${level(p)}`, style: `width: ${p}%` })) : t('unavailable', 'indisponible')),
        h('td', { class: 'num' }, up ? `${bytes(s.disk)} / ${bytes(s.maxdisk)}` : ''),
        h('td', { class: 'num' }, up ? percent(p) : ''));
    });
    return h('section', {},
      h('h3', {}, t('Storage', 'Stockages')),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ...[t('Storage', 'Stockage'), t('Node', 'Nœud'), t('Type', 'Type'), t('Content', 'Contenu'), t('Used', 'Occupé'), '', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, ...rows))));
  }

  /** Machines et conteneurs, triés par consommation ; un clic déplie leurs courbes. */
  private table(): HTMLElement {
    const value = (g: PveResource): number | string => {
      const r = this.rates.get(g.id);
      switch (this.sort) {
        case 'name': return guestLabel(g).toLowerCase();
        case 'cpu': return (g.cpu ?? 0) * (g.maxcpu ?? 1);
        case 'mem': return g.mem ?? 0;
        case 'disk': return g.maxdisk ?? 0;
        case 'net': return r?.net ?? 0;
        case 'io': return r?.io ?? 0;
        case 'uptime': return g.uptime ?? 0;
      }
    };
    const guests = this.guests().sort((a, b) => {
      // Les machines en marche d'abord, puis la colonne choisie (du plus gros au plus petit).
      const on = Number(b.status === 'running') - Number(a.status === 'running');
      if (on) return on;
      const va = value(a);
      const vb = value(b);
      return typeof va === 'string' ? va.localeCompare(vb as string) : (vb as number) - va;
    });
    const col = (key: SortKey | null, label: string, cls = '') => h('th', { class: `${cls}${key ? ' sortable' : ''}${key === this.sort ? ' sorted' : ''}`, onclick: key ? () => { this.sort = key; this.render(); } : undefined },
      label, key === this.sort ? ' ▾' : '');
    const rows: HTMLElement[] = [];
    for (const g of guests) {
      const on = g.status === 'running';
      const r = this.rates.get(g.id);
      const cpuPct = (g.cpu ?? 0) * 100;
      const memPct = g.maxmem ? ((g.mem ?? 0) / g.maxmem) * 100 : 0;
      const open = this.expanded.has(g.id);
      rows.push(h('tr', {
        class: `clickable${on ? '' : ' pmon-off'}`, title: t('Click: history', 'Clic : historique'),
        onclick: () => {
          if (open) this.expanded.delete(g.id); else this.expanded.add(g.id);
          if (open) this.render(); else this.refresh();
        },
      },
        h('td', {}, h('span', { class: `dot${on ? ' on' : ''}` }), ' ', icon(g.type === 'qemu' ? 'desktop' : 'box', 13), ' ', guestLabel(g)),
        h('td', {}, g.node),
        h('td', { class: 'num' }, on ? h('strong', { class: `lvl-${level(cpuPct)}` }, percent(cpuPct)) : '', h('span', { class: 'muted small' }, on ? t(` of ${g.maxcpu ?? 0}`, ` sur ${g.maxcpu ?? 0}`) : t(`${g.maxcpu ?? 0} cores`, `${g.maxcpu ?? 0} cœurs`))),
        h('td', { class: 'num' }, on ? `${bytes(g.mem)} / ${bytes(g.maxmem)}` : bytes(g.maxmem), on ? h('span', { class: `muted small lvl-${level(memPct)}` }, ` ${percent(memPct)}`) : null),
        h('td', { class: 'num' }, g.type === 'lxc' && on ? `${bytes(g.disk)} / ${bytes(g.maxdisk)}` : bytes(g.maxdisk)),
        h('td', { class: 'num' }, on && r ? rate(r.net) : ''),
        h('td', { class: 'num' }, on && r ? rate(r.io) : ''),
        h('td', { class: 'num' }, on ? uptime(g.uptime) : t('stopped', 'arrêtée'))));
      if (open) {
        const rrd = this.guestRrd.get(g.id);
        rows.push(h('tr', { class: 'pmon-detail' }, h('td', { colspan: 8 },
          Array.isArray(rrd) ? guestCharts(rrd, this.timeframe) : h('p', { class: 'muted small' }, typeof rrd === 'string' ? t(`No history: ${rrd}`, `Pas d'historique : ${rrd}`) : t('Loading…', 'Chargement…')))));
      }
    }
    return h('section', {},
      h('h3', {}, t('Virtual machines and containers', 'Machines virtuelles et conteneurs')),
      guests.length
        ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl pmon-guests' },
          h('thead', {}, h('tr', {},
            col('name', t('Name', 'Nom')), col(null, t('Node', 'Nœud')), col('cpu', t('CPU', 'Processeur'), 'num'), col('mem', t('Memory', 'Mémoire'), 'num'),
            col('disk', t('Disk', 'Disque'), 'num'), col('net', t('Network', 'Réseau'), 'num'), col('io', t('Disk I/O', 'E/S disque'), 'num'), col('uptime', t('Uptime', 'En marche depuis'), 'num'))),
          h('tbody', {}, ...rows)))
        : h('p', { class: 'muted' }, t('No virtual machine or container.', 'Aucune machine virtuelle ni conteneur.')),
      guests.length ? h('p', { class: 'muted small' }, t('Network and disk rates are measured between two refreshes (10 s). Click a row for its history over the chosen period.', 'Les débits réseau et disque sont mesurés entre deux relevés (10 s). Cliquez sur une ligne pour son historique sur la période choisie.')) : null);
  }
}
