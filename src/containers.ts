// Panneau « Conteneurs » (Pro) : Docker / Podman et pods Kubernetes du serveur de l'onglet SSH.
import { Container, containers, errorText, Inventory, Pod } from './api';
import { h, icon } from './dom';
import { showMenu } from './menu';

type Kind = 'docker' | 'kube';
type Toast = (m: string, k?: 'info' | 'error') => void;

const stateClass = (s: string) => {
  const v = s.toLowerCase();
  if (v === 'running' || v === 'completed' || v === 'succeeded') return 'up';
  if (v === 'exited' || v === 'dead' || v.includes('error') || v.includes('crash') || v.includes('backoff') || v === 'failed' || v.includes('oom')) return 'down';
  return 'off';
};

export class ContainersPanel {
  readonly el = h('section', { class: 'dash-panel', 'aria-label': 'Conteneurs du serveur' });
  private readonly body = h('div', { class: 'dash-body' });
  private readonly status = h('span', { class: 'muted small grow' });
  private readonly filter = h('input', { type: 'search', class: 'ct-filter', placeholder: 'Filtrer…', 'aria-label': 'Filtrer les conteneurs' });
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
        h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Actualiser', title: 'Actualiser', onclick: () => this.refresh() }, icon('refresh', 14))),
      h('div', { class: 'ct-toolbar' }, this.filter),
      this.body,
      h('footer', { class: 'notes-foot' }, this.status));
    this.body.append(h('p', { class: 'muted' }, 'Lecture des conteneurs…'));
  }

  setVisible(on: boolean) {
    if (on === this.visible) return;
    this.visible = on;
    if (on && !this.inventory) this.refresh();
  }

  async refresh() {
    if (this.loading || this.disposed) return;
    this.loading = true;
    this.status.textContent = 'Lecture…';
    try {
      this.inventory = await containers.list(this.connectionId);
      this.error = '';
      this.status.textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR')}`;
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
      this.toast(`${label} : ${action === 'delete' ? 'pod supprimé (il va être recréé)' : action === 'start' ? 'démarré' : action === 'stop' ? 'arrêté' : 'redémarré'}`);
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
        ? [{ label: 'Supprimer le pod (redémarrage)', icon: 'refresh', danger: true, action: () => { if (confirm(`Supprimer le pod ${pod.name} (${pod.namespace}) ? Son contrôleur (Deployment…) en recréera un.`)) this.run('kube', 'delete', id, pod.name, ns); } }]
        : [
            ...(running
              ? [{ label: 'Redémarrer', icon: 'refresh', action: () => { if (confirm(`Redémarrer le conteneur ${c.name} ?`)) this.run('docker', 'restart', id, c.name); } },
                 { label: 'Arrêter', icon: 'power', danger: true, action: () => { if (confirm(`Arrêter le conteneur ${c.name} ?`)) this.run('docker', 'stop', id, c.name); } }]
              : [{ label: 'Démarrer', icon: 'play', action: () => this.run('docker', 'start', id, c.name) }]),
            { label: 'Copier l\'identifiant', icon: 'copy', action: () => navigator.clipboard.writeText(c.id) },
          ];
      showMenu(e.clientX, e.clientY, items);
    };
    return h('div', { class: 'ct-row' },
      h('span', { class: `net-dot ${stateClass(isPod ? pod.status : c.state)}` }),
      h('div', { class: 'grow', style: 'min-width: 0' },
        h('div', { class: 'ellipsis', title: isPod ? pod.name : c.name }, h('strong', {}, isPod ? pod.name : c.name)),
        h('div', { class: 'muted small ellipsis', title: isPod ? '' : c.image },
          isPod ? `${pod.namespace} · ${pod.ready} prêt · ${pod.status}${pod.restarts !== '0' ? ` · ${pod.restarts} redémarrage(s)` : ''} · ${pod.age}` : `${c.image} · ${c.status}`)),
      running && h('button', { type: 'button', class: 'icon-btn sm', title: 'Ouvrir un shell dans le conteneur', 'aria-label': `Shell dans ${isPod ? pod.name : c.name}`, onclick: () => this.terminal(kind, 'shell', id, isPod ? pod.name : c.name, ns) }, icon('prompt', 14)),
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Suivre les journaux', 'aria-label': `Journaux de ${isPod ? pod.name : c.name}`, onclick: () => this.terminal(kind, 'logs', id, isPod ? pod.name : c.name, ns) }, icon('file', 14)),
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Plus d\'actions', 'aria-label': 'Plus d\'actions', onclick: more }, icon('more', 14)));
  }

  private section<T extends Container | Pod>(kind: Kind, title: string, source: Inventory['docker'] | Inventory['kube']) {
    if (source.state === 'absent') return [];
    if (source.state === 'error') return [h('h4', { class: 'dash-title' }, title), h('p', { class: 'form-error small', style: 'margin: 0' }, source.message)];
    const q = this.filter.value.trim().toLowerCase();
    const items = (source.items as T[]).filter((i) => !q || Object.values(i).join(' ').toLowerCase().includes(q));
    const running = (source.items as T[]).filter((i) => stateClass(kind === 'kube' ? (i as Pod).status : (i as Container).state) === 'up').length;
    return [
      h('h4', { class: 'dash-title' }, `${title} · ${running} / ${source.items.length} actifs`),
      ...(items.length ? items.map((i) => this.row(kind, i)) : [h('p', { class: 'muted small', style: 'margin: 0' }, q ? 'Aucun résultat.' : 'Aucun.')]),
    ];
  }

  private render() {
    if (!this.inventory) {
      this.body.replaceChildren(h('p', { class: 'form-error', style: 'white-space: pre-line' }, this.error || 'Lecture des conteneurs…'));
      return;
    }
    const inv = this.inventory;
    const parts = [...this.section<Container>('docker', 'Docker', inv.docker), ...this.section<Pod>('kube', 'Kubernetes', inv.kube)];
    this.body.replaceChildren(...(parts.length ? parts : [h('p', { class: 'muted' }, 'Ni Docker, ni Podman, ni kubectl sur ce serveur.')]));
    if (this.error) this.body.prepend(h('p', { class: 'form-error small', style: 'margin: 0' }, this.error));
  }

  dispose() { this.disposed = true; }
}
