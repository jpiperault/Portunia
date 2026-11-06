// Audit d'une Gate (onglet) : sessions avec recherche et relecture, journal vérifié.
// Ouvert par le menu « Audit » de la Gate : administrateurs, auditeurs, et chaque compte pour
// ses propres sessions si la Gate l'autorise.
import { save } from '@tauri-apps/plugin-dialog';
import { Gate, gates, errorText } from './api';
import { h } from './dom';
import { LOCALE, t } from './i18n';

export interface AuditHost {
  toast(message: string, kind?: 'info' | 'error'): void;
  /** Ouvre la relecture d'une session dans un onglet, à `start` secondes si donné. */
  openRecording(b: Gate, session: AuditRow, start?: number): void;
}

export interface AuditRow {
  id: string; compte: string; serveur: string; type: string; detail: string; mode: string; adresse: string;
  debut: string; fin: string | null; enregistree: boolean; frappe: boolean; octets: number;
  /** Fichiers copiés en Bureau à distance (Portunia Gate 0.28 et suivantes). */
  fichiers?: number;
  /** Absent sur une Gate antérieur à la 0.8 : relisible si enregistrée. */
  relisible?: boolean;
  /** Session Bureau à distance relisible (Portunia Gate 0.10 et suivants). */
  relisible_rdp?: boolean;
  /** Journal d'actions d'une interface web (Portunia Gate 0.35 et suivants). */
  relisible_web?: boolean;
  trouve: { t: number; extrait: string } | null;
}

type Section = 'direct' | 'sessions' | 'journal';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : '');
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const duration = (s: AuditRow) => {
  if (!s.fin) return null;
  const sec = Math.round((Date.parse(s.fin) - Date.parse(s.debut)) / 1000);
  return sec >= 3600 ? `${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}` : sec >= 60 ? `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')}` : `${sec} s`;
};
const MODE_LABEL: Record<string, string> = { coffre: t('vault', 'coffre'), enregistre: t('recorded', 'enregistré'), rebond: t('jump', 'rebond') };

function table(head: string[], rows: HTMLElement[]) {
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)));
}

