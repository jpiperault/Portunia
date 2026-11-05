// Langue de l'interface : anglais par défaut, français si le système (Windows ou macOS) ou le réglage le demande.
// Chaque texte est écrit dans les deux langues côte à côte : t('English', 'Français').
// Le choix est lu une fois au démarrage ; en changer recharge la fenêtre.

export type Lang = 'en' | 'fr';

/** Réglage « language » : 'auto' (langue du système), 'en' ou 'fr'. */
function chosen(): string {
  try {
    // Clé des réglages (ancien nom du logiciel, gardé) ; lue ici car les textes en dépendent dès le chargement.
    const raw = localStorage.getItem('termoria.settings');
    return (raw && JSON.parse(raw).language) || 'auto';
  } catch {
    return 'auto';
  }
}

function detect(): Lang {
  const pref = chosen();
  if (pref === 'en' || pref === 'fr') return pref;
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const tag = (l || '').toLowerCase();
    if (tag.startsWith('fr')) return 'fr';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

export const LANG: Lang = detect();
export const FR = LANG === 'fr';

/** Le texte dans la langue de l'interface. */
export function t(en: string, fr: string): string {
  return FR ? fr : en;
}

/** Locale des dates et nombres. */
export const LOCALE = FR ? 'fr-FR' : 'en-GB';

document.documentElement.lang = LANG;

// Textes fixes de index.html (écrits en français) : remplacés en anglais.
if (!FR) {
  const set = (selector: string, attrs: Record<string, string>) => {
    const el = document.querySelector(selector);
    if (!el) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v);
    }
  };
  set('.search .sr-only', { text: 'Filter the sessions' });
  set('#search', {
    placeholder: 'Filter, or ssh user@host…',
    title: 'Filter the sessions (Ctrl Shift K); ↓ to browse, Enter opens the first one. « user@host », « rdp host »…: quick connect. Palette: Ctrl Shift O',
  });
  set('.rail', { 'aria-label': 'Activities' });
  set('#manage-shells', { 'aria-label': 'Manage local shells', title: 'Manage local shells' });
  set('#quick-connect', { 'aria-label': 'Quick connect', title: 'Quick connect: address, login and password (Ctrl Shift Q)' });
  set('#new-folder', { 'aria-label': 'New folder', title: 'New folder' });
  set('#new-session', { 'aria-label': 'New session', title: 'New session (Ctrl Shift N)' });
  set('#tabs', { 'aria-label': 'Open sessions' });
  set('#details', { 'aria-label': 'Session details' });
}
