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
import { t } from './i18n';
import { IS_MAC, keys } from './platform';
import type { MetaMapping } from './rdpkeys';

/** « Comme Windows » / « Comme macOS » : libellé du réglage qui suit le système. */
const likeSystem = () => (IS_MAC ? t('Like macOS', 'Comme macOS') : t('Like Windows', 'Comme Windows'));

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
  /** Dossier des enregistrements (vide = DocumentsPortunianregistrements). */
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
  /** Extensions désactivées : absentes des menus, leurs sessions restent (grisées). */
  disabledExtensions: string[];
  /** Extensions du catalogue installées (les autres n'apparaissent que dans le catalogue). */
  installedExtensions: string[];
  /** Langue de l'interface : celle de Windows, anglais ou français (appliquée au prochain démarrage). */
  language: 'auto' | 'en' | 'fr';
  /** Sessions épinglées en tête de la barre latérale. */
  favorites: string[];
  /** Mac : la touche ⌘ est envoyée comme Ctrl (défaut) ou comme la touche Windows, en Bureau à distance. */
  metaKeyAs: MetaMapping;
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
  disabledExtensions: [],
  installedExtensions: [],
  language: 'auto',
  favorites: [],
  metaKeyAs: 'ctrl',
};

export const FONTS = ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'Lucida Console', 'Courier New'];