/** Jour local au format AAAA-MM-JJ, `days` jours avant aujourd'hui. */
function dayBefore(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function renderGateAudit(b: Gate, host: AuditHost): HTMLElement {
  const full = b.role === 'admin' || b.role === 'auditor';
  const sections: { id: Section; label: string }[] = full
    ? [{ id: 'direct', label: t('Live', 'En direct') }, { id: 'sessions', label: 'Sessions' }, { id: 'journal', label: t('Log', 'Journal') }]
    : [{ id: 'sessions', label: t('My sessions', 'Mes sessions') }];
  // Rafraîchissement de l'onglet En direct (arrêté en changeant d'onglet ou en fermant l'Audit).
  let liveTimer = 0;
  const nav = h('div', { class: 'seg admin-nav', role: 'tablist' });
  const content = h('div', { class: 'admin-content' });
  const call = <T = any>(path: string) => gates.admin<T>(b.id, 'GET', path);
  const fail = (e: unknown) => host.toast(errorText(e) === 'SESSION_EXPIREE' ? t('Gate session expired: sign in again (sidebar).', 'Session de la Gate expirée : reconnectez-vous (barre latérale).') : errorText(e), 'error');

  const show = async (id: Section) => {
    clearInterval(liveTimer);
    nav.replaceChildren(...sections.map((s) => h('button', { type: 'button', role: 'tab', class: `seg-opt${s.id === id ? ' on' : ''}`, 'aria-selected': String(s.id === id), onclick: () => show(s.id) }, s.label)));
    content.replaceChildren(h('p', { class: 'muted' }, t('Loading…', 'Chargement…')));
    try {
      content.replaceChildren(await (id === 'direct' ? live() : id === 'sessions' ? sessions() : journal()));
    } catch (e) {
      content.replaceChildren(h('p', { class: 'form-error' }, errorText(e)));
      fail(e);
    }
  };

  // --- En direct ---
  const live = async () => {
    const list = h('div');
    const note = h('p', { class: 'muted small' });
    const since = (iso: string) => {
      const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
      return sec >= 3600 ? `${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}` : sec >= 60 ? `${Math.floor(sec / 60)} min` : `${sec} s`;
    };
    // Ligne de confirmation de la coupure, sous la session (une à la fois).
    let confirmFor = '';
    const cut = async (s: AuditRow, disable: boolean) => {
      try {
        await gates.admin(b.id, 'POST', `/audit/sessions/${s.id}/couper`, { desactiver: disable });
        host.toast(disable ? t(`Session cut, account ${s.compte} disabled.`, `Session coupée, compte ${s.compte} désactivé.`) : t('Session cut.', 'Session coupée.'));
      } catch (e) { fail(e); }
      confirmFor = '';
      await load().catch(fail);
    };
    const load = async () => {
      const { sessions, prevenir } = await call<{ sessions: AuditRow[]; prevenir: boolean }>('/audit/direct');
      const rows: HTMLElement[] = [];
      for (const s of sessions) {
        const follow = s.enregistree && (s.relisible_rdp || s.relisible_web || s.relisible !== false);
        rows.push(h('tr', { class: 'live' },
          h('td', {}, fmtDate(s.debut)),
          h('td', {}, since(s.debut)),
          h('td', {}, s.compte),
          h('td', {}, h('strong', {}, s.serveur), s.type !== 'shell' ? h('span', { class: 'muted small' }, ` · ${s.type}`) : null),
          h('td', {}, s.mode ? h('span', { class: `badge mode-${s.mode}` }, MODE_LABEL[s.mode] ?? s.mode) : null),
          h('td', { class: 'muted small' }, s.adresse),
          h('td', { class: 'acts' },
            follow ? h('button', { class: 'btn sm primary', title: prevenir && s.type !== 'rdp' && s.type !== 'web' ? t('The user is told that the session is followed', 'L\'utilisateur est prévenu que la session est suivie') : '', onclick: () => host.openRecording(b, s) }, t('◉ Follow', '◉ Suivre')) : h('span', { class: 'muted small' }, s.mode === 'rebond' ? t('jump, not recorded', 'rebond, non enregistrée') : t('not recorded', 'non enregistrée')),
            ' ',
            h('button', { class: 'btn sm danger', onclick: () => { confirmFor = confirmFor === s.id ? '' : s.id; render(); } }, t('Cut', 'Couper')))));
        if (confirmFor === s.id) {
          const disable = h('input', { type: 'checkbox' }) as HTMLInputElement;
          rows.push(h('tr', { class: 'cut-confirm' }, h('td', { colspan: '7' },
            h('div', { class: 'cut-row' },
              h('span', {}, t(`Cut ${s.compte}'s session on ${s.serveur} now?`, `Couper maintenant la session de ${s.compte} sur ${s.serveur} ?`)),
              b.role === 'admin' ? h('label', { class: 'check-row' }, disable, h('span', {}, t(`Also disable account ${s.compte}`, `Désactiver aussi le compte ${s.compte}`))) : null,
              h('button', { class: 'btn sm danger', onclick: () => cut(s, disable.checked) }, t('Cut the session', 'Couper la session')),
              h('button', { class: 'btn sm', onclick: () => { confirmFor = ''; render(); } }, t('Cancel', 'Annuler'))))));
        }
      }
      list.replaceChildren(rows.length
        ? table([t('Start', 'Début'), t('For', 'Depuis'), t('Account', 'Compte'), t('Server', 'Serveur'), 'Mode', t('From', 'Adresse'), ''], rows)
        : h('p', { class: 'muted' }, t('No open session right now.', 'Aucune session ouverte en ce moment.')));
      note.textContent = t(
        `${sessions.length} open session(s), refreshed every 10 seconds. Following a session is written to the Gate's log${prevenir ? '; SSH users are told' : ''}. Cutting closes it at once.`,
        `${sessions.length} session(s) ouverte(s), mises à jour toutes les 10 secondes. Suivre une session est inscrit au journal de la Gate${prevenir ? ' ; en SSH, l\'utilisateur en est prévenu' : ''}. Couper la ferme tout de suite.`);
    };
    // Ouverture ou fermeture de la confirmation : liste relue.
    const render = () => { load().catch(fail); };
    await load();
    liveTimer = window.setInterval(() => {
      if (!list.isConnected) { clearInterval(liveTimer); return; }
      // Pas de rafraîchissement pendant une confirmation : la ligne ne doit pas disparaître.
      if (!confirmFor) load().catch(fail);
    }, 10000);
    return h('div', { class: 'admin-section' }, list, note);
  };

  // --- Sessions ---
  const sessions = async () => {
    const text = h('input', { id: 'au-text', type: 'search', class: 'input grow', placeholder: t('Search keystrokes and screen (rm -rf, file name…)', 'Rechercher dans la frappe et l\'écran (rm -rf, nom de fichier…)') }) as HTMLInputElement;
    const who = h('input', { id: 'au-who', class: 'input', placeholder: t('Account', 'Compte'), list: 'au-who-list', hidden: !full }) as HTMLInputElement;
    const srv = h('input', { id: 'au-srv', class: 'input', placeholder: t('Server', 'Serveur'), list: 'au-srv-list' }) as HTMLInputElement;
    const when = h('select', { id: 'au-when', class: 'input', 'aria-label': t('Period', 'Période') },
      h('option', { value: '0' }, t('Today', 'Aujourd\'hui')), h('option', { value: '7', selected: true }, t('Last 7 days', '7 derniers jours')),
      h('option', { value: '30' }, t('Last 30 days', '30 derniers jours')), h('option', { value: '365' }, t('Last 12 months', '12 derniers mois')), h('option', { value: '' }, t('All', 'Tout'))) as HTMLSelectElement;
    const keys = h('input', { id: 'au-keys', type: 'checkbox' }) as HTMLInputElement;
    const copied = h('input', { id: 'au-files', type: 'checkbox' }) as HTMLInputElement;
    const whoList = h('datalist', { id: 'au-who-list' });
    const srvList = h('datalist', { id: 'au-srv-list' });
    const list = h('div');
    const note = h('p', { class: 'muted small' });
    const load = async () => {
      const q = new URLSearchParams({ limite: '300' });
      if (text.value.trim()) q.set('texte', text.value.trim());
      if (who.value.trim()) q.set('compte', who.value.trim());
      if (srv.value.trim()) q.set('serveur', srv.value.trim());
      if (when.value) q.set('depuis', dayBefore(Number(when.value)));
      if (keys.checked) q.set('frappe', 'true');
      if (copied.checked) q.set('fichiers', 'true');
      const { sessions } = await call<{ sessions: AuditRow[] }>(`/audit/sessions?${q}`);
      const searching = !!text.value.trim();
      // Suggestions des filtres : comptes et serveurs déjà vus.
      const fill = (dl: HTMLElement, values: string[]) => {
        const known = new Set([...dl.querySelectorAll('option')].map((o) => o.value));
        for (const v of values) if (v && !known.has(v)) { dl.append(h('option', { value: v })); known.add(v); }
      };
      fill(whoList, sessions.map((s) => s.compte));
      fill(srvList, sessions.map((s) => s.serveur));
      const rows = sessions.map((s) => {
        const replay = (start?: number) => host.openRecording(b, s, start);
        const live = !s.fin;
        return h('tr', { class: live ? 'live' : '' },
          h('td', {}, fmtDate(s.debut)),
          h('td', {}, live ? h('span', { class: 'chip ok' }, t('ongoing', 'en cours')) : duration(s)),
          full ? h('td', {}, s.compte) : null,
          h('td', {}, h('strong', {}, s.serveur), s.type !== 'shell' ? h('span', { class: 'muted small' }, ` · ${s.type}${s.detail && s.type === 'exec' ? ` ${s.detail}` : ''}`) : null),
          h('td', {}, s.mode ? h('span', { class: `badge mode-${s.mode}` }, MODE_LABEL[s.mode] ?? s.mode) : null, s.frappe ? h('span', { class: 'chip keys', title: t('Keystrokes recorded', 'Frappe enregistrée') }, t('keystrokes', 'frappe')) : null,
            s.fichiers ? h('span', { class: 'chip keys', title: t('Files copied through the clipboard (name, size and SHA-256 in the log)', 'Fichiers copiés par le presse-papiers (nom, taille et SHA-256 au journal)') }, t(`${s.fichiers} file(s)`, `${s.fichiers} fichier(s)`)) : null),
          searching ? h('td', { class: 'hit' }, s.trouve ? h('button', { class: 'hit-btn', title: t('Replay from this moment', 'Relire à ce moment'), onclick: () => replay(s.trouve!.t) }, h('span', { class: 'num' }, clock(s.trouve.t)), ' ', h('code', {}, s.trouve.extrait)) : h('span', { class: 'muted' }, '—')) : null,
          h('td', { class: 'acts' }, s.enregistree && (s.relisible_rdp || s.relisible_web || s.relisible !== false)
            ? h('button', { class: 'btn sm primary', onclick: () => replay(s.trouve?.t) }, s.type === 'web' ? t('Actions', 'Actions') : t('▶ Replay', '▶ Relire'))
            : s.enregistree
              ? h('span', { class: 'muted small', title: t('Recorded and signed by the Gate', 'Enregistrée et signée par la Gate') }, t('Remote Desktop: replay coming soon', 'Bureau à distance : relecture bientôt'))
              : h('span', { class: 'muted small' }, s.mode === 'rebond' ? t('jump, not recorded', 'rebond, non enregistrée') : t('not recorded', 'non enregistrée'))));
      });
      const head = [t('Start', 'Début'), t('Duration', 'Durée'), ...(full ? [t('Account', 'Compte')] : []), t('Server', 'Serveur'), 'Mode', ...(searching ? [t('Found', 'Trouvé')] : []), ''];
      list.replaceChildren(rows.length ? table(head, rows) : h('p', { class: 'muted' }, searching ? t('No session contains this text in this period.', 'Aucune session ne contient ce texte sur cette période.') : t('No session in this period.', 'Aucune session sur cette période.')));
      note.textContent = searching
        ? t('The search covers keystrokes and displayed text (masked input excluded). « Found » opens the replay at that moment.', 'La recherche porte sur la frappe et le texte affiché (saisies masquées exclues). « Trouvé » ouvre la relecture à ce moment.')
        : t(`${sessions.length} session(s). Each replay is written to the Gate's log.`, `${sessions.length} session(s). Chaque relecture est inscrite au journal de la Gate.`);
    };
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = window.setTimeout(() => load().catch(fail), 350); };
    for (const x of [text, who, srv]) x.addEventListener('input', later);
    for (const x of [when, keys, copied]) x.addEventListener('change', () => load().catch(fail));
    await load();
    return h('div', { class: 'admin-section' },
      full ? null : h('div', { class: 'banner info' }, t('The Gate lets you replay your own sessions.', 'La Gate vous permet de relire vos propres sessions.')),
      h('div', { class: 'audit-filters' }, text, who, srv, when, h('label', { class: 'check-row' }, keys, h('span', {}, t('With keystrokes', 'Avec frappe'))),
        h('label', { class: 'check-row' }, copied, h('span', {}, t('With file copies', 'Avec copie de fichiers'))), whoList, srvList),
      list, note);
  };

  // --- Journal ---
  const journal = async () => {
    const search = h('input', { id: 'j-search', type: 'search', placeholder: t('Account, server, event…', 'Compte, serveur, événement…') }) as HTMLInputElement;
    const list = h('div');
    const seal = h('div', { class: 'seal' }, t('Checking the log…', 'Vérification du journal…'));
    const load = async () => {
      const { evenements } = await call<{ evenements: any[] }>(`/admin/journal?limite=300${search.value ? `&q=${encodeURIComponent(search.value)}` : ''}`);
      list.replaceChildren(table(['N°', 'Date', t('Who', 'Qui'), t('Event', 'Événement'), t('Detail', 'Détail')], evenements.reverse().map((e) => h('tr', { class: /echec|refuse|differente|revele/.test(e.evenement) ? 'warn' : '' },
        h('td', { class: 'num' }, String(e.seq)), h('td', {}, fmtDate(e.date)), h('td', {}, e.qui), h('td', {}, e.evenement),
        h('td', { class: 'detail' }, Object.entries(e.detail ?? {}).map(([k, v]) => `${k} : ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · '))))));
    };
    call<{ intact: boolean; evenements?: number; probleme?: string }>('/admin/journal/verification').then((v) => {
      seal.className = `seal${v.intact ? '' : ' bad'}`;
      seal.textContent = v.intact ? t(`✓ Log intact: ${v.evenements} chained events, checked just now.`, `✓ Journal intact : ${v.evenements} événements chaînés, vérifiés à l'instant.`) : t(`✗ LOG TAMPERED WITH: ${v.probleme}`, `✗ JOURNAL ALTÉRÉ : ${v.probleme}`);
    }).catch(fail);
    let searchTimer = 0;
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => load().catch(fail), 300); });
    await load();
    const exportCsv = async () => {
      const dest = await save({ defaultPath: `journal-${b.name}-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
      if (!dest) return;
      try { await gates.journalCsv(b.id, search.value, dest); host.toast(t(`Log exported: ${dest}`, `Journal exporté : ${dest}`)); } catch (e) { fail(e); }
    };
    return h('div', { class: 'admin-section' }, h('div', { class: 'admin-bar' }, search, h('button', { class: 'btn', onclick: exportCsv }, t('Export to CSV', 'Exporter en CSV'))), seal, list);
  };

  show(full ? 'direct' : 'sessions');
  return h('div', { class: 'ext-page gate-admin' },
    h('header', {}, h('h2', {}, `Audit · ${b.name}`), h('p', { class: 'muted' }, full
      ? t(`${b.host} · ${b.login} (${b.role === 'admin' ? 'administrator' : 'auditor'}) · session replay and log`, `${b.host} · ${b.login} (${b.role === 'admin' ? 'administrateur' : 'auditeur'}) · relecture des sessions et journal`)
      : t(`${b.host} · your sessions on this Gate`, `${b.host} · vos sessions sur cette Gate`))),
    nav, content);
}
