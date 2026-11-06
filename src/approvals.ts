// Approbation des accès d'une Gate (Portunia Gate 0.38 et suivants) : demander l'accès à un
// serveur sur approbation, décider des demandes reçues (approbateurs), retirer un accès accordé.
// Une surveillance en arrière-plan prévient par une notification du système : nouvelle demande
// à décider, réponse à sa propre demande.
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { Gate, gates, errorText } from './api';
import { h } from './dom';
import { LOCALE, t } from './i18n';

export interface Approval {
  id: string; compte: string; serveur: string; motif: string; ticket: string;
  etat: 'attente' | 'accordee' | 'refusee' | 'annulee' | 'expiree';
  demande: string; decide_par: string; decide: string | null; jusqua: string | null; commentaire: string;
}

export interface Approvals {
  mes_demandes: Approval[];
  a_demander: { serveur: string; description?: string; protocole: string; demande: Approval | null }[];
  a_traiter: Approval[];
  en_cours: Approval[];
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : '');
const STATUS: Record<Approval['etat'], () => string> = {
  attente: () => t('waiting', 'en attente'),
  accordee: () => t('granted', 'accordé'),
  refusee: () => t('refused', 'refusé'),
  annulee: () => t('cancelled', 'annulé'),
  expiree: () => t('expired', 'expiré'),
};
const DURATIONS: [number, string][] = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [240, '4 h'], [480, '8 h'], [1440, t('1 day', '1 jour')], [4320, t('3 days', '3 jours')]];