// Clé à l'ancien nom du logiciel, gardée pour retrouver les réglages existants.
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

  const langNote = h('p', { class: 'muted small', style: 'margin: 0', hidden: true }, t('The new language applies the next time Portunia starts.', 'La nouvelle langue s’applique au prochain démarrage de Portunia.'));
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'settings-title' },
    h('form', { method: 'dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'settings-title' }, t('Settings', 'Paramètres')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close', 'Fermer'), onclick: () => dialog.close() }, icon('close'))),
      h('div', { class: 'dlg-body' },
        h('h3', { class: 'label' }, t('Appearance', 'Apparence')),
        h('div', { class: 'row2' },
          h('label', { class: 'fld' }, t('Theme', 'Thème'),
            h('select', { onchange: (e: Event) => updateSettings({ uiTheme: (e.target as HTMLSelectElement).value as Settings['uiTheme'] }) },
              ...([['dark', t('Dark', 'Sombre')], ['light', t('Light', 'Clair')], ['system', likeSystem()]] as const).map(([v, l]) => h('option', { value: v, selected: v === s.uiTheme }, l)))),
          h('label', { class: 'fld' }, t('Terminal colours', 'Couleurs du terminal'),
            h('select', { onchange: (e: Event) => updateSettings({ termTheme: (e.target as HTMLSelectElement).value }) },
              h('option', { value: 'auto', selected: s.termTheme === 'auto' }, t('Automatic (follows the theme)', 'Automatique (selon le thème)')),
              ...Object.entries(TERMINAL_THEMES).map(([k, t]) => h('option', { value: k, selected: k === s.termTheme }, t.label))))),
        h('p', { class: 'muted small', style: 'margin: 0' }, t('A folder\'s colour (for example red for production): right-click the folder › Colour. It shows on its sessions, their tabs and the toolbar.', 'Couleur d’un dossier (par exemple rouge pour la production) : clic droit sur le dossier › Couleur. Elle s’affiche sur ses sessions, leurs onglets et la barre d’outils.')),
        h('div', { class: 'row2' },
          h('label', { class: 'fld' }, 'Language · Langue',
            h('select', { onchange: (e: Event) => { updateSettings({ language: (e.target as HTMLSelectElement).value as Settings['language'] }); langNote.hidden = false; } },
              ...([['auto', likeSystem()], ['en', 'English'], ['fr', 'Français']] as const).map(([v, l]) => h('option', { value: v, selected: v === s.language }, l))))),
        langNote,
        h('h3', { class: 'label' }, 'Terminal'),
        h('div', { class: 'row2' },
          h('label', { class: 'fld' }, t('Font', 'Police'),
            h('select', { onchange: (e: Event) => updateSettings({ fontFamily: (e.target as HTMLSelectElement).value }) },
              ...FONTS.map((f) => h('option', { value: f, selected: f === s.fontFamily }, f)))),
          h('label', { class: 'fld' }, keys(t('Size (Ctrl + wheel in the terminal)', 'Taille (Ctrl + molette dans le terminal)')),
            h('input', { type: 'number', min: '8', max: '32', value: String(s.fontSize), oninput: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (v >= 8 && v <= 32) updateSettings({ fontSize: v });
            } }))),
        h('div', { class: 'row2' },
          h('label', { class: 'fld' }, t('Cursor', 'Curseur'),
            h('select', { onchange: (e: Event) => updateSettings({ cursorStyle: (e.target as HTMLSelectElement).value as Settings['cursorStyle'] }) },
              ...([['block', t('Block', 'Bloc')], ['bar', t('Bar', 'Barre')], ['underline', t('Underline', 'Souligné')]] as const).map(([v, l]) => h('option', { value: v, selected: v === s.cursorStyle }, l)))),
          h('label', { class: 'fld' }, t('Scrollback lines', 'Lignes d\'historique'),
            h('input', { type: 'number', min: '500', max: '100000', step: '500', value: String(s.scrollback), onchange: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (v >= 500 && v <= 100000) updateSettings({ scrollback: v });
            } }))),
        h('label', { class: 'fld' }, t('Terminal rendering', 'Rendu des terminaux'),
          h('select', { onchange: (e: Event) => updateSettings({ gpu: (e.target as HTMLSelectElement).value as Settings['gpu'] }) },
            ...([['auto', t('Automatic (graphics card if available)', 'Automatique (carte graphique si disponible)')], ['on', t('Always the graphics card (WebGL)', 'Toujours la carte graphique (WebGL)')], ['off', t('Never (classic rendering)', 'Jamais (rendu classique)')]] as const).map(([v, l]) => h('option', { value: v, selected: v === s.gpu }, l)))),
        h('p', { class: 'muted small', style: 'margin: 0' }, t('Applies to new tabs. Without a graphics card (virtual machine, remote desktop), classic rendering is faster.', 'S’applique aux nouveaux onglets. Sans carte graphique (machine virtuelle, bureau à distance), le rendu classique est plus rapide.')),
        check('copyOnSelect', t('Copy the selection automatically', 'Copier automatiquement la sélection'), t('Text selected with the mouse goes to the clipboard.', 'Le texte sélectionné à la souris part dans le presse-papiers.')),
        check('rightClickPaste', t('Right-click: copy or paste', 'Clic droit : copier ou coller'), t('With a selection, right-click copies; otherwise it pastes (like PuTTY).', 'Avec une sélection, le clic droit copie ; sinon il colle (comme PuTTY).')),
        check('confirmMultilinePaste', t('Confirm before pasting several lines', 'Confirmer avant de coller plusieurs lignes'), t('Each line would go right away as a command: text copied from a web page can hide some.', 'Chaque ligne partirait aussitôt comme une commande : un texte copié d’une page web peut en cacher.')),
        h('h3', { class: 'label' }, t('Highlighting', 'Mise en évidence')),
        highlightSettings(),
        h('h3', { class: 'label' }, t('Connection', 'Connexion')),
        check('autoReconnect', t('Automatic reconnection', 'Reconnexion automatique'), t('After a network cut or sleep, Portunia reconnects by itself.', 'Après une coupure réseau ou une mise en veille, Portunia se reconnecte tout seul.')),
        IS_MAC && h('label', { class: 'fld' }, t('⌘ key sent as', 'Touche ⌘ envoyée comme'),
          h('select', { onchange: (e: Event) => updateSettings({ metaKeyAs: (e.target as HTMLSelectElement).value as MetaMapping }) },
            ...([['ctrl', 'Ctrl'], ['windows', 'Windows']] as const).map(([v, l]) => h('option', { value: v, selected: v === s.metaKeyAs }, l)))),
        IS_MAC && h('p', { class: 'muted small', style: 'margin: 0' }, t('Remote Desktop and VNC screens. With Ctrl, ⌘C and ⌘V copy and paste on Windows; ⌥ is always Alt.', 'Écrans Bureau à distance et VNC. Avec Ctrl, ⌘C et ⌘V copient et collent sous Windows ; ⌥ reste toujours Alt.')),
        h('h3', { class: 'label' }, t('Security', 'Sécurité')),
        securitySection(toastFn, () => {}),
        h('h3', { class: 'label' }, t('Licence', 'Licence')),
        licenseSection(toastFn),
        h('h3', { class: 'label' }, t('Local shells', 'Shells locaux')),
        shellSettings(toastFn),
        h('h3', { class: 'label' }, t('Session recording', 'Enregistrement des sessions')),
        recordingSettings(toastFn),
        h('h3', { class: 'label' }, t('Monitoring', 'Supervision')),
        h('label', { class: 'check setting' },
          h('input', { type: 'checkbox', checked: s.monitoring, onchange: (e: Event) => updateSettings({ monitoring: (e.target as HTMLInputElement).checked }) }),
          h('span', {}, t('Check that servers answer', 'Vérifier que les serveurs répondent'), h('span', { class: 'muted small block' }, t('A green or red dot in the tree; a simple connection attempt, without signing in.', 'Une pastille verte ou rouge dans l’arbre ; simple ouverture de connexion, sans s’identifier.')))),
        h('label', { class: 'fld' }, t('Frequency', 'Fréquence'),
          h('select', { onchange: (e: Event) => updateSettings({ monitorInterval: Number((e.target as HTMLSelectElement).value) }) },
            ...[[30, t('Every 30 seconds', 'Toutes les 30 secondes')], [60, t('Every minute', 'Toutes les minutes')], [300, t('Every 5 minutes', 'Toutes les 5 minutes')]].map(([v, l]) => h('option', { value: String(v), selected: v === s.monitorInterval }, String(l))))),
        h('label', { class: 'check setting' },
          h('input', { type: 'checkbox', checked: s.monitorAlerts, onchange: (e: Event) => updateSettings({ monitorAlerts: (e.target as HTMLInputElement).checked }) }),
          h('span', {}, t('Notify me when a server goes down or comes back ', 'Me prévenir quand un serveur tombe ou revient '), proChip('monitoringAlerts'), h('span', { class: 'muted small block' }, IS_MAC ? t('macOS notification, even when Portunia is in the background.', 'Notification macOS, même quand Portunia est en arrière-plan.') : t('Windows notification, even when Portunia is in the background.', 'Notification Windows, même quand Portunia est en arrière-plan.')))),
        h('h3', { class: 'label' }, t('Updates', 'Mises à jour')),
        check('autoUpdate', t('Check for updates at startup', 'Vérifier les mises à jour au démarrage'), t('A banner offers the new version; nothing installs without your consent.', 'Une bannière propose la nouvelle version ; rien ne s’installe sans votre accord.')),
        h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: () => checkForUpdates(toastFn) }, icon('refresh', 14), t('Check now', 'Rechercher maintenant')),
        h('p', { class: 'muted small' }, keys(t('Shortcuts: Ctrl+Shift+F search in the terminal · Ctrl+click a link to open it · Ctrl+Shift+C / V copy / paste.', 'Raccourcis : Ctrl+Maj+F rechercher dans le terminal · Ctrl+clic sur un lien pour l\'ouvrir · Ctrl+Maj+C / V copier / coller.')))),
      h('footer', { class: 'dlg-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => { updateSettings({ ...DEFAULTS }); dialog.close(); openSettingsDialog(toastFn); } }, t('Defaults', 'Valeurs par défaut')),
        h('button', { type: 'submit', class: 'btn primary' }, t('Close', 'Fermer')))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
