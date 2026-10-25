// Préférences de l'interface, enregistrées sur ce PC.
import { DEFAULT_RULES, HighlightRule } from './highlight-rules';
import { highlightSettings } from './highlight';
import { h, icon } from './dom';
import type { ShellSpec } from './api';
import { checkForUpdates } from './updates';
import { licenseSection, proChip, securitySection } from './security';
import { recordingSettings } from './recordings';
import { TERMINAL_THEMES } from './theme';
import { shellSettings } from './localshells';

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
  /** Enregistrer automatiquement chaque session terminal (Pro). */
  autoRecord: boolean;
  /** Dossier des enregistrements (vide = DocumentsTermorianregistrements). */
  recordingDir: string;
  /** Supervision : vérifier régulièrement que les serveurs répondent. */
  monitoring: boolean;
  /** Intervalle de vérification, en secondes. */
  monitorInterval: number;
  /** Notifications quand un serveur tombe ou revient (Pro). */
  monitorAlerts: boolean;
  /** Sessions à ne pas superviser. */
  monitorExcluded: string[];
  /** Thème de l'interface. */
  uiTheme: 'dark' | 'light' | 'system';
  /** Palette du terminal (« auto » : suit le thème). */
  termTheme: string;
  /** Shells locaux : masqués, par défaut, personnalisés, ouverture au démarrage. */
  localShells: { hidden: string[]; defaultId: string; custom: ShellSpec[]; atStartup: boolean };
  /** Rendu des terminaux : carte graphique (WebGL) si elle existe, toujours, ou jamais. */
  gpu: 'auto' | 'on' | 'off';
  /** Confirmation avant de coller plusieurs lignes dans un terminal. */
  confirmMultilinePaste: boolean;
  /** Mise en évidence de mots-clés dans les terminaux. */
  highlight: { enabled: boolean; rules: HighlightRule[] };
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
  autoRecord: false,
  recordingDir: '',
  monitoring: true,
  monitorInterval: 60,
  monitorAlerts: true,
  monitorExcluded: [],
  uiTheme: 'dark',
  termTheme: 'auto',
  localShells: { hidden: [], defaultId: '', custom: [], atStartup: false },
  gpu: 'auto',
  confirmMultilinePaste: true,
  highlight: { enabled: true, rules: DEFAULT_RULES },
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
  const check = (key: 'copyOnSelect' | 'rightClickPaste' | 'autoReconnect' | 'autoUpdate' | 'confirmMultilinePaste', label: string, hint: string) =>
    h('label', { class: 'check setting' },
      h('input', { type: 'checkbox', checked: s[key], onchange: (e: Event) => updateSettings({ [key]: (e.target as HTMLInputElement).checked }) }),
      h('span', {}, label, h('span', { class: 'muted small block' }, hint)));

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'settings-title' },
    h('form', { method: 'dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'settings-title' }, 'Paramètres'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => dialog.close() }, icon('close'))),
      h('div', { class: 'dlg-body' },
        h('h3', { class: 'label' }, 'Apparence'),
        h('div', { class: 'row2' },
          h('label', { class: 'fld' }, 'Thème',
            h('select', { onchange: (e: Event) => updateSettings({ uiTheme: (e.target as HTMLSelectElement).value as Settings['uiTheme'] }) },
              ...([['dark', 'Sombre'], ['light', 'Clair'], ['system', 'Comme Windows']] as const).map(([v, l]) => h('option', { value: v, selected: v === s.uiTheme }, l)))),
          h('label', { class: 'fld' }, 'Couleurs du terminal',
            h('select', { onchange: (e: Event) => updateSettings({ termTheme: (e.target as HTMLSelectElement).value }) },
              h('option', { value: 'auto', selected: s.termTheme === 'auto' }, 'Automatique (selon le thème)'),
              ...Object.entries(TERMINAL_THEMES).map(([k, t]) => h('option', { value: k, selected: k === s.termTheme }, t.label))))),
        h('p', { class: 'muted small', style: 'margin: 0' }, 'Couleur d’un dossier (par exemple rouge pour la production) : clic droit sur le dossier › Couleur. Elle s’affiche sur ses sessions, leurs onglets et la barre d’outils.'),
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
        h('label', { class: 'fld' }, 'Rendu des terminaux',
          h('select', { onchange: (e: Event) => updateSettings({ gpu: (e.target as HTMLSelectElement).value as Settings['gpu'] }) },
            ...([['auto', 'Automatique (carte graphique si disponible)'], ['on', 'Toujours la carte graphique (WebGL)'], ['off', 'Jamais (rendu classique)']] as const).map(([v, l]) => h('option', { value: v, selected: v === s.gpu }, l)))),
        h('p', { class: 'muted small', style: 'margin: 0' }, 'S’applique aux nouveaux onglets. Sans carte graphique (machine virtuelle, bureau à distance), le rendu classique est plus rapide.'),
        check('copyOnSelect', 'Copier automatiquement la sélection', 'Le texte sélectionné à la souris part dans le presse-papiers.'),
        check('rightClickPaste', 'Clic droit : copier ou coller', 'Avec une sélection, le clic droit copie ; sinon il colle (comme PuTTY).'),
        check('confirmMultilinePaste', 'Confirmer avant de coller plusieurs lignes', 'Chaque ligne partirait aussitôt comme une commande : un texte copié d’une page web peut en cacher.'),
        h('h3', { class: 'label' }, 'Mise en évidence'),
        highlightSettings(),
        h('h3', { class: 'label' }, 'Connexion'),
        check('autoReconnect', 'Reconnexion automatique', 'Après une coupure réseau ou une mise en veille, Termoria se reconnecte tout seul.'),
        h('h3', { class: 'label' }, 'Sécurité'),
        securitySection(toastFn, () => {}),
        h('h3', { class: 'label' }, 'Licence'),
        licenseSection(toastFn),
        h('h3', { class: 'label' }, 'Shells locaux'),
        shellSettings(toastFn),
        h('h3', { class: 'label' }, 'Enregistrement des sessions'),
        recordingSettings(toastFn),
        h('h3', { class: 'label' }, 'Supervision'),
        h('label', { class: 'check setting' },
          h('input', { type: 'checkbox', checked: s.monitoring, onchange: (e: Event) => updateSettings({ monitoring: (e.target as HTMLInputElement).checked }) }),
          h('span', {}, 'Vérifier que les serveurs répondent', h('span', { class: 'muted small block' }, 'Une pastille verte ou rouge dans l’arbre ; simple ouverture de connexion, sans s’identifier.'))),
        h('label', { class: 'fld' }, 'Fréquence',
          h('select', { onchange: (e: Event) => updateSettings({ monitorInterval: Number((e.target as HTMLSelectElement).value) }) },
            ...[[30, 'Toutes les 30 secondes'], [60, 'Toutes les minutes'], [300, 'Toutes les 5 minutes']].map(([v, l]) => h('option', { value: String(v), selected: v === s.monitorInterval }, String(l))))),
        h('label', { class: 'check setting' },
          h('input', { type: 'checkbox', checked: s.monitorAlerts, onchange: (e: Event) => updateSettings({ monitorAlerts: (e.target as HTMLInputElement).checked }) }),
          h('span', {}, 'Me prévenir quand un serveur tombe ou revient ', proChip('monitoringAlerts'), h('span', { class: 'muted small block' }, 'Notification Windows, même quand Termoria est en arrière-plan.'))),
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