/** Page « Approbations » d'une Gate. */
export function renderApprovals(b: Gate, host: { toast(message: string, kind?: 'info' | 'error'): void }): HTMLElement {
  const content = h('div', { class: 'admin-content' }, h('p', { class: 'muted' }, t('Loading…', 'Chargement…')));
  const call = <T = any>(method: string, path: string, body?: unknown) => gates.admin<T>(b.id, method, path, body);
  const fail = (e: unknown) => host.toast(errorText(e), 'error');
  const table = (head: string[], rows: HTMLElement[]) => h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)));

  const load = async () => {
    let a: Approvals;
    try {
      a = await call<Approvals>('GET', '/approbations');
    } catch (e) {
      content.replaceChildren(h('p', { class: 'form-error' }, errorText(e).includes('404') ? t('This Gate does not offer access approval (Portunia Gate 0.38 and later).', 'Cette Gate ne propose pas l\'approbation des accès (Portunia Gate 0.38 et suivants).') : errorText(e)));
      return;
    }
    const parts: HTMLElement[] = [];

    // À décider (approbateurs).
    if (a.a_traiter.length) {
      parts.push(h('h3', {}, t(`To decide (${a.a_traiter.length})`, `À décider (${a.a_traiter.length})`)));
      parts.push(table([t('Asked', 'Demandé'), t('Account', 'Compte'), t('Server', 'Serveur'), t('Reason', 'Motif'), t('Decision', 'Décision')], a.a_traiter.map((r) => {
        const duration = h('select', { class: 'input', 'aria-label': t('Duration', 'Durée') }, ...DURATIONS.map(([m, label]) => h('option', { value: String(m), selected: m === 60 }, label))) as HTMLSelectElement;
        const comment = h('input', { class: 'input', placeholder: t('Comment (optional)', 'Commentaire (facultatif)'), maxlength: '500' }) as HTMLInputElement;
        const decide = async (grant: boolean) => {
          try {
            await call('POST', `/approbations/${r.id}/decision`, { accorder: grant, minutes: Number(duration.value), commentaire: comment.value });
            host.toast(grant ? t(`Access granted to ${r.compte} on ${r.serveur}`, `Accès accordé à ${r.compte} sur ${r.serveur}`) : t('Request refused', 'Demande refusée'));
          } catch (e) { fail(e); }
          load();
        };
        return h('tr', {},
          h('td', {}, when(r.demande)), h('td', {}, h('strong', {}, r.compte)), h('td', {}, r.serveur),
          h('td', {}, r.motif, r.ticket ? h('span', { class: 'chip' }, r.ticket) : null),
          h('td', {}, h('div', { class: 'appr-decide' }, duration, comment,
            h('button', { class: 'btn sm primary', onclick: () => decide(true) }, t('Grant', 'Accorder')),
            h('button', { class: 'btn sm danger', onclick: () => decide(false) }, t('Refuse', 'Refuser')))));
      })));
    }

    // Accès accordés en cours (approbateurs, et les siens).
    if (a.en_cours.length) {
      parts.push(h('h3', {}, t('Accesses under way', 'Accès en cours')));
      parts.push(table([t('Account', 'Compte'), t('Server', 'Serveur'), t('Until', 'Jusqu\'au'), t('Granted by', 'Accordé par'), ''], a.en_cours.map((r) => h('tr', {},
        h('td', {}, h('strong', {}, r.compte)), h('td', {}, r.serveur), h('td', {}, when(r.jusqua)), h('td', {}, r.decide_par),
        h('td', { class: 'acts' }, h('button', { class: 'btn sm danger', onclick: async () => {
          if (!confirm(t(`Withdraw the access of ${r.compte} to ${r.serveur}? Their sessions close within 30 seconds.`, `Retirer l'accès de ${r.compte} à ${r.serveur} ? Ses sessions se ferment sous 30 secondes.`))) return;
          try { await call('POST', `/approbations/${r.id}/annuler`); host.toast(t('Access withdrawn', 'Accès retiré')); } catch (e) { fail(e); }
          load();
        } }, t('Withdraw', 'Retirer')))))));
    }

    // Demander un accès.
    parts.push(h('h3', {}, t('Ask for access', 'Demander un accès')));
    if (!a.a_demander.length) {
      parts.push(h('p', { class: 'muted' }, t('No server needs an approval for you right now.', 'Aucun serveur ne demande d\'approbation pour vous en ce moment.')));
    } else {
      parts.push(table([t('Server', 'Serveur'), t('Request', 'Demande')], a.a_demander.map((s) => {
        if (s.demande) {
          return h('tr', {}, h('td', {}, h('strong', {}, s.serveur)),
            h('td', {}, h('span', { class: 'chip warn' }, t(`waiting since ${when(s.demande.demande)}`, `en attente depuis le ${when(s.demande.demande)}`)), ' ',
              h('button', { class: 'btn sm', onclick: async () => { try { await call('POST', `/approbations/${s.demande!.id}/annuler`); } catch (e) { fail(e); } load(); } }, t('Cancel', 'Annuler'))));
        }
        const reason = h('input', { class: 'input', placeholder: t('Reason (required)', 'Motif (obligatoire)'), maxlength: '500' }) as HTMLInputElement;
        const ticket = h('input', { class: 'input', placeholder: t('Ticket (optional)', 'Ticket (facultatif)'), maxlength: '100', style: 'max-width:150px' }) as HTMLInputElement;
        const send = h('button', { class: 'btn sm primary', onclick: async () => {
          if (!reason.value.trim()) { reason.focus(); return; }
          try {
            await call('POST', '/approbations', { serveur: s.serveur, motif: reason.value, ticket: ticket.value });
            host.toast(t('Request sent to the approvers', 'Demande envoyée aux approbateurs'));
          } catch (e) { fail(e); }
          load();
        } }, t('Ask', 'Demander'));
        return h('tr', {}, h('td', {}, h('strong', {}, s.serveur), s.description ? h('div', { class: 'muted small' }, s.description) : null),
          h('td', {}, h('div', { class: 'appr-decide' }, reason, ticket, send)));
      })));
    }

    // Mes demandes récentes.
    if (a.mes_demandes.length) {
      parts.push(h('h3', {}, t('My recent requests', 'Mes demandes récentes')));
      parts.push(table([t('Asked', 'Demandé'), t('Server', 'Serveur'), t('Reason', 'Motif'), t('Answer', 'Réponse')], a.mes_demandes.map((r) => h('tr', {},
        h('td', {}, when(r.demande)), h('td', {}, r.serveur), h('td', {}, r.motif),
        h('td', {}, h('span', { class: `chip ${r.etat === 'accordee' ? 'ok' : r.etat === 'attente' ? 'warn' : 'off'}` }, STATUS[r.etat]()),
          r.decide_par ? h('span', { class: 'muted small' }, t(` by ${r.decide_par}`, ` par ${r.decide_par}`)) : null,
          r.etat === 'accordee' && r.jusqua ? h('span', { class: 'muted small' }, t(` until ${when(r.jusqua)}`, ` jusqu'au ${when(r.jusqua)}`)) : null,
          r.commentaire ? h('div', { class: 'muted small' }, r.commentaire) : null)))));
    }
    content.replaceChildren(h('div', { class: 'admin-section' }, ...parts));
  };
  load();
  const timer = window.setInterval(() => { if (!content.isConnected) clearInterval(timer); else load(); }, 30000);
  return h('div', { class: 'ext-page gate-admin' },
    h('header', {}, h('h2', {}, t(`Approvals · ${b.name}`, `Approbations · ${b.name}`)),
      h('p', { class: 'muted' }, t('Servers that need an approver\'s agreement, for a duration, before they can be opened.', 'Serveurs qui demandent l\'accord d\'un approbateur, pour une durée, avant de pouvoir être ouverts.'))),
    content);
}

