// Lecteur détaché : la relecture d'une session de la Gate dans sa propre fenêtre (bouton
// « Détacher » des lecteurs). Paramètres : ?gate=…&session=…[&reveler=1].
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { gates, errorText } from './api';
import { h } from './dom';
import { t } from './i18n';
import { buildReplay, replayTitle } from './replayview';
import { initTheme } from './theme';

const toasts = document.getElementById('toasts') as HTMLElement;
function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = h('div', { class: `toast ${kind}` }, message);
  toasts.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 4000);
}

async function start() {
  initTheme();
  const q = new URLSearchParams(location.search);
  const view = document.getElementById('relecture') as HTMLElement;
  try {
    const b = (await gates.list()).find((g) => g.id === q.get('gate'));
    if (!b) throw new Error(t('Gate not found', 'Gate introuvable'));
    const reveal = q.get('reveler') === '1';
    const built = await buildReplay(b, q.get('session') ?? '', view, {
      reveal,
      host: { toast, reveal: () => { location.search = `?gate=${b.id}&session=${q.get('session')}&reveler=1`; } },
    });
    if (!built) return;
    document.title = `${replayTitle(built.session.serveur, built.session.debut)}${reveal ? t(' (revealed)', ' (révélé)') : ''} — Portunia`;
    view.focus();
    window.addEventListener('beforeunload', () => built.player.dispose());
  } catch (e) {
    view.replaceChildren(h('p', { class: 'form-error', style: 'padding:20px' }, errorText(e)));
  }
}

start();
