// Fenêtre « Synchroniser » (Pro) d'une session de fichiers à deux volets : on compare d'abord
// (rien n'est copié), on coche, puis les copies partent dans la file de transferts.
import { api, Comparison, errorText, remoteFiles, SyncDiff, TransferProgress } from './api';
import { h, icon } from './dom';
import { formatDate, formatSize } from './files';
import { t } from './i18n';
import { proChip } from './security';
import type { TransferQueue } from './transfers';

type Sense = 'up' | 'down' | 'both';
/** Ce qu'on fait d'un écart. */
type Action = 'up' | 'down' | 'delete' | 'skip';

export interface SyncTarget {
  connectionId: string;
  localDir: string;
  remoteDir: string;
  queue: TransferQueue;
  /** Fin de la synchronisation : les deux volets se rechargent. */
  done: () => void;
  toast: (msg: string, kind?: 'info' | 'error') => void;
}

interface Row {
  diff: SyncDiff;
  action: Action;
  /** Coché d'office ou par l'utilisateur. */
  on: boolean;
  /** Le sens choisi ne permet que de l'ignorer (ex. absent du serveur en récupération). */
  fixed: boolean;
  why: string;
}

const DEFAULT_EXCLUDE = '.git/  node_modules/  Thumbs.db  desktop.ini';
const windowsName = (name: string) => name.replace(/[<>:"/\\|?*]/g, '_');

/** Action proposée pour un écart, selon le sens choisi. */
function plan(d: SyncDiff, sense: Sense, deleteExtra: boolean): Omit<Row, 'diff'> {
  const up = sense !== 'down';
  const down = sense !== 'up';
  switch (d.status) {
    case 'onlyLocal':
      return up ? { action: 'up', on: true, fixed: false, why: t('Missing on the server', 'Absent du serveur') }
        : { action: 'skip', on: false, fixed: true, why: t('Only on this PC (kept)', 'Seulement sur ce PC (conservé)') };
    case 'onlyRemote':
      if (down) return { action: 'down', on: true, fixed: false, why: t('Missing on this PC', 'Absent de ce PC') };
      return deleteExtra ? { action: 'delete', on: true, fixed: false, why: t('No longer on this PC: deleted on the server', 'N\'existe plus sur ce PC : supprimé du serveur') }
        : { action: 'skip', on: false, fixed: true, why: t('Only on the server (kept)', 'Seulement sur le serveur (conservé)') };
    case 'localNewer':
      return up ? { action: 'up', on: true, fixed: false, why: t('Newer on this PC', 'Plus récent sur ce PC') }
        : { action: 'down', on: false, fixed: false, why: t('Newer on this PC: replacing it is unusual', 'Plus récent sur ce PC : le remplacer est inhabituel') };
    case 'remoteNewer':
      return down ? { action: 'down', on: true, fixed: false, why: t('Newer on the server', 'Plus récent sur le serveur') }
        : { action: 'up', on: false, fixed: false, why: t('Newer on the server: replacing it is unusual', 'Plus récent sur le serveur : le remplacer est inhabituel') };
    case 'different':
      if (sense === 'both') return { action: 'skip', on: false, fixed: false, why: t('Different sizes: choose', 'Tailles différentes : à choisir') };
      return { action: sense, on: true, fixed: false, why: t('Different sizes', 'Tailles différentes') };
    default:
      return { action: 'skip', on: false, fixed: false, why: d.local?.isDir !== d.remote?.isDir ? t('File on one side, folder on the other: choose', 'Fichier d\'un côté, dossier de l\'autre : à choisir') : t('Same date, different content: choose', 'Même date, contenu différent : à choisir') };
  }
}

const ACTION_ICON: Record<Action, string> = { up: 'arrowRight', down: 'arrowLeft', delete: 'trash', skip: 'close' };

export function openSyncDialog(target: SyncTarget) {
  let sense: Sense = 'up';
  let rows: Row[] = [];
  let result: Comparison | null = null;
  let busy = false;
  /** Choix faits à la main pour les écarts à trancher : gardés quand le sens change. */
  const chosen = new Map<string, Action>();

  const localInput = h('input', { type: 'text', class: 'mono', value: target.localDir, spellcheck: 'false', 'aria-label': t('Folder of this PC', 'Dossier de ce PC') }) as HTMLInputElement;
  const remoteInput = h('input', { type: 'text', class: 'mono', value: target.remoteDir, spellcheck: 'false', 'aria-label': t('Server folder', 'Dossier du serveur') }) as HTMLInputElement;
  const bySize = h('select', { 'aria-label': t('Compare by', 'Comparer par') },
    h('option', { value: 'date' }, t('Date and size', 'Date et taille')),
    h('option', { value: 'size' }, t('Size only', 'Taille seulement'))) as HTMLSelectElement;
  const exclude = h('input', { type: 'text', class: 'mono', value: DEFAULT_EXCLUDE, spellcheck: 'false', 'aria-label': t('Exclude', 'Exclure') }) as HTMLInputElement;
  const deleteBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const deleteLabel = h('label', { class: 'check danger-text' }, deleteBox, t('Delete on the server what no longer exists on this PC', 'Supprimer sur le serveur ce qui n\'existe plus sur ce PC'));
  const senseBox = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('Direction', 'Sens') });
  const table = h('div', { class: 'sync-table' });
  const summary = h('span', { class: 'sync-summary grow' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const compareBtn = h('button', { type: 'button', class: 'btn', onclick: () => compare() }, icon('refresh', 14), t('Compare (nothing is copied)', 'Comparer (rien n\'est copié)')) as HTMLButtonElement;
  const runBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => run() }, t('Synchronise', 'Synchroniser')) as HTMLButtonElement;

  const renderSense = () => {
    const opt = (value: Sense, label: string) => h('label', { class: `seg-opt${sense === value ? ' on' : ''}` },
      h('input', { type: 'radio', name: 'sync-sense', value, checked: sense === value, onchange: () => { sense = value; renderSense(); replan(); } }), label);
    senseBox.replaceChildren(opt('up', t('Upload →', 'Envoyer →')), opt('down', t('← Download', '← Récupérer')), opt('both', t('⇄ Both ways', '⇄ Les deux')));
    // On ne supprime que sur le serveur, en envoi : rien n'est effacé sur ce PC.
    deleteLabel.hidden = sense !== 'up';
  };
  deleteBox.addEventListener('change', () => replan());

  /** Le sens ou la suppression changent : les actions proposées suivent, sans nouvelle comparaison. */
  function replan() {
    if (!result) return;
    rows = result.diffs.map((diff) => {
      const row: Row = { diff, ...plan(diff, sense, sense === 'up' && deleteBox.checked) };
      const choice = chosen.get(diff.path);
      if (choice && needsChoice(row)) Object.assign(row, { action: choice, on: choice !== 'skip' });
      return row;
    });
    renderTable();
  }

  async function compare() {
    if (busy) return;
    busy = true;
    compareBtn.disabled = true;
    runBtn.disabled = true;
    error.textContent = '';
    table.replaceChildren(h('p', { class: 'muted' }, t('Comparing both folders…', 'Comparaison des deux dossiers…')));
    summary.textContent = '';
    try {
      chosen.clear();
      result = await api.fsCompare(target.connectionId, localInput.value.trim(), remoteInput.value.trim(), bySize.value === 'size', exclude.value.split(/\s+/));
      replan();
    } catch (e) {
      result = null;
      table.replaceChildren();
      error.textContent = errorText(e);
    } finally {
      busy = false;
      compareBtn.disabled = false;
    }
  }

  const sideText = (s: SyncDiff['local']) => (s ? (s.isDir ? t('folder', 'dossier') : `${formatSize(s.size)} · ${formatDate(s.modified)}`) : '—');

  function renderTable() {
    if (!result) return;
    const todo = rows.filter((r) => r.on && r.action !== 'skip');
    const pending = rows.filter((r) => needsChoice(r) && r.action === 'skip').length;
    const count = (a: Action) => todo.filter((r) => r.action === a).length;
    const bytes = todo.reduce((n, r) => n + ((r.action === 'up' ? r.diff.local?.size : r.action === 'down' ? r.diff.remote?.size : 0) ?? 0), 0);
    const copies = [
      count('up') && t(`${count('up')} to upload`, `${count('up')} à envoyer`),
      count('down') && t(`${count('down')} to download`, `${count('down')} à récupérer`),
    ].filter(Boolean).join(' · ');
    const parts = [
      copies && (bytes ? `${copies} (${formatSize(bytes)})` : copies),
      count('delete') && t(`${count('delete')} to delete`, `${count('delete')} à supprimer`),
      pending && t(`${pending} to decide`, `${pending} à trancher`),
      t(`${result.same} identical`, `${result.same} identique(s)`),
      result.excluded && t(`${result.excluded} excluded`, `${result.excluded} exclu(s)`),
    ].filter(Boolean);
    summary.textContent = parts.join(' · ');
    runBtn.disabled = !todo.length;
    runBtn.textContent = todo.length ? t(`Synchronise (${todo.length})`, `Synchroniser (${todo.length})`) : t('Synchronise', 'Synchroniser');

    if (!rows.length) {
      table.replaceChildren(h('p', { class: 'sync-empty' }, icon('check', 16), t('Both folders are identical.', 'Les deux dossiers sont identiques.')));
      return;
    }
    const head = h('div', { class: 'sync-row head' },
      h('span', {}), h('span', {}, t('Action', 'Action')), h('span', {}, t('File', 'Fichier')), h('span', {}, t('This PC', 'Ce PC')), h('span', {}, t('Server', 'Serveur')), h('span', {}, t('Why', 'Pourquoi')));
    table.replaceChildren(head, ...rows.map((r) => {
      const choose = needsChoice(r);
      const actionCell = choose
        ? h('select', { class: 'sync-choice', 'aria-label': t(`Action for ${r.diff.path}`, `Action pour ${r.diff.path}`), onchange: (e: Event) => { r.action = (e.target as HTMLSelectElement).value as Action; r.on = r.action !== 'skip'; chosen.set(r.diff.path, r.action); renderTable(); } },
          h('option', { value: 'skip', selected: r.action === 'skip' }, t('Skip', 'Ignorer')),
          h('option', { value: 'up', selected: r.action === 'up' }, t('Upload →', 'Envoyer →')),
          h('option', { value: 'down', selected: r.action === 'down' }, t('← Download', '← Récupérer')))
        : h('span', { class: `sync-act ${r.action}`, title: r.action === 'up' ? t('Upload', 'Envoyer') : r.action === 'down' ? t('Download', 'Récupérer') : r.action === 'delete' ? t('Delete on the server', 'Supprimer du serveur') : t('Nothing', 'Rien') }, icon(ACTION_ICON[r.action], 14));
      return h('div', { class: `sync-row${choose ? ' conflict' : ''}${r.on || choose ? '' : ' off'}` },
        h('input', {
          type: 'checkbox', checked: r.on, disabled: r.fixed || choose, 'aria-label': t(`Include ${r.diff.path}`, `Inclure ${r.diff.path}`),
          onchange: (e: Event) => { r.on = (e.target as HTMLInputElement).checked; renderTable(); },
        }),
        actionCell,
        h('span', { class: 'mono ellipsis', title: r.diff.path }, r.diff.path + ((r.diff.local ?? r.diff.remote)?.isDir ? '/' : '')),
        h('span', { class: 'muted small' }, sideText(r.diff.local)),
        h('span', { class: 'muted small' }, sideText(r.diff.remote)),
        h('span', { class: `small${choose ? ' warn-text' : ''}` }, r.why));
    }));
  }

  /** Écart que l'utilisateur doit trancher (envoyer, récupérer ou ignorer). */
  function needsChoice(r: Row) {
    return r.diff.status === 'conflict' || (r.diff.status === 'different' && sense === 'both');
  }

  function run() {
    const todo = rows.filter((r) => r.on && r.action !== 'skip');
    if (!todo.length) return;
    const deletions = todo.filter((r) => r.action === 'delete').length;
    if (deletions && !confirm(t(`Permanently delete ${deletions} item(s) on the server?`, `Supprimer définitivement ${deletions} élément(s) sur le serveur ?`))) return;
    const id = target.connectionId;
    const localRoot = localInput.value.trim().replace(/[\\/]+$/, '');
    const remoteRoot = remoteInput.value.trim().replace(/\/+$/, '') || '/';
    const localPath = (rel: string) => `${localRoot}\\${rel.split('/').map(windowsName).join('\\')}`;
    const remotePath = (rel: string) => `${remoteRoot === '/' ? '' : remoteRoot}/${rel}`;
    const remoteParent = (rel: string) => remotePath(rel).replace(/\/[^/]+$/, '') || '/';
    for (const r of todo) {
      const d = r.diff;
      const isDir = !!(r.action === 'up' ? d.local?.isDir : d.remote?.isDir);
      const job = (direction: 'up' | 'down', run: (cb: (p: TransferProgress) => void) => Promise<unknown>) =>
        target.queue.add({ name: d.path + (isDir ? '/' : ''), direction, target: direction === 'up' ? remoteRoot : localRoot, run });
      if (r.action === 'up') {
        job('up', (cb) => (isDir ? remoteFiles.uploadAny(id, localPath(d.path), remoteParent(d.path), cb) : api.fsUpload(id, localPath(d.path), remotePath(d.path), cb)));
      } else if (r.action === 'down') {
        job('down', (cb) => (isDir ? remoteFiles.downloadDir(id, remotePath(d.path), localPath(d.path), cb) : api.fsDownload(id, remotePath(d.path), localPath(d.path), cb, d.remote?.modified)));
      } else {
        job('up', async (cb) => { await api.fsRemove(id, remotePath(d.path), isDir); cb({ done: 1, total: 1 }); });
      }
    }
    target.queue.whenIdle(target.done);
    target.toast(t(`${todo.length} operation(s) added to the transfer queue`, `${todo.length} opération(s) ajoutée(s) à la file de transferts`));
    dialog.close();
  }

  const dialog = h('dialog', { class: 'dialog sync-dialog', 'aria-label': t('Synchronise', 'Synchroniser') },
    h('form', { method: 'dialog', onsubmit: (e: Event) => e.preventDefault() },
      h('header', { class: 'dlg-head' },
        h('h2', {}, t('Compare and synchronise', 'Comparer et synchroniser'), ' ', proChip('fileSync')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close', 'Fermer'), onclick: () => dialog.close() }, icon('close', 16))),
      h('div', { class: 'dlg-body' },
        h('div', { class: 'sync-dirs' },
          h('label', { class: 'fld' }, t('This PC', 'Ce PC'), localInput),
          h('span', { class: 'sync-arrow', 'aria-hidden': 'true' }, icon('arrowRight', 18)),
          h('label', { class: 'fld' }, t('Server', 'Serveur'), remoteInput)),
        h('div', { class: 'sync-opts' },
          h('div', { class: 'fld' }, t('Direction', 'Sens'), senseBox),
          h('label', { class: 'fld' }, t('Compare by', 'Comparer par'), bySize),
          h('label', { class: 'fld grow' }, t('Exclude (spaces between patterns; « folder/ », « *.log »)', 'Exclure (motifs séparés par des espaces ; « dossier/ », « *.log »)'), exclude),
          deleteLabel),
        error,
        table),
      h('footer', { class: 'dlg-foot' },
        summary,
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, t('Cancel', 'Annuler')),
        compareBtn,
        runBtn)));
  dialog.addEventListener('close', () => dialog.remove());
  renderSense();
  document.body.append(dialog);
  dialog.showModal();
  compare();
}
