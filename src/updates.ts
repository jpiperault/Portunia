// Mises à jour automatiques : vérification au démarrage, installation en un clic.
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { errorText } from './api';
import { h, icon } from './dom';

type Toast = (message: string, kind?: 'info' | 'error') => void;

let banner: HTMLElement | null = null;

/** Cherche une nouvelle version ; `silent` : ne rien dire s'il n'y en a pas (vérification automatique). */
export async function checkForUpdates(toast: Toast, silent = false) {
  let update: Update | null;
  try {
    update = await check();
  } catch (e) {
    if (!silent) toast(`Impossible de vérifier les mises à jour : ${errorText(e)}`, 'error');
    return;
  }
  if (!update) {
    if (!silent) toast('Termoria est à jour.');
    return;
  }
  showBanner(update, toast);
}

function showBanner(update: Update, toast: Toast) {
  banner?.remove();
  const progress = h('span', { class: 'muted small' });
  const install = h('button', {
    class: 'btn primary',
    onclick: async () => {
      install.disabled = true;
      let total = 0;
      let done = 0;
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === 'Started') total = event.data.contentLength ?? 0;
          if (event.event === 'Progress') {
            done += event.data.chunkLength;
            progress.textContent = total ? `Téléchargement ${Math.round((done / total) * 100)} %` : 'Téléchargement…';
          }
          if (event.event === 'Finished') progress.textContent = 'Installation…';
        });
        await relaunch();
      } catch (e) {
        install.disabled = false;
        progress.textContent = '';
        toast(`Mise à jour impossible : ${errorText(e)}`, 'error');
      }
    },
  }, 'Installer et redémarrer');

  banner = h('div', { class: 'update-banner', role: 'status' },
    icon('download', 16),
    h('div', { class: 'grow' },
      h('strong', {}, `Termoria ${update.version} est disponible`),
      update.body && h('div', { class: 'muted small ellipsis', title: update.body }, update.body.split('\n')[0])),
    progress,
    install,
    h('button', { class: 'icon-btn sm', 'aria-label': 'Plus tard', title: 'Plus tard', onclick: () => { banner?.remove(); banner = null; } }, icon('close', 14)));
  document.body.append(banner);
}
