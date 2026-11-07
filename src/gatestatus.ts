// État d'une Gate (Gate 0.39 et suivantes) : santé, matériel, services, stockage, activité,
// intégrité du journal et mise à jour (en un clic ou programmée : Portunia Pro).
import { errorText, Gate, gates } from './api';
import { h, icon } from './dom';
import { LOCALE, t } from './i18n';

export interface StatusHost {
  toast(message: string, kind?: 'info' | 'error'): void;
  /** Mise à jour depuis Portunia (Pro). */
  allowsUpdate(): boolean;
  /** Réglages de la Gate depuis Portunia (Équipes) : conservation modifiable ici. */
  allowsSettings(): boolean;
  /** Niveau de santé lu (pastille de la barre latérale). */
  onLevel?(gate: string, level: string): void;
}

const REFRESH_MS = 10_000;
const RUNNING_MS = 3_000;

const LEVEL_TEXT: Record<string, string> = {
  ok: t('healthy', 'en bonne santé'),
  alerte: t('needs attention', 'à surveiller'),
  erreur: t('problem', 'problème'),
};
const STEP_TEXT: Record<string, string> = {
  telechargement: t('Download and check', 'Téléchargement et vérification'),
  sauvegarde: t('Database backup', 'Sauvegarde de la base'),
  installation: t('Installation', 'Installation'),
  demarrage: t('Start of the new version', 'Démarrage de la nouvelle version'),
  retour: t('Rollback', 'Retour en arrière'),
  fini: t('Finished', 'Terminé'),
};

function bytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = [t('B', 'o'), t('KB', 'Ko'), t('MB', 'Mo'), t('GB', 'Go'), t('TB', 'To')];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toLocaleString(LOCALE, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

function span(secs: number | null | undefined): string {
  if (secs == null) return '—';
  const d = Math.floor(secs / 86400);
  const hh = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? t(`${d} d ${hh} h`, `${d} j ${hh} h`) : hh ? `${hh} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v)} %`;
}

function levelOf(p: number | null | undefined, warn = 85, error = 95): string {
  return p == null ? '' : p >= error ? 'erreur' : p >= warn ? 'alerte' : 'ok';
}

/** Courbe des dernières 24 heures (un point toutes les 5 minutes). */
function spark(values: number[]): HTMLElement | null {
  if (values.length < 2) return null;
  const w = 120;
  const hgt = 26;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(hgt - (Math.min(100, Math.max(0, v)) / 100) * hgt).toFixed(1)}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'gs-spark');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts);
  svg.append(line);
  return svg as unknown as HTMLElement;
}

function tile(label: string, value: string, sub: string, level = '', bar?: number | null, history?: number[]) {
  return h('div', { class: `gs-tile ${level}` },
    h('span', { class: 'gs-label' }, label),
    h('span', { class: 'gs-big' }, value),
    bar != null ? h('span', { class: 'gs-bar' }, h('i', { style: `width:${Math.min(100, Math.max(0, bar)).toFixed(0)}%` })) : null,
    history ? spark(history) : null,
    h('span', { class: 'gs-sub muted small' }, sub));
}

function row(label: string | HTMLElement, value: string | HTMLElement, level = '') {
  return h('div', { class: 'gs-row' }, h('span', {}, level ? h('span', { class: `gs-dot ${level}` }) : null, label), h('span', { class: 'gs-val' }, value));
}

/** Éléments présents seulement (les absents valent null). */
const nn = (...xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => !!x);

function card(title: string, ...children: (HTMLElement | null)[]) {
  return h('section', { class: 'gs-card' }, h('h3', {}, title), ...children);
}

