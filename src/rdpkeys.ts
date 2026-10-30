// Frappe d'une session Bureau à distance : le bastion enregistre des codes de touche matériels ;
// on en tire le texte selon la disposition du clavier, en appliquant accents et effacements.
import { LANG, t } from './i18n';
import type { RdpEvent } from './rdpplayer';


/** Une touche par code (jeu 1) : [normal, majuscule, AltGr]. */
type Layout = Record<number, [string, string, string?]>;

const LETTERS_US: Layout = {
  0x02: ['1', '!'], 0x03: ['2', '@'], 0x04: ['3', '#'], 0x05: ['4', '$'], 0x06: ['5', '%'], 0x07: ['6', '^'], 0x08: ['7', '&'], 0x09: ['8', '*'], 0x0a: ['9', '('], 0x0b: ['0', ')'], 0x0c: ['-', '_'], 0x0d: ['=', '+'],
  0x10: ['q', 'Q'], 0x11: ['w', 'W'], 0x12: ['e', 'E'], 0x13: ['r', 'R'], 0x14: ['t', 'T'], 0x15: ['y', 'Y'], 0x16: ['u', 'U'], 0x17: ['i', 'I'], 0x18: ['o', 'O'], 0x19: ['p', 'P'], 0x1a: ['[', '{'], 0x1b: [']', '}'],
  0x1e: ['a', 'A'], 0x1f: ['s', 'S'], 0x20: ['d', 'D'], 0x21: ['f', 'F'], 0x22: ['g', 'G'], 0x23: ['h', 'H'], 0x24: ['j', 'J'], 0x25: ['k', 'K'], 0x26: ['l', 'L'], 0x27: [';', ':'], 0x28: ['\'', '"'], 0x29: ['`', '~'], 0x2b: ['\\', '|'],
  0x2c: ['z', 'Z'], 0x2d: ['x', 'X'], 0x2e: ['c', 'C'], 0x2f: ['v', 'V'], 0x30: ['b', 'B'], 0x31: ['n', 'N'], 0x32: ['m', 'M'], 0x33: [',', '<'], 0x34: ['.', '>'], 0x35: ['/', '?'], 0x56: ['\\', '|'],
  0x39: [' ', ' '],
};

const LETTERS_FR: Layout = {
  0x02: ['&', '1'], 0x03: ['é', '2', '~'], 0x04: ['"', '3', '#'], 0x05: ['\'', '4', '{'], 0x06: ['(', '5', '['], 0x07: ['-', '6', '|'], 0x08: ['è', '7', '`'], 0x09: ['_', '8', '\\'], 0x0a: ['ç', '9', '^'], 0x0b: ['à', '0', '@'], 0x0c: [')', '°', ']'], 0x0d: ['=', '+', '}'],
  0x10: ['a', 'A'], 0x11: ['z', 'Z'], 0x12: ['e', 'E', '€'], 0x13: ['r', 'R'], 0x14: ['t', 'T'], 0x15: ['y', 'Y'], 0x16: ['u', 'U'], 0x17: ['i', 'I'], 0x18: ['o', 'O'], 0x19: ['p', 'P'], 0x1a: ['^', '¨'], 0x1b: ['$', '£', '¤'],
  0x1e: ['q', 'Q'], 0x1f: ['s', 'S'], 0x20: ['d', 'D'], 0x21: ['f', 'F'], 0x22: ['g', 'G'], 0x23: ['h', 'H'], 0x24: ['j', 'J'], 0x25: ['k', 'K'], 0x26: ['l', 'L'], 0x27: ['m', 'M'], 0x28: ['ù', '%'], 0x29: ['²', '²'], 0x2b: ['*', 'µ'],
  0x2c: ['w', 'W'], 0x2d: ['x', 'X'], 0x2e: ['c', 'C'], 0x2f: ['v', 'V'], 0x30: ['b', 'B'], 0x31: ['n', 'N'], 0x32: [',', '?'], 0x33: [';', '.'], 0x34: [':', '/'], 0x35: ['!', '§'], 0x56: ['<', '>'],
  0x39: [' ', ' '],
};

/** Pavé numérique (verrouillage numérique actif). */
const NUMPAD: Record<number, string> = { 0x47: '7', 0x48: '8', 0x49: '9', 0x4a: '-', 0x4b: '4', 0x4c: '5', 0x4d: '6', 0x4e: '+', 0x4f: '1', 0x50: '2', 0x51: '3', 0x52: '0', 0x53: '.', 0x37: '*' };

