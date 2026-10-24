// Préférences de l'interface, enregistrées sur ce PC.
import { h, icon } from './dom';
import { checkForUpdates } from './updates';
import { licenseSection, securitySection } from './security';

export interface Settings {
  fontFamily: string;
  fontSize: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  scrollback: number;
  copyOnSelect: boolean;
  /** Clic droit : copie la sélection, sinon colle (comme PuTTY). */
  rightClickPaste: boolean;
  autoReconnect: boolean;
  /** Vérifier les mises à jour au démarrage. */
  autoUpdate: boolean;
}

export const DEFAULTS: Settings = {
  fontFamily: 'Cascadia Mono',
  fontSize: 13,
  cursorStyle: 'block',
  scrollback: 5000,
  copyOnSelect: false,
  rightClickPaste: true,
  autoReconnect: true,
  autoUpdate: true,
};

export const FONTS = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Lucida Console', 'Courier New'];

const KEY = 'termoria.settings';
const listeners = new Set<(s: Settings) => void>();
let current: Settings = load();

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = (): Settings => current;

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  current.fontSize = Math.min(32, Math.max(8, Math.round(current.fontSize)));
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* stockage indisponible */ }
  listeners.forEach((fn) => fn(current));
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Pile de polices : la police choisie, puis des valeurs sûres. */
export const fontStack = (s: Settings) => `"${s.fontFamily}", "Cascadia Mono", Consolas, monospace`;

export function openSettingsDialog(toastFn: (message: string, kind?: 'info' | 'error') => void) {
  const s = settings();
  const check = (key: 'copyOnSelect' | 'rightClickPaste' | 'autoReconnect' | 'autoUpdate', label: string, hint: string) =>
    h('label', { class: 'check setting' },
      h('input', { type: 'checkbox', checked: s[key], onchange: (e: Event) => updateSettings({ [key]: (e.target as HTMLInputElement).checked }) }),
      h('span', {}, label, h('span', { class: 'muted small block' }, hint)));

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'settings-title' },
    h('form', { method: 'dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'settings-title' }, 'Paramètres'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => dialog.close() }, icon('close'))),
      h('div', { class: 'dlg-body' },
        h('h3', { class: 'label' }, 'Terminal'),
        h('div', { class: 'row2' },
          h('label', { class: 'fld' }, 'Police',
            h('select', { onchange: (e: Event) => updateSettings({ fontFamily: (e.target as HTMLSelectElement).value }) },
              ...FONTS.map((f) => h('option', { value: f, selected: f === s.fontFamily }, f)))),
          h('label', { class: 'fld' }, 'Taille (Ctrl + molette dans le terminal)',
            h('input', { type: 'number', min: '8', max: '32', value: String(s.fontSize), oninput: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (v >= 8 && v <= 32) updateSettings({ fontSize: v });
            } }))),
        h('div', { class: 'row2' },
          h('label', { class: 'fld' }, 'Curseur',
            h('select', { onchange: (e: Event) => updateSettings({ cursorStyle: (e.target as HTMLSelectElement).value as Settings['cursorStyle'] }) },
              ...([['block', 'Bloc'], ['bar', 'Barre'], ['underline', 'Souligné']] as const).map(([v, l]) => h('option', { value: v, selected: v === s.cursorStyle }, l)))),
          h('label', { class: 'fld' }, 'Lignes d\'historique',
            h('input', { type: 'number', min: '500', max: '100000', step: '500', value: String(s.scrollback), onchange: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (v >= 500 && v <= 100000) updateSettings({ scrollback: v });
            } }))),
        check('copyOnSelect', 'Copier automatiquement la sélection', 'Le texte sélectionné à la souris part dans le presse-papiers.'),
        check('rightClickPaste', 'Clic droit : copier ou coller', 'Avec une sélection, le clic droit copie ; sinon il colle (comme PuTTY).'),
        h('h3', { class: 'label' }, 'Connexion'),
        check('autoReconnect', 'Reconnexion automatique', 'Après une coupure réseau ou une mise en veille, Termoria se reconnecte tout seul.'),
        h('h3', { class: 'label' }, 'Sécurité'),
        securitySection(toastFn, () => {}),
        h('h3', { class: 'label' }, 'Licence'),
        licenseSection(toastFn),
        h('h3', { class: 'label' }, 'Mises à jour'),
        check('autoUpdate', 'Vérifier les mises à jour au démarrage', 'Une bannière propose la nouvelle version ; rien ne s’installe sans votre accord.'),
        h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: () => checkForUpdates(toastFn) }, icon('refresh', 14), 'Rechercher maintenant'),
        h('p', { class: 'muted small' }, 'Raccourcis : Ctrl+Maj+F rechercher dans le terminal · Ctrl+clic sur un lien pour l\'ouvrir · Ctrl+Maj+C / V copier / coller.')),
      h('footer', { class: 'dlg-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => { updateSettings({ ...DEFAULTS }); dialog.close(); openSettingsDialog(toastFn); } }, 'Valeurs par défaut'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Fermer'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
