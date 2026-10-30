// Panneau « Conteneurs » (Pro) : Docker / Podman et pods Kubernetes du serveur de l'onglet SSH.
import { Container, containers, errorText, Inventory, Pod } from './api';
import { h, icon } from './dom';
import { showMenu } from './menu';
import { LOCALE, t } from './i18n';

type Kind = 'docker' | 'kube';
type Toast = (m: string, k?: 'info' | 'error') => void;

const stateClass = (s: string) => {
  const v = s.toLowerCase();
  if (v === 'running' || v === 'completed' || v === 'succeeded') return 'up';
  if (v === 'exited' || v === 'dead' || v.includes('error') || v.includes('crash') || v.includes('backoff') || v === 'failed' || v.includes('oom')) return 'down';
  return 'off';
};

export class ContainersPanel {
  readonly el = h('section', { class: 'dash-panel', 'aria-label': t('Server containers', 'Conteneurs du serveur') });
  private readonly body = h('div', { class: 'dash-body' });
  private readonly status = h('span', { class: 'muted small grow' });
  private readonly filter = h('input', { type: 'search', class: 'ct-filter', placeholder: t('Filter…', 'Filtrer…'), 'aria-label': t('Filter containers', 'Filtrer les conteneurs') });
  private inventory: Inventory | null = null;
  private error = '';
  private visible = false;
  private loading = false;
  private disposed = false;