/** Page « État » d'une Gate : se rafraîchit toute seule tant qu'elle est affichée. */
export function renderGateStatus(b: Gate, host: StatusHost): HTMLElement {
  const root = h('div', { class: 'gs' }, h('p', { class: 'muted' }, t('Loading…', 'Chargement…')));
  const call = <T = any>(method: string, path: string, body?: unknown) => gates.admin<T>(b.id, method, path, body);
  let timer = 0;
  let confirmOpen = false;
  let lastOk = 0;
  let data: any = null;

  const schedule = (ms: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { if (root.isConnected) load(); }, ms);
  };

  const load = async (verify = false) => {
    try {
      data = await call('GET', `/admin/etat${verify ? '?verifier=true' : ''}`);
      lastOk = Date.now();
      host.onLevel?.(b.id, data.niveau);
      if (!confirmOpen) render();
    } catch (e) {
      const text = errorText(e);
      // Pendant une mise à jour, la Gate redémarre : on continue d'attendre.
      if (data?.mise_a_jour?.execution?.resultat === 'en_cours' || data?.mise_a_jour?.programmee) {
        if (!confirmOpen) render(t('The Gate is restarting…', 'La Gate redémarre…'));
      } else if (!data) {
        root.replaceChildren(h('p', { class: 'form-error' }, text === 'SESSION_EXPIREE' ? t('Gate session expired: sign in again (sidebar).', 'Session de la Gate expirée : reconnectez-vous (barre latérale).') : text));
      } else if (!confirmOpen) {
        render(text);
      }
    }
    const running = data?.mise_a_jour?.execution?.resultat === 'en_cours';
    schedule(running ? RUNNING_MS : REFRESH_MS);
  };

  const render = (problem?: string) => {
    const d = data;
    const up = d.mise_a_jour ?? {};
    const hist: any[] = d.historique ?? [];
    const st = d.stockage ?? {};
    const rec = st.enregistrements ?? {};
    const act = d.activite ?? {};
    const age = Math.round((Date.now() - lastOk) / 1000);

    const head = h('div', { class: 'gs-head' },
      h('div', {},
        h('div', { class: 'gs-title' }, h('span', { class: `gs-dot big ${d.niveau}` }), `${d.nom} — ${LEVEL_TEXT[d.niveau] ?? d.niveau}`),
        h('div', { class: 'muted small' }, [d.hote, d.systeme, d.mode === 'paquet' ? t('Debian package', 'paquet Debian') : d.mode === 'docker' ? 'Docker' : null, `Portunia Gate ${d.version}`, t(`updated ${age} s ago`, `actualisé il y a ${age} s`)].filter(Boolean).join(' · '))),
      h('button', { type: 'button', class: 'btn', onclick: () => load(true) }, icon('refresh', 14), t('Refresh', 'Actualiser')));

    const alerts = (d.alertes ?? []).length || problem
      ? h('div', { class: `gs-alerts ${d.niveau === 'erreur' ? 'erreur' : 'alerte'}` },
        ...(problem ? [h('div', {}, problem)] : []),
        ...(d.alertes ?? []).map((a: string) => h('div', {}, a)))
      : null;

    const tiles = h('div', { class: 'gs-tiles' },
      tile(t('Gate running for', 'Gate en service depuis'), d.demarree_le ? span((Date.now() - Date.parse(d.demarree_le)) / 1000) : '—', t(`server up for ${span(d.machine_depuis_s)}`, `serveur allumé depuis ${span(d.machine_depuis_s)}`)),
      tile(t(`Processor · ${d.cpu?.coeurs ?? '?'} cores`, `Processeur · ${d.cpu?.coeurs ?? '?'} cœurs`), pct(d.cpu?.pourcent), d.cpu?.charge ? t(`load ${d.cpu.charge.map((x: number) => x.toFixed(2)).join(' ')}`, `charge ${d.cpu.charge.map((x: number) => x.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 })).join(' ')}`) : '', levelOf(d.cpu?.pourcent, 85, 98), d.cpu?.pourcent, hist.map((p) => p.cpu)),
      tile(t(`Memory · ${bytes(d.memoire?.total)}`, `Mémoire · ${bytes(d.memoire?.total)}`), d.memoire ? pct((100 * d.memoire.utilisee) / d.memoire.total) : '—', d.memoire ? t(`${bytes(d.memoire.utilisee)} used`, `${bytes(d.memoire.utilisee)} utilisés`) : '', levelOf(d.memoire ? (100 * d.memoire.utilisee) / d.memoire.total : null, 90, 97), d.memoire ? (100 * d.memoire.utilisee) / d.memoire.total : null, hist.map((p) => p.mem)),
      tile(t(`Disk · ${bytes(d.disque?.total)}`, `Disque · ${bytes(d.disque?.total)}`), pct(d.disque?.pourcent), d.disque ? t(`${bytes(d.disque.libre)} free`, `${bytes(d.disque.libre)} libres`) : '', levelOf(d.disque?.pourcent), d.disque?.pourcent, hist.map((p) => p.disque)));

    const services = card(t('Services', 'Services'),
      ...(d.services ?? []).map((s: any) => row(s.nom, s.detail, s.etat === 'info' ? 'info' : s.etat)));

    const fullIn = st.plein_dans_jours;
    const storage = card(t('Storage', 'Stockage'),
      row(t('Recordings', 'Enregistrements'), t(`${bytes(rec.octets)} · ${rec.fichiers ?? 0} files`, `${bytes(rec.octets)} · ${rec.fichiers ?? 0} fichiers`)),
      row(t('Database', 'Base de données'), bytes(st.base_octets)),
      row(t('Oldest recording', 'Plus ancien enregistrement'), rec.plus_ancien ? new Date(rec.plus_ancien).toLocaleDateString(LOCALE) : '—'),
      row(t('Rate', 'Rythme'), st.par_jour != null ? t(`+${bytes(st.par_jour)} per day`, `+${bytes(st.par_jour)} par jour`) : '—'),
      fullIn != null ? row(t('Disk full in', 'Disque plein dans'), t(`about ${fullIn} days`, `environ ${fullIn} jours`), fullIn < 14 ? 'alerte' : '') : null,
      keepRow(KEEP_RECORDINGS, st.conservation_jours ?? 0));

    const journal = d.journal;
    const activity = card(t('Activity and integrity', 'Activité et intégrité'),
      row(t('Open sessions', 'Sessions ouvertes'), String(act.sessions_ouvertes ?? 0)),
      row(t('Sessions today', 'Sessions aujourd\'hui'), String(act.sessions_jour ?? 0)),
      row(t('Refused sign-ins (24 h)', 'Connexions refusées (24 h)'), String(act.refus_24h ?? 0), act.refus_24h > 20 ? 'alerte' : ''),
      row(t('Approvals waiting', 'Approbations en attente'), String(act.approbations_attente ?? 0)),
      journal
        ? row(t('Signed audit log', 'Journal signé'), journal.ok ? t(`intact · checked ${when(journal.verifie_le)}`, `intact · vérifié le ${when(journal.verifie_le)}`) : t(`TAMPERED: ${journal.erreur ?? ''}`, `ALTÉRÉ : ${journal.erreur ?? ''}`), journal.ok ? 'ok' : 'erreur')
        : row(t('Signed audit log', 'Journal signé'), t('checked a few minutes after start', 'vérifié quelques minutes après le démarrage')),
      d.journal_jours !== undefined ? keepRow(KEEP_JOURNAL, d.journal_jours ?? 0) : null,
      d.journal_purge ? row(t('Last purge', 'Dernière purge'), t(`${d.journal_purge.supprimes} events · ${when(d.journal_purge.date)} · chain from #${d.journal_purge.depuis}`, `${d.journal_purge.supprimes} événements · ${when(d.journal_purge.date)} · chaîne depuis le n° ${d.journal_purge.depuis}`)) : null,
      d.reseau ? row(t('Network', 'Réseau'), `↓ ${bytes(d.reseau.recu_s)}/s ↑ ${bytes(d.reseau.envoye_s)}/s`) : null);

    root.replaceChildren(...nn(head, alerts, updateCard(up), tiles, h('div', { class: 'gs-grid' }, services, storage, activity)));
  };

  // --- Conservation des enregistrements et du journal ---
  type Keep = { key: 'conservation_jours' | 'journal_jours'; label: string; cli: string; choices: number[]; ask: (v: number) => string; done: (v: number) => string };
  const KEEP_RECORDINGS: Keep = {
    key: 'conservation_jours', label: t('Keep recordings', 'Garder les enregistrements'), cli: 'recording_days', choices: [0, 30, 90, 180, 365, 730, 1825],
    ask: (v) => t(`Delete the recordings of sessions ended more than ${v} days ago, now and then every hour? The sessions stay in the list.`, `Supprimer les enregistrements des sessions terminées depuis plus de ${v} jours, maintenant puis chaque heure ? Les sessions restent dans la liste.`),
    done: (v) => v ? t(`Recordings kept ${v} days`, `Enregistrements gardés ${v} jours`) : t('Recordings kept forever', 'Enregistrements gardés toujours'),
  };
  const KEEP_JOURNAL: Keep = {
    key: 'journal_jours', label: t('Keep the audit log', 'Garder le journal'), cli: 'audit_days', choices: [0, 90, 180, 365, 730, 1825, 3650],
    ask: (v) => t(`Delete the audit log events older than ${v} days, now and then every day? The chain is checked first; a signed anchor keeps it verifiable.`, `Supprimer les événements du journal de plus de ${v} jours, maintenant puis chaque jour ? La chaîne est vérifiée avant ; une ancre signée la garde vérifiable.`),
    done: (v) => v ? t(`Audit log kept ${v} days`, `Journal gardé ${v} jours`) : t('Audit log kept forever', 'Journal gardé toujours'),
  };
  const daysText = (v: number) => v === 0 ? t('forever', 'toujours') : v % 365 === 0 ? t(`${v / 365} year${v > 365 ? 's' : ''}`, `${v / 365} an${v > 365 ? 's' : ''}`) : t(`${v} days`, `${v} jours`);
  const keepRow = (k: Keep, days: number) => {
    if (!host.allowsSettings()) {
      return row(k.label, h('span', { title: t(`On the server: sudo portunia-gate setting ${k.cli} DAYS`, `Sur le serveur : sudo portunia-gate setting ${k.cli} JOURS`) }, daysText(days)));
    }
    const choices = k.choices.includes(days) ? k.choices : [...k.choices, days];
    const sel = h('select', { class: 'input sm', 'aria-label': k.label }, ...choices.map((v) => h('option', { value: String(v), selected: v === days }, daysText(v)))) as HTMLSelectElement;
    sel.addEventListener('focus', () => { confirmOpen = true; });
    sel.addEventListener('blur', () => { confirmOpen = false; });
    sel.addEventListener('change', async () => {
      const v = Number(sel.value);
      if (v > 0 && !confirm(k.ask(v))) {
        sel.value = String(days);
        return;
      }
      try {
        await call('PUT', '/admin/reglages', { [k.key]: v });
        host.toast(k.done(v));
        confirmOpen = false;
        schedule(1500);
      } catch (e) { host.toast(errorText(e), 'error'); sel.value = String(days); }
    });
    return row(k.label, sel);
  };

  // --- Mise à jour ---
  const updateCard = (up: any): HTMLElement | null => {
    const run = up.execution;
    const recent = run && run.fin && Date.now() - Date.parse(run.fin) < 7 * 86400_000;
    const box = h('section', { class: 'gs-update' });
    if (run && run.resultat === 'en_cours') {
      const steps = ['telechargement', 'sauvegarde', 'installation', 'demarrage'];
      const at = Math.max(0, steps.indexOf(run.etape));
      box.classList.add('running');
      box.append(
        h('div', { class: 'gs-up-title' }, t(`Updating ${run.de} → ${run.vers}…`, `Mise à jour ${run.de} → ${run.vers} en cours…`)),
        h('div', { class: 'gs-steps' }, ...[...steps, ...(run.etape === 'retour' ? ['retour'] : [])].map((s, i) => h('span', { class: `gs-step${s === run.etape ? ' on' : i < at ? ' done' : ''}` }, STEP_TEXT[s]))),
        h('pre', { class: 'gs-log' }, (run.journal ?? []).slice(-6).join('\n')));
      return box;
    }
    if (up.programmee) {
      const p = up.programmee;
      box.append(h('div', { class: 'gs-up-row' },
        h('div', {}, h('div', { class: 'gs-up-title' }, t(`Update to ${p.version} scheduled for ${when(p.a)}`, `Mise à jour en ${p.version} programmée le ${when(p.a)}`)),
          h('div', { class: 'small' }, p.prevenir ? t(`Users warned ${up.preavis_min} minutes before · asked by ${p.par}`, `Utilisateurs prévenus ${up.preavis_min} minutes avant · demandée par ${p.par}`) : t(`Asked by ${p.par}`, `Demandée par ${p.par}`))),
        h('button', { type: 'button', class: 'btn', onclick: async () => {
          try { await call('DELETE', '/admin/mise-a-jour'); host.toast(t('Scheduled update cancelled', 'Mise à jour programmée annulée')); load(); } catch (e) { host.toast(errorText(e), 'error'); }
        } }, t('Cancel', 'Annuler'))));
      return box;
    }
    const last = recent ? h('div', { class: `small gs-last ${run.resultat}` },
      run.resultat === 'reussie' ? t(`Last update: ${run.de} → ${run.vers}, ${when(run.fin)}.`, `Dernière mise à jour : ${run.de} → ${run.vers}, le ${when(run.fin)}.`)
        : run.resultat === 'retour_arriere' ? t(`Update to ${run.vers} rolled back on ${when(run.fin)}: ${run.message}`, `Mise à jour en ${run.vers} annulée le ${when(run.fin)} (retour en arrière) : ${run.message}`)
          : t(`Update to ${run.vers} failed on ${when(run.fin)}: ${run.message}`, `Échec de la mise à jour en ${run.vers} le ${when(run.fin)} : ${run.message}`)) : null;
    if (!up.disponible) {
      if (!last && !up.erreur_verification) return null;
      box.classList.add('quiet');
      box.append(h('div', { class: 'small' }, up.derniere ? t(`Up to date (${up.actuelle}).`, `À jour (${up.actuelle}).`) : t(`Latest version unknown: ${up.erreur_verification ?? ''}`, `Dernière version inconnue : ${up.erreur_verification ?? ''}`)), ...nn(last));
      return box;
    }
    const title = h('div', {}, h('div', { class: 'gs-up-title' }, t(`Update available: ${up.actuelle} → ${up.derniere}`, `Mise à jour disponible : ${up.actuelle} → ${up.derniere}`)),
      h('div', { class: 'small' }, t('Database backup first; automatic rollback if the new version does not start.', 'Sauvegarde de la base avant ; retour en arrière automatique si la nouvelle version ne démarre pas.')));
    if (up.impossible) {
      box.append(h('div', { class: 'gs-up-row' }, title), h('div', { class: 'small' }, up.impossible), h('code', { class: 'gs-cmd' }, up.commande), ...nn(last));
      return box;
    }
    if (!host.allowsUpdate()) {
      box.append(h('div', { class: 'gs-up-row' }, title, h('span', { class: 'chip' }, 'Pro')),
        h('div', { class: 'small' }, t('One-click and scheduled updates are part of Portunia Pro (Settings › Licence). On the server:', 'La mise à jour en un clic et programmée fait partie de Portunia Pro (Paramètres › Licence). Sur le serveur :')),
        h('code', { class: 'gs-cmd' }, up.commande), ...nn(last));
      return box;
    }
    const confirmBox = h('div', { class: 'gs-confirm', hidden: true });
    const open = h('button', { type: 'button', class: 'btn primary', onclick: () => { confirmOpen = true; confirmBox.hidden = false; open.hidden = true; } }, t('Update…', 'Mettre à jour…'));
    const notice = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const tonight = new Date();
    tonight.setHours(3, 0, 0, 0);
    if (tonight.getTime() < Date.now()) tonight.setDate(tonight.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    const atInput = h('input', { type: 'datetime-local', class: 'input sm', value: `${tonight.getFullYear()}-${pad(tonight.getMonth() + 1)}-${pad(tonight.getDate())}T03:00` }) as HTMLInputElement;
    const send = async (at?: Date) => {
      try {
        await call('POST', '/admin/mise-a-jour', { version: up.derniere, a: at ? at.toISOString() : null, prevenir: notice.checked });
        host.toast(at ? t(`Update scheduled for ${when(at.toISOString())}`, `Mise à jour programmée le ${when(at.toISOString())}`) : notice.checked ? t('Users are warned: the update starts in 5 minutes', 'Utilisateurs prévenus : la mise à jour part dans 5 minutes') : t('Update started: the Gate restarts within a few minutes', 'Mise à jour lancée : la Gate redémarre dans quelques minutes'));
        confirmOpen = false;
        load();
      } catch (e) { host.toast(errorText(e), 'error'); }
    };
    const open_ = Number(up.sessions_ouvertes ?? d0().activite?.sessions_ouvertes ?? 0);
    confirmBox.append(
      h('div', { class: 'small' }, open_ ? t(`${open_} open session(s) will be cut during the restart (about a minute). A database backup is made first.`, `${open_} session(s) ouverte(s) seront coupées pendant le redémarrage (environ une minute). Une sauvegarde de la base est faite avant.`) : t('No session is open. A database backup is made first.', 'Aucune session ouverte. Une sauvegarde de la base est faite avant.')),
      h('label', { class: 'check-row' }, notice, h('span', {}, t('Warn the connected users 5 minutes before', 'Prévenir les utilisateurs connectés 5 minutes avant'))),
      h('div', { class: 'gs-actions' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => send() }, t('Update now', 'Mettre à jour maintenant')),
        h('span', { class: 'gs-at' }, atInput, h('button', { type: 'button', class: 'btn', onclick: () => {
          const at = new Date(atInput.value);
          if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) return host.toast(t('Choose a date to come', 'Choisissez une date à venir'), 'error');
          send(at);
        } }, t('Schedule', 'Programmer'))),
        h('button', { type: 'button', class: 'btn', onclick: () => { confirmOpen = false; render(); } }, t('Cancel', 'Annuler'))));
    box.append(h('div', { class: 'gs-up-row' }, title, open), confirmBox, ...nn(last));
    return box;
  };
  const d0 = () => data ?? {};

  load(true);
  return root;
}

/** Niveau de santé seul (pastille de la barre latérale) ; null si la Gate ne le donne pas. */
export async function gateLevel(b: Gate): Promise<string | null> {
  try {
    const r = await gates.admin<any>(b.id, 'GET', '/admin/etat?court=true');
    return r?.niveau ?? null;
  } catch {
    return null;
  }
}
