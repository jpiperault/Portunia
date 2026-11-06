// Journal d'actions d'une session web relayée par une Gate (Portunia Gate 0.35 et suivants) :
// pages ouvertes, envois (formulaires, appels qui modifient), WebSocket, usages du coffre.
// Pas d'image : la Gate ne garde que la méthode, le chemin (sans paramètres) et le statut.
import { h, icon } from './dom';
import { LOCALE, t } from './i18n';

export interface WebAction { t: number; k: 'page' | 'envoi' | 'websocket' | 'coffre'; methode: string; chemin: string; statut: number }

/** Réponse de GET /audit/sessions/{id}/enregistrement pour une session web. */
export interface WebRecording {
  session: { id: string; compte: string; serveur: string; adresse: string; debut: string; fin: string | null; octets: number };
  web: { actions: WebAction[]; duree: number };
  signature: 'verifiee' | 'alteree' | 'absente';
  empreinte: string;
  consultations: { qui: string; date: string; evenement: string }[];
}

const KIND: Record<WebAction['k'], () => string> = {
  page: () => t('Page', 'Page'),
  envoi: () => t('Sent', 'Envoi'),
  websocket: () => 'WebSocket',
  coffre: () => t('Vault', 'Coffre'),
};

export class WebPlayer {
  private filter: WebAction['k'] | 'tout' = 'tout';
  private query = '';
  private readonly list = h('div', { class: 'wp-list' });

  constructor(readonly el: HTMLElement, private readonly rec: WebRecording, private readonly opts: { viewer: string; start?: number; exportText(): void }) {
    this.build();
  }

  /** Heure réelle d'une action (début de la session + temps). */
  private at(a: WebAction): string {
    return new Date(new Date(this.rec.session.debut).getTime() + a.t * 1000).toLocaleTimeString(LOCALE);
  }

