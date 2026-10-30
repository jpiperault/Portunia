// Onglet « Commande multiple » (Pro) : une commande lancée sur plusieurs serveurs SSH,
// résultats côte à côte (réussi / échoué, code de sortie, sortie de chacun).
import { errorText, multiExec, MultiEvent, net, Session, Snippet } from './api';
import { h, icon } from './dom';
import { t } from './i18n';

interface Row {
  session: Session;
  state: 'waiting' | 'ok' | 'error' | 'failed';
  status?: number | null;
  ms?: number;
  output?: string;
  open?: boolean;
}

export interface MultiExecView {
  el: HTMLElement;
  /** Coche les sessions SSH d'un dossier (et de ses sous-dossiers) ou une liste de sessions. */
  select(folder: string | null, ids?: string[]): void;
  dispose(): void;
}

const inFolder = (s: Session, folder: string) => s.folder === folder || s.folder.startsWith(`${folder}/`);

export function createMultiExec(
  sessions: () => Session[],
  snippets: () => Snippet[],
  /** Dossier « sensible » (couleur rouge) : une confirmation supplémentaire est demandée. */
  sensitive: (s: Session) => boolean,
  toast: (m: string, k?: 'info' | 'error') => void,
): MultiExecView {
  const selected = new Set<string>();
  let rows: Row[] = [];
  let job: string | null = null;
  let filter: 'all' | 'ok' | 'bad' = 'all';

  const search = h('input', { type: 'search', placeholder: t('Filter servers…', 'Filtrer les serveurs…'), 'aria-label': t('Filter servers', 'Filtrer les serveurs') });
  const picker = h('div', { class: 'mx-picker' });
  const count = h('span', { class: 'muted small' });
  const command = h('textarea', { class: 'mx-command', rows: 3, spellcheck: 'false', placeholder: 'uptime && df -h /', 'aria-label': t('Command', 'Commande') });
  const timeout = h('select', { 'aria-label': t('Timeout', 'Délai maximal') },
    ...[[30, '30 s'], [60, '1 min'], [300, '5 min'], [1800, '30 min']].map(([v, l]) => h('option', { value: String(v), selected: v === 60 }, String(l))));
  const snippetSelect = h('select', { 'aria-label': t('Saved command', 'Commande enregistrée') });
  const runBtn = h('button', { type: 'button', class: 'btn primary' });
  const results = h('div', { class: 'mx-results' });
  const summary = h('div', { class: 'mx-summary' });

  const ssh = () => sessions().filter((s) => s.protocol === 'ssh');

  const renderPicker = () => {
    const q = search.value.trim().toLowerCase();
    const list = ssh().filter((s) => !q || `${s.name} ${s.folder} ${s.values.host ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => `${a.folder}/${a.name}`.localeCompare(`${b.folder}/${b.name}`, 'fr'));
    const groups = new Map<string, Session[]>();
    for (const s of list) groups.set(s.folder, [...(groups.get(s.folder) ?? []), s]);
    picker.replaceChildren(...(list.length ? [...groups].flatMap(([folder, items]) => {
      const all = items.every((s) => selected.has(s.id));
      return [
        h('label', { class: 'mx-folder' },
          h('input', { type: 'checkbox', checked: all, onchange: () => { for (const s of items) all ? selected.delete(s.id) : selected.add(s.id); renderPicker(); } }),
          icon('folder', 14), folder || t('No folder', 'Sans dossier'), h('span', { class: 'muted small' }, String(items.length))),
        ...items.map((s) => h('label', { class: 'mx-item' },
          h('input', { type: 'checkbox', checked: selected.has(s.id), onchange: (e: Event) => { (e.target as HTMLInputElement).checked ? selected.add(s.id) : selected.delete(s.id); renderPicker(); } }),
          h('span', { class: 'grow ellipsis' }, s.name),
          h('span', { class: 'muted small ellipsis' }, String(s.values.host ?? '')))),
      ];
    }) : [h('p', { class: 'muted', style: 'margin: 8px' }, ssh().length ? t('No matching server.', 'Aucun serveur ne correspond.') : t('No saved SSH session.', 'Aucune session SSH enregistrée.'))]));
    count.textContent = t(`${selected.size} server${selected.size > 1 ? 's' : ''} selected`, `${selected.size} serveur${selected.size > 1 ? 's' : ''} sélectionné${selected.size > 1 ? 's' : ''}`);
  };

  const renderSnippets = () => {
    snippetSelect.replaceChildren(h('option', { value: '' }, t('Saved commands…', 'Commandes enregistrées…')),
      ...snippets().map((s) => h('option', { value: s.id }, s.name)));
  };
  snippetSelect.addEventListener('focus', renderSnippets);
  snippetSelect.addEventListener('change', () => {
    const s = snippets().find((x) => x.id === snippetSelect.value);
    if (s) command.value = s.command;
    snippetSelect.value = '';
    command.focus();
  });

  const setRunning = (on: boolean) => {
    runBtn.replaceChildren(icon(on ? 'pause' : 'play', 14), on ? t('Stop', 'Arrêter') : t('Run', 'Lancer'));
    runBtn.classList.toggle('warn', on);
  };

  const renderResults = () => {
    const shown = rows.filter((r) => filter === 'all' || (filter === 'ok' ? r.state === 'ok' : r.state === 'error' || r.state === 'failed'));
    results.replaceChildren(...shown.map((r) => {
      const head = h('button', {
        type: 'button', class: 'mx-row-head', 'aria-expanded': String(!!r.open),
        onclick: () => { r.open = !r.open; renderResults(); },
      },
        h('span', { class: `net-dot ${r.state === 'ok' ? 'up' : r.state === 'waiting' ? 'off' : 'down'}` }),
        h('strong', { class: 'grow ellipsis' }, r.session.name),
        h('span', { class: 'muted small' }, r.state === 'waiting' ? 'en cours…'
          : r.state === 'failed' ? t('cannot connect', 'connexion impossible')
          : r.status === null ? t('no exit code', 'sans code de sortie') : `code ${r.status}`),
        r.ms !== undefined && h('span', { class: 'muted small' }, `${(r.ms / 1000).toFixed(1).replace('.', ',')} s`),
        icon(r.open ? 'up' : 'more', 14));
      return h('div', { class: `mx-row ${r.state}` }, head,
        r.open && h('pre', { class: 'mx-output' }, r.output?.trim() || t('(no output)', '(aucune sortie)')));
    }));
    const done = rows.filter((r) => r.state !== 'waiting');
    const ok = rows.filter((r) => r.state === 'ok').length;
    summary.replaceChildren(...(rows.length ? [
      h('span', { class: 'grow' }, t(`${done.length} / ${rows.length} done · `, `${done.length} / ${rows.length} terminés · `), h('span', { class: 'lvl-ok' }, t(`${ok} succeeded`, `${ok} réussis`)), ' · ', h('span', { class: done.length - ok ? 'lvl-crit' : '' }, t(`${done.length - ok} failed`, `${done.length - ok} en échec`))),
      ...(['all', 'ok', 'bad'] as const).map((f) => h('button', { type: 'button', class: `btn sm${filter === f ? ' on' : ''}`, onclick: () => { filter = f; renderResults(); } },
        f === 'all' ? t('All', 'Tous') : f === 'ok' ? t('Succeeded', 'Réussis') : t('Failures', 'Échecs'))),
      h('button', {
        type: 'button', class: 'btn sm', title: t('Copy all outputs', 'Copier toutes les sorties'),
        onclick: () => navigator.clipboard.writeText(rows.map((r) => t(`### ${r.session.name} (${r.state === 'ok' ? 'succeeded' : r.state === 'waiting' ? 'running' : 'failed'})\n${r.output ?? ''}`, `### ${r.session.name} (${r.state === 'ok' ? 'réussi' : r.state === 'waiting' ? t('ongoing', 'en cours') : 'échec'})\n${r.output ?? ''}`)).join('\n\n')).then(() => toast(t('Results copied', 'Résultats copiés'))),
      }, icon('copy', 14), t('Copy', 'Copier')),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { for (const r of rows) r.open = true; renderResults(); } }, t('Expand all', 'Tout déplier')),
    ] : [h('span', { class: 'muted' }, t('Choose servers, type a command, then « Run » (Ctrl+Enter).', 'Choisissez des serveurs, tapez une commande, puis « Lancer » (Ctrl+Entrée).'))]));
  };

  const onEvent = (e: MultiEvent) => {
    if (e.type === 'done') {
      job = null;
      setRunning(false);
      toast(t(`Command finished: ${e.ok} succeeded, ${e.failed} failed`, `Commande terminée : ${e.ok} réussie${e.ok > 1 ? 's' : ''}, ${e.failed} en échec`), e.failed ? 'error' : 'info');
      return;
    }
    const row = rows.find((r) => r.session.id === e.sessionId);
    if (!row) return;
    row.ms = e.ms;
    if (e.type === 'failed') { row.state = 'failed'; row.output = e.error; row.open = true; }
    else {
      row.state = e.status === 0 ? 'ok' : 'error';
      row.status = e.status;
      row.output = [e.stdout, e.stderr && `--- erreurs ---\n${e.stderr}`].filter(Boolean).join('\n');
      if (row.state === 'error') row.open = true;
    }
    renderResults();
  };

  const run = async () => {
    if (job) { net.cancel(job).catch(() => {}); return; }
    const cmd = command.value.trim();
    const chosen = ssh().filter((s) => selected.has(s.id));
    if (!chosen.length) return toast(t('Check at least one server', 'Cochez au moins un serveur'), 'error');
    if (!cmd) { command.focus(); return; }
    const risky = chosen.filter(sensitive);
    const message = t(`Run on ${chosen.length} server${chosen.length > 1 ? 's' : ''}:\n\n${cmd}`, `Lancer sur ${chosen.length} serveur${chosen.length > 1 ? 's' : ''} :\n\n${cmd}`)
      + (risky.length ? t(`\n\nWarning: ${risky.length} server${risky.length > 1 ? 's are' : ' is'} in a folder marked red (${risky.slice(0, 5).map((s) => s.name).join(', ')}${risky.length > 5 ? '…' : ''}).`, `\n\nAttention : ${risky.length} serveur${risky.length > 1 ? 's sont' : ' est'} dans un dossier marqué en rouge (${risky.slice(0, 5).map((s) => s.name).join(', ')}${risky.length > 5 ? '…' : ''}).`) : '');
    if (!confirm(message)) return;
    rows = chosen.map((session) => ({ session, state: 'waiting' }));
    filter = 'all';
    renderResults();
    setRunning(true);
    try {
      job = await multiExec(chosen.map((s) => s.id), cmd, Number(timeout.value), onEvent);
    } catch (e) {
      setRunning(false);
      rows = [];
      renderResults();
      toast(errorText(e), 'error');
    }
  };
  runBtn.addEventListener('click', run);
  command.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); run(); } });
  search.addEventListener('input', renderPicker);

  const el = h('div', { class: 'mx' },
    h('aside', { class: 'mx-side' },
      h('div', { class: 'mx-side-head' }, search,
        h('div', { class: 'mx-side-actions' }, count,
          h('button', { type: 'button', class: 'btn sm', onclick: () => { for (const s of ssh()) selected.add(s.id); renderPicker(); } }, t('All', 'Tous')),
          h('button', { type: 'button', class: 'btn sm', onclick: () => { selected.clear(); renderPicker(); } }, t('None', 'Aucun')))),
      picker),
    h('section', { class: 'mx-main' },
      h('h2', { style: 'margin: 0; font-size: 18px' }, t('Command on several servers', 'Commande sur plusieurs serveurs')),
      command,
      h('div', { class: 'mx-actions' }, snippetSelect, h('label', { class: 'fld inline' }, t('Timeout', 'Délai maximal'), timeout), h('span', { class: 'grow' }), runBtn),
      summary, results));

  setRunning(false);
  renderPicker();
  renderSnippets();
  renderResults();

  return {
    el,
    select(folder, ids) {
      if (folder !== null) for (const s of ssh().filter((x) => inFolder(x, folder))) selected.add(s.id);
      for (const id of ids ?? []) selected.add(id);
      renderPicker();
      command.focus();
    },
    dispose() { if (job) net.cancel(job).catch(() => {}); },
  };
}
