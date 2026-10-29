// Enregistrements de sessions : liste, lecteur intégré, horodatage des fichiers.
import { open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { errorText, recordings } from './api';
import { h, icon } from './dom';
import { formatSize } from './files';
import { settings, updateSettings } from './settings';
import { proChip } from './security';

type Toast = (message: string, kind?: 'info' | 'error') => void;

const dirSetting = () => settings().recordingDir || null;

/** Horodatage local pour le nom du fichier : 2026-10-24_14-03-12. */
export function stamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

// ---------- Réglages ----------

export function recordingSettings(toast: Toast): HTMLElement {
  const s = settings();
  const dir = h('input', { type: 'text', class: 'imp-path', value: s.recordingDir, spellcheck: 'false', placeholder: 'Documents\\Portunia\\Enregistrements' });
  dir.addEventListener('change', () => updateSettings({ recordingDir: dir.value.trim() }));
  recordings.defaultDir().then((d) => { dir.placeholder = d; }).catch(() => {});
  return h('div', { class: 'settings-block' },
    h('label', { class: 'check setting' },
      h('input', { type: 'checkbox', checked: s.autoRecord, onchange: (e: Event) => updateSettings({ autoRecord: (e.target as HTMLInputElement).checked }) }),
      h('span', {}, 'Enregistrer automatiquement chaque session terminal ', proChip('sessionRecording'),
        h('span', { class: 'muted small block' }, 'Seul ce que le serveur affiche est enregistré : les mots de passe tapés n\'y figurent pas.'))),
    h('div', { class: 'imp-file' }, dir,
      h('button', {
        type: 'button', class: 'btn', onclick: async () => {
          const picked = await open({ directory: true, multiple: false, title: 'Dossier des enregistrements' });
          if (typeof picked === 'string') { dir.value = picked; updateSettings({ recordingDir: picked }); }
        },
      }, 'Choisir…')),
    h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: () => openRecordings(toast) }, icon('play', 14), 'Voir les enregistrements'));
}

// ---------- Liste ----------

export function openRecordings(toast: Toast, onPlay?: (title: string, cast: string) => void) {
  const list = h('div', { class: 'snip-list' });
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'rec-title' },
    h('div', { class: 'snip-dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'rec-title' }, 'Enregistrements'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => dialog.close() }, icon('close'))),
      h('div', { class: 'dlg-body' }, list)));
  dialog.addEventListener('close', () => dialog.remove());

  const refresh = async () => {
    try {
      const items = await recordings.list(dirSetting());
      list.replaceChildren(...(items.length ? items.map((r) => h('div', { class: 'snip-row' },
        h('div', { class: 'grow', style: 'min-width: 0' },
          h('div', { class: 'ellipsis' }, h('strong', {}, r.name)),
          h('div', { class: 'muted small' }, `${new Date(r.modified * 1000).toLocaleString('fr-FR')} · ${formatSize(r.size)}`)),
        h('button', {
          class: 'btn', onclick: async () => {
            try {
              const cast = await recordings.read(dirSetting(), r.path);
              dialog.close();
              (onPlay ?? playerHandler)?.(r.name, cast);
            } catch (e) { toast(errorText(e), 'error'); }
          },
        }, icon('play', 14), 'Lire'),
        h('button', { class: 'icon-btn sm', 'aria-label': `Afficher ${r.name} dans l'Explorateur`, title: 'Afficher dans l\'Explorateur', onclick: () => revealItemInDir(r.path).catch(() => {}) }, icon('folder', 14)),
        h('button', {
          class: 'icon-btn sm', 'aria-label': `Supprimer ${r.name}`, title: 'Supprimer',
          onclick: async () => {
            if (!confirm(`Supprimer l'enregistrement « ${r.name} » ?`)) return;
            try { await recordings.remove(dirSetting(), r.path); refresh(); } catch (e) { toast(errorText(e), 'error'); }
          },
        }, icon('trash', 14))))
        : [h('p', { class: 'muted' }, 'Aucun enregistrement pour l\'instant. Utilisez le bouton « Enregistrer » d\'une session terminal.')]));
    } catch (e) {
      list.replaceChildren(h('p', { class: 'form-error' }, errorText(e)));
    }
  };
  document.body.append(dialog);
  dialog.showModal();
  refresh();
}

/** Ouverture d'un lecteur dans un onglet (fourni par l'application). */
let playerHandler: ((title: string, cast: string) => void) | undefined;
export const setPlayerHandler = (fn: (title: string, cast: string) => void) => { playerHandler = fn; };