  private build() {
    const r = this.rec;
    const s = r.session;
    const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'medium' }) : t('ongoing', 'en cours'));
    const seal = r.signature === 'verifiee'
      ? h('span', { class: 'ap-seal ok', title: `SHA-256 ${r.empreinte}` }, t('✓ Signature checked', '✓ Signature vérifiée'))
      : r.signature === 'alteree'
        ? h('span', { class: 'ap-seal bad', title: `SHA-256 ${r.empreinte}` }, t('✗ File modified since the session', '✗ Fichier modifié depuis la session'))
        : h('span', { class: 'ap-seal', title: t('The signature is added when the session closes (15 minutes without activity)', 'La signature est posée à la fermeture de la session (15 minutes sans activité)') }, s.fin ? t('Interrupted, not signed', 'Interrompue, non signée') : t('Ongoing', 'En cours'));
    const count = (k: WebAction['k']) => r.web.actions.filter((a) => a.k === k).length;
    const head = h('div', { class: 'ap-head' },
      h('h2', {}, s.serveur, ' ', h('span', { class: 'badge proto-web' }, 'WEB')),
      h('span', { class: 'muted small' }, `${s.compte} · ${date(s.debut)} → ${date(s.fin)} · ${s.adresse || '—'}`),
      seal,
      h('div', { class: 'ap-actions' }, h('button', { class: 'btn sm', onclick: () => this.opts.exportText() }, icon('download', 14), t('Transcript', 'Transcription'))));
    const kinds = h('div', { class: 'wp-filters', role: 'tablist' });
    const tab = (k: WebAction['k'] | 'tout', label: string) => {
      const b = h('button', { role: 'tab', 'aria-selected': String(k === this.filter) }, label);
      b.addEventListener('click', () => {
        this.filter = k;
        kinds.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
        this.render();
      });
      return b;
    };
    kinds.append(tab('tout', t(`All (${r.web.actions.length})`, `Tout (${r.web.actions.length})`)),
      ...(['page', 'envoi', 'websocket', 'coffre'] as const).filter((k) => count(k)).map((k) => tab(k, `${KIND[k]()} (${count(k)})`)));
    const search = h('input', { type: 'search', class: 'wp-search', placeholder: t('Filter paths…', 'Filtrer les chemins…'), 'aria-label': t('Filter paths', 'Filtrer les chemins') }) as HTMLInputElement;
    search.addEventListener('input', () => { this.query = search.value.trim().toLowerCase(); this.render(); });
    const note = h('p', { class: 'ap-note' }, t(
      'The Gate notes pages opened, data sent (forms, changes), WebSockets and vault use: method, path without parameters, status. Never what is typed, nor images and scripts.',
      'La Gate note les pages ouvertes, les envois (formulaires, modifications), les WebSocket et l\'usage du coffre : méthode, chemin sans paramètres, statut. Jamais ce qui est saisi, ni les images et scripts.'));
    const views = r.consultations.length
      ? t('Replays: ', 'Relectures : ') + r.consultations.map((c) => `${c.qui} (${new Date(c.date).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' })})`).join(', ') + '.'
      : t('First replay.', 'Première relecture.');
    this.el.classList.add('web-player');
    this.el.append(head, h('div', { class: 'wp-bar' }, kinds, search), note, this.list,
      h('p', { class: 'ap-note' }, t(`Viewed by ${this.opts.viewer}. `, `Consulté par ${this.opts.viewer}. `), views));
    this.render();
  }

  private render() {
    const shown = this.rec.web.actions.filter((a) => (this.filter === 'tout' || a.k === this.filter) && (!this.query || a.chemin.toLowerCase().includes(this.query)));
    this.list.replaceChildren(...shown.map((a) => {
      const row = h('div', { class: `wp-row k-${a.k}${a.statut >= 400 ? ' err' : ''}`, 'data-t': String(a.t) },
        h('span', { class: 'num muted' }, this.at(a)),
        h('span', { class: `wp-kind k-${a.k}` }, KIND[a.k]?.() ?? a.k),
        h('span', { class: 'wp-method' }, a.methode),
        h('code', { class: 'wp-path' }, a.chemin),
        h('span', { class: `num wp-status${a.statut >= 400 ? ' bad' : ''}` }, String(a.statut)));
      return row;
    }));
    if (!shown.length) this.list.append(h('p', { class: 'ap-note' }, t('No action.', 'Aucune action.')));
    // Ouvert depuis une recherche : la première action trouvée est mise en avant.
    if (this.opts.start != null) {
      const row = [...this.list.querySelectorAll<HTMLElement>('.wp-row')].find((r) => Math.abs(Number(r.dataset.t) - this.opts.start!) < 0.01);
      row?.classList.add('now');
      row?.scrollIntoView({ block: 'center' });
    }
  }

  transcript(): string {
    const s = this.rec.session;
    return [
      t(`Web session ${s.id}`, `Session web ${s.id}`),
      t(`Account ${s.compte} · server ${s.serveur} · from ${s.adresse}`, `Compte ${s.compte} · serveur ${s.serveur} · depuis ${s.adresse}`),
      t(`Start ${new Date(s.debut).toLocaleString(LOCALE)} · end ${s.fin ? new Date(s.fin).toLocaleString(LOCALE) : 'ongoing'}`,
        `Début ${new Date(s.debut).toLocaleString(LOCALE)} · fin ${s.fin ? new Date(s.fin).toLocaleString(LOCALE) : 'en cours'}`),
      `Signature ${this.rec.signature} · SHA-256 ${this.rec.empreinte}`,
      '',
      ...this.rec.web.actions.map((a) => `[${this.at(a)}] ${(KIND[a.k]?.() ?? a.k).padEnd(9)} ${a.methode.padEnd(6)} ${String(a.statut).padEnd(4)} ${a.chemin}`),
      '',
    ].join('\n');
  }

  dispose() {
    this.el.replaceChildren();
  }
}