/** Touches spéciales, montrées comme des pastilles. Clé : code, « e » pour une touche étendue. */
const SPECIAL: Record<string, string> = {
  '28': t('Enter', 'Entrée'), 'e28': t('Enter', 'Entrée'), '14': '⌫', '15': 'Tab', '1': t('Esc', 'Échap'),
  'e83': t('Del', 'Suppr'), 'e71': t('Home', 'Début'), 'e79': t('End', 'Fin'), 'e72': '↑', 'e80': '↓', 'e75': '←', 'e77': '→', 'e82': 'Ins', 'e73': t('PgUp', 'Pg↑'), 'e81': t('PgDn', 'Pg↓'), 'e91': 'Win', 'e92': 'Win',
  '59': 'F1', '60': 'F2', '61': 'F3', '62': 'F4', '63': 'F5', '64': 'F6', '65': 'F7', '66': 'F8', '67': 'F9', '68': 'F10', '87': 'F11', '88': 'F12',
};

/** Accents morts du français, par touche : [normal, majuscule, AltGr]. */
const DEAD_KEY: Record<number, [string?, string?, string?]> = { 0x1a: ['̂', '̈'], 0x03: [undefined, undefined, '̃'], 0x08: [undefined, undefined, '̀'] };
const DEAD_SIGN: Record<string, string> = { '̂': '^', '̈': '¨', '̃': '~', '̀': '`' };

export type LayoutName = 'azerty' | 'qwerty';
export type LayoutChoice = 'auto' | LayoutName;

/** Disposition française (France, Belgique, Suisse romande, Luxembourg). */
const isAzerty = (id: number) => [0x040c, 0x080c, 0x100c, 0x140c].includes(id & 0xffff);

/**
 * Disposition réelle de la session. Celle annoncée par le poste est souvent absente (0), et c'est
 * Windows côté serveur qui décide : on regarde donc la frappe. La touche A d'un AZERTY est le Q
 * d'un QWERTY ; « a » étant bien plus fréquent que « q » en français comme en anglais, la plus
 * utilisée des deux donne la disposition.
 */
export function detectLayout(events: RdpEvent[]): LayoutName {
  let top = 0;
  let middle = 0;
  let declared = 0;
  for (const e of events) {
    if (e.k === 'clavier') declared = e.disposition;
    if (e.k === 'touche' && !e.r && !e.e) {
      if (e.c === 0x10) top++;
      if (e.c === 0x1e) middle++;
    }
  }
  if (top + middle >= 5 && top !== middle) return top > middle ? 'azerty' : 'qwerty';
  if (declared & 0xffff) return isAzerty(declared) ? 'azerty' : 'qwerty';
  return LANG === 'fr' ? 'azerty' : 'qwerty';
}

/** Un élément tapé. `gone` : moment où il a été effacé. */
export interface Key { t: number; text?: string; chip?: string; gone?: number }

/** Une ligne de frappe : du premier caractère à Entrée (ou un clic). */
export interface Line { t: number; end: number; text: string; keys: Key[]; level: '' | 'w' | 'x' }

