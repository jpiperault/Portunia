// Apparence : thème de l'interface, palettes du terminal, couleurs de dossier.
import type { ITheme } from '@xterm/xterm';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { onSettingsChange, settings } from './settings';

// ---------- Thème de l'interface ----------

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

export function resolvedTheme(): 'dark' | 'light' {
  const t = settings().uiTheme;
  return t === 'system' ? (systemDark.matches ? 'dark' : 'light') : t;
}

export function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty('--term', terminalTheme().background ?? '#111215');
  // Barre de titre Windows assortie.
  getCurrentWindow().setTheme(theme).catch(() => {});
  // Les terminaux ouverts suivent (palette « auto » quand Windows change de thème).
  window.dispatchEvent(new Event('termoria-theme'));
}

export function initTheme() {
  applyTheme();
  systemDark.addEventListener('change', applyTheme);
  onSettingsChange(applyTheme);
}

// ---------- Palettes du terminal ----------

export const TERMINAL_THEMES: Record<string, ITheme & { label: string }> = {
  termoria: {
    label: 'Termoria',
    background: '#111215', foreground: '#D6D8DD', cursor: '#5B9BFF', selectionBackground: '#2F4A75',
  },
  campbell: {
    label: 'Campbell (Windows Terminal)',
    background: '#0C0C0C', foreground: '#CCCCCC', cursor: '#FFFFFF', selectionBackground: '#3A3A3A',
    black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', magenta: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
    brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightMagenta: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
  },
  oneDark: {
    label: 'One Dark',
    background: '#282C34', foreground: '#ABB2BF', cursor: '#528BFF', selectionBackground: '#3E4451',
    black: '#282C34', red: '#E06C75', green: '#98C379', yellow: '#E5C07B', blue: '#61AFEF', magenta: '#C678DD', cyan: '#56B6C2', white: '#ABB2BF',
    brightBlack: '#5C6370', brightRed: '#E06C75', brightGreen: '#98C379', brightYellow: '#E5C07B', brightBlue: '#61AFEF', brightMagenta: '#C678DD', brightCyan: '#56B6C2', brightWhite: '#FFFFFF',
  },
  dracula: {
    label: 'Dracula',
    background: '#282A36', foreground: '#F8F8F2', cursor: '#F8F8F2', selectionBackground: '#44475A',
    black: '#21222C', red: '#FF5555', green: '#50FA7B', yellow: '#F1FA8C', blue: '#BD93F9', magenta: '#FF79C6', cyan: '#8BE9FD', white: '#F8F8F2',
    brightBlack: '#6272A4', brightRed: '#FF6E6E', brightGreen: '#69FF94', brightYellow: '#FFFFA5', brightBlue: '#D6ACFF', brightMagenta: '#FF92DF', brightCyan: '#A4FFFF', brightWhite: '#FFFFFF',
  },
  nord: {
    label: 'Nord',
    background: '#2E3440', foreground: '#D8DEE9', cursor: '#D8DEE9', selectionBackground: '#434C5E',
    black: '#3B4252', red: '#BF616A', green: '#A3BE8C', yellow: '#EBCB8B', blue: '#81A1C1', magenta: '#B48EAD', cyan: '#88C0D0', white: '#E5E9F0',
    brightBlack: '#4C566A', brightRed: '#BF616A', brightGreen: '#A3BE8C', brightYellow: '#EBCB8B', brightBlue: '#81A1C1', brightMagenta: '#B48EAD', brightCyan: '#8FBCBB', brightWhite: '#ECEFF4',
  },
  gruvbox: {
    label: 'Gruvbox',
    background: '#282828', foreground: '#EBDBB2', cursor: '#EBDBB2', selectionBackground: '#504945',
    black: '#282828', red: '#CC241D', green: '#98971A', yellow: '#D79921', blue: '#458588', magenta: '#B16286', cyan: '#689D6A', white: '#A89984',
    brightBlack: '#928374', brightRed: '#FB4934', brightGreen: '#B8BB26', brightYellow: '#FABD2F', brightBlue: '#83A598', brightMagenta: '#D3869B', brightCyan: '#8EC07C', brightWhite: '#EBDBB2',
  },
  solarizedDark: {
    label: 'Solarized sombre',
    background: '#002B36', foreground: '#839496', cursor: '#93A1A1', selectionBackground: '#073642',
    black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
    brightBlack: '#586E75', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83', brightBlue: '#839496', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3',
  },
  solarizedLight: {
    label: 'Solarized clair',
    background: '#FDF6E3', foreground: '#586E75', cursor: '#586E75', selectionBackground: '#EEE8D5',
    black: '#073642', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2', magenta: '#D33682', cyan: '#2AA198', white: '#EEE8D5',
    brightBlack: '#002B36', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83', brightBlue: '#839496', brightMagenta: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3',
  },
  light: {
    label: 'Clair',
    background: '#FFFFFF', foreground: '#1F2328', cursor: '#2563D6', selectionBackground: '#CFE0FB',
    black: '#24292F', red: '#CF222E', green: '#116329', yellow: '#7D4E00', blue: '#0969DA', magenta: '#8250DF', cyan: '#1B7C83', white: '#6E7781',
    brightBlack: '#57606A', brightRed: '#A40E26', brightGreen: '#1A7F37', brightYellow: '#633C01', brightBlue: '#218BFF', brightMagenta: '#A475F9', brightCyan: '#3192AA', brightWhite: '#8C959F',
  },
};

/** Palette du terminal ; « auto » suit le thème de l'interface. */
export function terminalTheme(): ITheme {
  const name = settings().termTheme;
  if (name === 'auto') return resolvedTheme() === 'light' ? TERMINAL_THEMES.light : TERMINAL_THEMES.termoria;
  return TERMINAL_THEMES[name] ?? TERMINAL_THEMES.termoria;
}

// ---------- Couleurs de dossier ----------

export const FOLDER_COLORS: Record<string, { label: string; value: string }> = {
  red: { label: 'Rouge', value: '#E5484D' },
  orange: { label: 'Orange', value: '#F08C2E' },
  yellow: { label: 'Jaune', value: '#D9B230' },
  green: { label: 'Vert', value: '#3FB37F' },
  blue: { label: 'Bleu', value: '#4C8DFF' },
  purple: { label: 'Violet', value: '#9B6DFF' },
};

/** Couleur d'un dossier : la sienne, sinon celle du plus proche parent coloré. */
export function colorOf(folder: string, colors: Record<string, string>): string | undefined {
  let path = folder;
  while (path) {
    const c = colors[path];
    if (c && FOLDER_COLORS[c]) return FOLDER_COLORS[c].value;
    path = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  }
  return undefined;
}

/** Applique (ou retire) la couleur d'un élément. */
export function paint(el: HTMLElement, color: string | undefined) {
  if (color) {
    el.dataset.color = '';
    el.style.setProperty('--folder-color', color);
  } else {
    delete el.dataset.color;
    el.style.removeProperty('--folder-color');
  }
}