/**
 * Surveillance des approbations de toutes les Gates connectées (toutes les 60 secondes) :
 * notification du système pour une nouvelle demande à décider ou une réponse reçue.
 */
export class ApprovalWatch {
  private seen = new Map<string, Set<string>>();
  private answered = new Map<string, Map<string, string>>();
  private timer = 0;
  /** Nombre de demandes à décider par Gate (badge du menu). */
  readonly pending = new Map<string, number>();

  constructor(private readonly list: () => Gate[], private readonly onChange: () => void) {}

  start() {
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 60000);
  }

  stop() { clearInterval(this.timer); }

  private async notify(title: string, body: string) {
    try {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === 'granted';
      if (ok) sendNotification({ title, body });
    } catch { /* notifications indisponibles */ }
  }

  private async tick() {
    let changed = false;
    for (const b of this.list().filter((g) => g.connected)) {
      let a: Approvals;
      try { a = await gates.admin<Approvals>(b.id, 'GET', '/approbations'); } catch { continue; }
      const first = !this.seen.has(b.id);
      const seen = this.seen.get(b.id) ?? new Set<string>();
      for (const r of a.a_traiter) {
        if (!seen.has(r.id) && !first) this.notify(t(`Access request · ${b.name}`, `Demande d'accès · ${b.name}`), `${r.compte} → ${r.serveur} : ${r.motif}`);
        seen.add(r.id);
      }
      this.seen.set(b.id, seen);
      const before = this.answered.get(b.id) ?? new Map<string, string>();
      const now = new Map<string, string>();
      for (const r of a.mes_demandes) {
        now.set(r.id, r.etat);
        const was = before.get(r.id);
        if (!first && was === 'attente' && (r.etat === 'accordee' || r.etat === 'refusee')) {
          this.notify(r.etat === 'accordee' ? t(`Access granted · ${r.serveur}`, `Accès accordé · ${r.serveur}`) : t(`Access refused · ${r.serveur}`, `Accès refusé · ${r.serveur}`),
            r.etat === 'accordee' ? t(`By ${r.decide_par}, until ${when(r.jusqua)}`, `Par ${r.decide_par}, jusqu'au ${when(r.jusqua)}`) : t(`By ${r.decide_par}`, `Par ${r.decide_par}`));
        }
      }
      this.answered.set(b.id, now);
      if (this.pending.get(b.id) !== a.a_traiter.length) { this.pending.set(b.id, a.a_traiter.length); changed = true; }
    }
    if (changed) this.onChange();
  }
}