  constructor(
    readonly connectionId: string,
    title: string,
    private readonly toast: Toast,
    /** Ouvre un onglet terminal qui lance cette commande sur le serveur. */
    private readonly openTerminal: (label: string, command: string) => void,
  ) {
    this.filter.addEventListener('input', () => this.render());
    this.el.append(
      h('header', { class: 'notes-head' }, icon('box', 14), h('strong', { class: 'grow ellipsis' }, `Conteneurs · ${title}`),
        h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': t('Refresh', 'Actualiser'), title: t('Refresh', 'Actualiser'), onclick: () => this.refresh() }, icon('refresh', 14))),
      h('div', { class: 'ct-toolbar' }, this.filter),
      this.body,
      h('footer', { class: 'notes-foot' }, this.status));
    this.body.append(h('p', { class: 'muted' }, t('Reading containers…', 'Lecture des conteneurs…')));
  }

  setVisible(on: boolean) {
    if (on === this.visible) return;
    this.visible = on;
    if (on && !this.inventory) this.refresh();
  }

  async refresh() {
    if (this.loading || this.disposed) return;
    this.loading = true;
    this.status.textContent = t('Reading…', 'Lecture…');
    try {
      this.inventory = await containers.list(this.connectionId);
      this.error = '';
      this.status.textContent = t(`Updated at ${new Date().toLocaleTimeString(LOCALE)}`, `Mis à jour à ${new Date().toLocaleTimeString(LOCALE)}`);
    } catch (e) {
      this.error = errorText(e);
      this.status.textContent = '';
    } finally {
      this.loading = false;
    }
    this.render();
  }

  private async run(kind: Kind, action: string, id: string, label: string, namespace?: string) {
    try {
      await containers.action(this.connectionId, kind, action, id, namespace);
      this.toast(t(`${label}: ${action === 'delete' ? 'pod deleted (it will be recreated)' : action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'}`, `${label} : ${action === 'delete' ? 'pod supprimé (il va être recréé)' : action === 'start' ? 'démarré' : action === 'stop' ? 'arrêté' : 'redémarré'}`));
      setTimeout(() => this.refresh(), 800);
    } catch (e) {
      this.toast(errorText(e), 'error');
    }
  }

  private async terminal(kind: Kind, what: 'shell' | 'logs', id: string, label: string, namespace?: string) {
    try {
      const command = await containers.command(kind, what, id, namespace);
      this.openTerminal(`${what === 'shell' ? '⌘' : '≡'} ${label}`, command);
    } catch (e) {
      this.toast(errorText(e), 'error');
    }
  }

  private row(kind: Kind, item: Container | Pod) {
    const isPod = kind === 'kube';
    const pod = item as Pod;
    const c = item as Container;
    const id = isPod ? pod.name : c.id;
    const ns = isPod ? pod.namespace : undefined;
    const running = isPod ? pod.status === 'Running' : c.state === 'running';
    const more = (e: MouseEvent) => {
      const items = isPod
        ? [{ label: t('Delete the pod (restart)', 'Supprimer le pod (redémarrage)'), icon: 'refresh', danger: true, action: () => { if (confirm(t(`Delete pod ${pod.name} (${pod.namespace})? Its controller (Deployment…) will recreate one.`, `Supprimer le pod ${pod.name} (${pod.namespace}) ? Son contrôleur (Deployment…) en recréera un.`))) this.run('kube', 'delete', id, pod.name, ns); } }]
        : [
            ...(running
              ? [{ label: t('Restart', 'Redémarrer'), icon: 'refresh', action: () => { if (confirm(t(`Restart container ${c.name}?`, `Redémarrer le conteneur ${c.name} ?`))) this.run('docker', 'restart', id, c.name); } },
                 { label: t('Stop', 'Arrêter'), icon: 'power', danger: true, action: () => { if (confirm(t(`Stop container ${c.name}?`, `Arrêter le conteneur ${c.name} ?`))) this.run('docker', 'stop', id, c.name); } }]
              : [{ label: t('Start', 'Démarrer'), icon: 'play', action: () => this.run('docker', 'start', id, c.name) }]),
            { label: t('Copy the ID', 'Copier l\'identifiant'), icon: 'copy', action: () => navigator.clipboard.writeText(c.id) },
          ];
      showMenu(e.clientX, e.clientY, items);
    };
    return h('div', { class: 'ct-row' },
      h('span', { class: `net-dot ${stateClass(isPod ? pod.status : c.state)}` }),
      h('div', { class: 'grow', style: 'min-width: 0' },
        h('div', { class: 'ellipsis', title: isPod ? pod.name : c.name }, h('strong', {}, isPod ? pod.name : c.name)),
        h('div', { class: 'muted small ellipsis', title: isPod ? '' : c.image },
          isPod ? t(`${pod.namespace} · ${pod.ready} ready · ${pod.status}${pod.restarts !== '0' ? ` · ${pod.restarts} restart(s)` : ''} · ${pod.age}`, `${pod.namespace} · ${pod.ready} prêt · ${pod.status}${pod.restarts !== '0' ? ` · ${pod.restarts} redémarrage(s)` : ''} · ${pod.age}`) : `${c.image} · ${c.status}`)),
      running && h('button', { type: 'button', class: 'icon-btn sm', title: t('Open a shell in the container', 'Ouvrir un shell dans le conteneur'), 'aria-label': t(`Shell in ${isPod ? pod.name : c.name}`, `Shell dans ${isPod ? pod.name : c.name}`), onclick: () => this.terminal(kind, 'shell', id, isPod ? pod.name : c.name, ns) }, icon('prompt', 14)),
      h('button', { type: 'button', class: 'icon-btn sm', title: t('Follow the logs', 'Suivre les journaux'), 'aria-label': `Journaux de ${isPod ? pod.name : c.name}`, onclick: () => this.terminal(kind, 'logs', id, isPod ? pod.name : c.name, ns) }, icon('file', 14)),
      h('button', { type: 'button', class: 'icon-btn sm', title: t('More actions', 'Plus d\'actions'), 'aria-label': t('More actions', 'Plus d\'actions'), onclick: more }, icon('more', 14)));
  }

  private section<T extends Container | Pod>(kind: Kind, title: string, source: Inventory['docker'] | Inventory['kube']) {
    if (source.state === 'absent') return [];
    if (source.state === 'error') return [h('h4', { class: 'dash-title' }, title), h('p', { class: 'form-error small', style: 'margin: 0' }, source.message)];
    const q = this.filter.value.trim().toLowerCase();
    const items = (source.items as T[]).filter((i) => !q || Object.values(i).join(' ').toLowerCase().includes(q));
    const running = (source.items as T[]).filter((i) => stateClass(kind === 'kube' ? (i as Pod).status : (i as Container).state) === 'up').length;
    return [
      h('h4', { class: 'dash-title' }, `${title} · ${running} / ${source.items.length} actifs`),
      ...(items.length ? items.map((i) => this.row(kind, i)) : [h('p', { class: 'muted small', style: 'margin: 0' }, q ? t('No result.', 'Aucun résultat.') : t('None.', 'Aucun.'))]),
    ];
  }

  private render() {
    if (!this.inventory) {
      this.body.replaceChildren(h('p', { class: 'form-error', style: 'white-space: pre-line' }, this.error || t('Reading containers…', 'Lecture des conteneurs…')));
      return;
    }
    const inv = this.inventory;
    const parts = [...this.section<Container>('docker', 'Docker', inv.docker), ...this.section<Pod>('kube', 'Kubernetes', inv.kube)];
    this.body.replaceChildren(...(parts.length ? parts : [h('p', { class: 'muted' }, t('No Docker, Podman or kubectl on this server.', 'Ni Docker, ni Podman, ni kubectl sur ce serveur.'))]));
    if (this.error) this.body.prepend(h('p', { class: 'form-error small', style: 'margin: 0' }, this.error));
  }

  dispose() { this.disposed = true; }
}