export function typedLines(events: RdpEvent[], sensitive: string[], layoutName: LayoutName): Line[] {
  const layout = layoutName === 'azerty' ? LETTERS_FR : LETTERS_US;
  const mods = { shift: false, ctrl: false, alt: false, altgr: false, caps: false, num: true };
  const lines: Line[] = [];
  let cur: Line | null = null;
  // Texte vivant de la ligne, curseur dedans, « tout sélectionné » après Ctrl+A.
  let live: Key[] = [];
  let caret = 0;
  let selected = false;
  let dead = '';
  const close = (at: number) => {
    if (cur) { cur.end = at; cur.text = live.map((k) => k.text).join(''); lines.push(cur); cur = null; }
    live = [];
    caret = 0;
    selected = false;
    dead = '';
  };
  const line = (at: number): Line => (cur ??= { t: at, end: Infinity, text: '', keys: [], level: '' });
  const chip = (at: number, name: string) => { line(at).keys.push({ t: at, chip: name }); };
  const erase = (at: number, from: number, to: number) => {
    for (const k of live.splice(from, to - from)) k.gone = at;
    if (caret > from) caret = Math.max(from, caret - (to - from));
  };
  const eraseAll = (at: number) => { erase(at, 0, live.length); caret = 0; selected = false; };
  const type = (at: number, text: string) => {
    if (!text) return;
    if (selected) eraseAll(at);
    const l = line(at);
    const key: Key = { t: at, text };
    // Curseur au milieu : inséré après le caractère à sa gauche, pour rester à sa place.
    const before = live[caret - 1];
    if (caret === live.length) l.keys.push(key);
    else if (before) l.keys.splice(l.keys.indexOf(before) + 1, 0, key);
    else l.keys.splice(l.keys.indexOf(live[0]), 0, key);
    live.splice(caret, 0, key);
    caret++;
  };
  for (const e of events) {
    if (e.k === 'clic') { close(e.t); continue; }
    if (e.k === 'voyants') {
      // Envoyé quand la fenêtre reprend la main : les touches tenues ont été relâchées ailleurs.
      mods.caps = !!(e.f & 4);
      mods.num = !!(e.f & 2);
      mods.shift = mods.ctrl = mods.alt = mods.altgr = false;
      continue;
    }
    if (e.k === 'unicode') { if (!e.r) type(e.t, String.fromCharCode(e.u)); continue; }
    if (e.k !== 'touche') continue;
    const down = !e.r;
    // Modificateurs.
    if (e.c === 0x2a || e.c === 0x36) { mods.shift = down; continue; }
    if (e.c === 0x1d) { mods.ctrl = down; continue; }
    if (e.c === 0x38) { if (e.e) mods.altgr = down; else mods.alt = down; continue; }
    if (e.c === 0x3a) { if (down) mods.caps = !mods.caps; continue; }
    if (e.c === 0x45 && !e.e) { if (down) mods.num = !mods.num; continue; }
    if (!down) continue;
    const name = SPECIAL[`${e.e ? 'e' : ''}${e.c}`];
    if (e.c === 0x0e && !e.e) {
      if (selected) eraseAll(e.t);
      else if (!caret) chip(e.t, '⌫');
      else if (mods.ctrl) {
        // Ctrl+Retour : le mot à gauche.
        let from = caret;
        while (from && live[from - 1].text === ' ') from--;
        while (from && live[from - 1].text !== ' ') from--;
        erase(e.t, from, caret);
      } else erase(e.t, caret - 1, caret);
      continue;
    }
    if (e.c === 0x53 && e.e) {
      if (selected) eraseAll(e.t);
      else if (caret < live.length) erase(e.t, caret, caret + 1);
      else chip(e.t, name);
      continue;
    }
    if (e.e && (e.c === 0x4b || e.c === 0x4d || e.c === 0x47 || e.c === 0x4f)) {
      selected = false;
      caret = e.c === 0x4b ? Math.max(0, caret - 1) : e.c === 0x4d ? Math.min(live.length, caret + 1) : e.c === 0x47 ? 0 : live.length;
      chip(e.t, name);
      continue;
    }
    if (name) {
      chip(e.t, name);
      if (e.c === 0x1c) close(e.t);
      continue;
    }
    if (!e.e && NUMPAD[e.c]) {
      // Sans verrouillage numérique, le pavé déplace le curseur.
      const nav = mods.num ? undefined : SPECIAL[`e${e.c}`];
      if (nav) chip(e.t, nav);
      else type(e.t, NUMPAD[e.c]);
      continue;
    }
    if (e.e && e.c === 0x35) { type(e.t, '/'); continue; }
    const key = layout[e.c];
    if (!key) continue;
    const altgr = mods.altgr || (mods.ctrl && mods.alt);
    if (!altgr && (mods.ctrl || mods.alt)) {
      // Raccourci (Ctrl+C, Alt+Tab…) : une pastille.
      const combo = `${mods.ctrl ? 'Ctrl+' : 'Alt+'}${key[0].toUpperCase()}`;
      chip(e.t, combo);
      selected = combo === 'Ctrl+A' && live.length > 0;
      continue;
    }
    const letter = /^[a-z]$/.test(key[0]);
    const upper = letter ? mods.shift !== mods.caps : mods.shift || (layout === LETTERS_FR && mods.caps && /^[0-9]$/.test(key[1]));
    if (layout === LETTERS_FR) {
      const mark = DEAD_KEY[e.c]?.[altgr ? 2 : upper ? 1 : 0];
      if (mark) {
        if (dead) type(e.t, DEAD_SIGN[dead]);
        dead = mark;
        continue;
      }
    }
    let text = altgr ? key[2] ?? '' : upper ? key[1] : key[0];
    if (dead && text) {
      const composed = (text + dead).normalize('NFC');
      text = composed.length === 1 ? composed : text === ' ' ? DEAD_SIGN[dead] : DEAD_SIGN[dead] + text;
      dead = '';
    }
    type(e.t, text);
  }
  close(Infinity);
  for (const l of lines) {
    const text = l.text.toLowerCase();
    l.level = sensitive.some((c) => text.includes(c)) ? 'x' : l.keys.some((k) => k.chip === 'Ctrl+C') ? 'w' : '';
  }
  return lines.filter((l) => l.keys.length);
}

/** Texte d'une ligne pour la transcription : les passages effacés sont entre ~tildes~. */
export function lineText(l: Line): string {
  let out = '';
  let erased = false;
  for (const k of l.keys) {
    const gone = k.gone !== undefined;
    if (gone !== erased) { out += '~'; erased = gone; }
    out += k.text ?? `[${k.chip}]`;
  }
  return erased ? `${out}~` : out;
}
