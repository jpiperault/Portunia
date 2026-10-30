// Supervision légère : pastilles dans l'arbre, vue d'ensemble, alertes (Pro).
import { invoke } from './api';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { Session } from './api';
import { h, icon } from './dom';
import { settings, updateSettings } from './settings';
import { t } from './i18n';

export interface Probe {
  id: string;
  up: boolean;
  latencyMs: number | null;
  error: string | null;
}

interface Health extends Probe {
  checkedAt: number;
  /** Depuis quand le serveur est dans cet état. */
  since: number;
}

const DEFAULT_PORTS: Record<string, number> = { ssh: 22, rdp: 3389, vnc: 5900, telnet: 23 };

/** Hôte et port à tester pour une session (null : rien à superviser, ex. port série). */
export function targetOf(s: Session): { host: string; port: number } | null {
  if (s.protocol === 'web' && typeof s.values.url === 'string') {
    try {
      const url = new URL(s.values.url);
      return { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
    } catch { return null; }
  }
  const host = typeof s.values.host === 'string' ? s.values.host.trim() : '';
  const port = Number(s.values.port) || DEFAULT_PORTS[s.protocol];
  return host && port ? { host, port } : null;
}

export class Monitor {
  private health = new Map<string, Health>();
  private timer = 0;
  private running = false;

  constructor(
    private readonly sessions: () => Session[],
    private readonly onChange: () => void,
  ) {}

  start() {
    this.stop();
    if (!settings().monitoring) return;
    this.check();
    this.timer = window.setInterval(() => this.check(), Math.max(15, settings().monitorInterval) * 1000);
  }

  stop() {
    window.clearInterval(this.timer);
  }

  get(sessionId: string): Health | undefined {
    return settings().monitoring ? this.health.get(sessionId) : undefined;
  }

  isExcluded = (sessionId: string) => settings().monitorExcluded.includes(sessionId);

  toggleExcluded(sessionId: string) {
    const list = settings().monitorExcluded;
    updateSettings({ monitorExcluded: list.includes(sessionId) ? list.filter((x) => x !== sessionId) : [...list, sessionId] });
    if (this.isExcluded(sessionId)) this.health.delete(sessionId);
    this.onChange();
    this.check();
  }

  /** Résumé pour la barre d'état. */
  summary() {
    // Seulement les sessions encore supervisées (une extension a pu être désactivée).
    const ids = new Set(this.sessions().map((s) => s.id));
    const all = [...this.health].filter(([id]) => ids.has(id)).map(([, x]) => x);
    return { total: all.length, up: all.filter((x) => x.up).length };
  }

  async check() {
    if (this.running || !settings().monitoring) return;
    this.running = true;
    try {
      const targets = this.sessions()
        .filter((s) => !this.isExcluded(s.id))
        .map((s) => ({ s, t: targetOf(s) }))
        .filter((x): x is { s: Session; t: { host: string; port: number } } => !!x.t)
        .map(({ s, t }) => ({ id: s.id, host: t.host, port: t.port }));
      const probes = await invoke<Probe[]>('monitor_check', { targets });
      const now = Date.now();
      const changes: { session: Session; up: boolean; error: string | null }[] = [];
      for (const p of probes) {
        const before = this.health.get(p.id);
        const changed = before !== undefined && before.up !== p.up;
        this.health.set(p.id, { ...p, checkedAt: now, since: changed || !before ? now : before.since });
        const session = this.sessions().find((s) => s.id === p.id);
        if (changed && session) changes.push({ session, up: p.up, error: p.error });
      }
      // Sessions supprimées ou exclues entre-temps.
      const ids = new Set(targets.map((t) => t.id));
      for (const id of [...this.health.keys()]) if (!ids.has(id)) this.health.delete(id);
      this.onChange();
      if (changes.length) await this.alert(changes);
    } catch { /* nouvelle tentative au prochain passage */ }
    this.running = false;
  }

  /** Notification Windows quand un serveur tombe ou revient (édition Pro). */
  private async alert(changes: { session: Session; up: boolean; error: string | null }[]) {
    if (!settings().monitorAlerts || !(await invoke<boolean>('monitor_alerts_allowed'))) return;
    if (!(await isPermissionGranted()) && (await requestPermission()) !== 'granted') return;
    for (const c of changes.slice(0, 5)) {
      sendNotification({
        title: c.up ? t(`${c.session.name} is answering again`, `${c.session.name} répond de nouveau`) : t(`${c.session.name} is not answering`, `${c.session.name} ne répond plus`),
        body: c.up ? t('The server is reachable again.', 'Le serveur est de nouveau joignable.') : (c.error ?? t('The server is unreachable.', 'Le serveur est injoignable.')),
      });
    }
    if (changes.length > 5) sendNotification({ title: 'Portunia', body: t(`${changes.length - 5} other status change(s).`, `${changes.length - 5} autre(s) changement(s) d'état.`) });
  }

  /** Vue d'ensemble : tous les serveurs supervisés. */
  openOverview(open: (s: Session) => void) {
    const rows = h('div', { class: 'snip-list' });
    const fmtAge = (at: number) => {
      const min = Math.round((Date.now() - at) / 60000);
      return min < 1 ? t('just now', 'à l\'instant') : min < 60 ? t(`${min} min ago`, `depuis ${min} min`) : t(`${Math.round(min / 60)} h ago`, `depuis ${Math.round(min / 60)} h`);
    };
    const render = () => {
      const list = this.sessions()
        .map((s) => ({ s, hlt: this.health.get(s.id), target: targetOf(s) }))
        .filter((x) => x.target)
        .sort((a, b) => Number(a.hlt?.up ?? 2) - Number(b.hlt?.up ?? 2) || a.s.name.localeCompare(b.s.name, 'fr'));
      rows.replaceChildren(...list.map(({ s, hlt, target }) => h('div', { class: 'snip-row' },
        h('span', { class: `health ${this.isExcluded(s.id) ? 'off' : hlt ? (hlt.up ? 'up' : 'down') : 'unknown'}` }),
        h('div', { class: 'grow', style: 'min-width: 0' },
          h('div', { class: 'ellipsis' }, h('strong', {}, s.name), ' ', h('span', { class: 'muted small' }, `${target!.host}:${target!.port}${s.folder ? ` · ${s.folder}` : ''}`)),
          h('div', { class: 'muted small' }, this.isExcluded(s.id) ? t('Not monitored', 'Non surveillé')
            : !hlt ? t('Waiting for a check', 'En attente de vérification')
            : hlt.up ? `En ligne · ${hlt.latencyMs} ms · ${fmtAge(hlt.since)}`
            : `Injoignable ${fmtAge(hlt.since)} · ${hlt.error ?? ''}`)),
        h('button', { class: 'btn', onclick: () => { dialog.close(); open(s); } }, t('Open', 'Ouvrir')),
        h('button', { class: 'btn', onclick: () => { this.toggleExcluded(s.id); render(); } }, this.isExcluded(s.id) ? t('Monitor', 'Surveiller') : t('Ignore', 'Ignorer')))));
    };
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'mon-title' },
      h('div', { class: 'snip-dialog' },
        h('header', { class: 'dlg-head' },
          h('h2', { id: 'mon-title' }, t('Monitoring', 'Supervision')),
          h('div', { style: 'display: flex; gap: 6px' },
            h('button', { type: 'button', class: 'btn', onclick: async () => { await this.check(); render(); } }, icon('refresh', 14), t('Check now', 'Vérifier maintenant')),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close', 'Fermer'), onclick: () => dialog.close() }, icon('close')))),
        h('div', { class: 'dlg-body' }, rows)));
    const refresh = window.setInterval(render, 5000);
    dialog.addEventListener('close', () => { window.clearInterval(refresh); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
    render();
  }
}
