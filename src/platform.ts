// Plateforme courante (Windows ou macOS) : raccourcis, libellés et chemins locaux.
import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';

/** Repli sur l'agent utilisateur tant que `initPlatform()` n'a pas répondu. */
export let IS_MAC: boolean = /Mac/.test(navigator.userAgent);

/** Interroge le cœur (`platform_os`) ; à appeler avant le premier rendu. */
export async function initPlatform(): Promise<void> {
  try {
    IS_MAC = (await invoke<string>('platform_os')) === 'macos';
  } catch {
    // Hors Tauri (page de démonstration) : on garde le repli.
  }
}

/** Touche de raccourci : Cmd sur Mac, Ctrl ailleurs. */
export function isMod(e: KeyboardEvent | MouseEvent, mac: boolean = IS_MAC): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

export function modLabel(mac: boolean = IS_MAC): string {
  return mac ? '⌘' : 'Ctrl';
}

export function fileManagerName(mac: boolean = IS_MAC): string {
  return mac ? t('Finder', 'Finder') : t('Explorer', 'l\'Explorateur');
}

export function sshAgentNote(mac: boolean = IS_MAC): string {
  return mac
    ? t('Keys loaded in the SSH agent (SSH_AUTH_SOCK, for example the macOS Keychain agent) are used.', 'Les clés chargées dans l\'agent SSH (SSH_AUTH_SOCK, par exemple celui du Trousseau macOS) sont utilisées.')
    : t('Keys loaded in Pageant or the Windows OpenSSH agent are used.', 'Les clés chargées dans Pageant ou l\'agent OpenSSH de Windows sont utilisées.');
}

/** Client Bureau à distance externe : le nom affiché change, la valeur enregistrée non. */
export function externalRdpName(mac: boolean = IS_MAC): string {
  return mac ? 'Windows App (Microsoft)' : 'mstsc';
}

/** Un shell local peut s'ouvrir en administrateur, sauf si le cœur dit `elevatable: false` (absent = oui). */
export function canElevate(shell: object): boolean {
  return (shell as { elevatable?: boolean }).elevatable !== false;
}

type Chord = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

const APP_SHORTCUTS: Record<string, string> = {
  k: 'search-sessions', n: 'new-session', q: 'quick-connect', t: 'local-shell', w: 'close-tab',
  f: 'find', b: 'broadcast', p: 'commands', l: 'lock', o: 'palette',
};

/**
 * Raccourci global de l'application : Ctrl+Maj+lettre sous Windows, ⌘+Maj+lettre sur Mac.
 * Sur Mac, la connexion rapide n'y figure pas (⌘⇧Q déconnecte la session macOS) : elle passe par ⌘K, accélérateur du menu natif.
 */
export function appShortcut(e: Chord, mac: boolean = IS_MAC): string | null {
  if (!(mac ? e.metaKey : e.ctrlKey) || !e.shiftKey) return null;
  const action = APP_SHORTCUTS[e.key.toLowerCase()];
  if (!action || (mac && action === 'quick-connect')) return null;
  return action;
}

/**
 * Touches du terminal : `pass: true` laisse xterm traiter la frappe (donc l'envoyer au shell).
 * Windows : Ctrl+Maj+C/V/F. Mac : ⌘C copie la sélection ; ⌘V n'a pas d'action ici, l'événement `paste` natif
 * (menu Édition) colle, sinon le collage serait fait deux fois ; Ctrl+C reste l'interruption du shell.
 */
export function termShortcut(
  e: Pick<KeyboardEvent, 'type' | 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  mac: boolean,
  hasSelection: boolean,
): { pass: boolean; action?: 'copy' | 'paste' | 'search' } {
  const key = e.key.toLowerCase();
  if (mac && e.metaKey && !e.shiftKey) {
    return e.type === 'keydown' && key === 'c' && hasSelection ? { pass: false, action: 'copy' } : { pass: false };
  }
  if (!((mac ? e.metaKey : e.ctrlKey) && e.shiftKey)) return { pass: true };
  if (e.type !== 'keydown') return { pass: false };
  if (key === 'c' && hasSelection) return { pass: false, action: 'copy' };
  if (key === 'v') return { pass: false, action: 'paste' };
  if (key === 'f') return { pass: false, action: 'search' };
  return { pass: false };
}

const MODIFIER = '(?:Ctrl|Maj|Shift|Alt)';
const COMBO = new RegExp(`(${MODIFIER}(?:[ +]${MODIFIER})*)[ +]([A-Za-z0-9])(?![A-Za-z])`, 'g');

/** Libellé de raccourci : « Ctrl Shift K » devient « ⇧⌘K » sur Mac ; inchangé sous Windows. */
export function keys(label: string, mac: boolean = IS_MAC): string {
  if (!mac) return label;
  // Connexion rapide : ⌘⇧Q est la déconnexion de macOS, le raccourci Mac est ⌘K.
  label = label.replace(/Ctrl[ +](?:Shift|Maj)[ +]Q(?![A-Za-z])/g, '⌘K');
  const symbols = (mods: string) =>
    (/Alt/.test(mods) ? '⌥' : '') + (/Maj|Shift/.test(mods) ? '⇧' : '') + (/Ctrl/.test(mods) ? '⌘' : '');
  return label.replace(COMBO, (_m, mods: string, key: string) => symbols(mods) + key).replace(/Ctrl/g, '⌘');
}

/** Exécute `fn` sauf si l'application est verrouillée ou si une boîte de dialogue est ouverte (même garde que les raccourcis). */
export function runUnlessBusy(doc: Pick<Document, 'querySelector'>, locked: () => boolean, fn: () => void): boolean {
  if (locked() || doc.querySelector('dialog[open]')) return false;
  fn();
  return true;
}

/** Chemin local d'un élément sous une racine : `\` sous Windows (comme avant), `/` sur Mac. */
export function localPathUnder(root: string, parts: string[], mac: boolean = IS_MAC): string {
  const sep = mac ? '/' : '\\';
  return `${root}${sep}${parts.join(sep)}`;
}

/** Libellés du bouton « afficher dans le gestionnaire de fichiers » d'un élément nommé. */
export function revealLabels(name: string, mac: boolean = IS_MAC): { aria: string; title: string } {
  return mac
    ? { aria: t(`Show ${name} in the Finder`, `Afficher ${name} dans le Finder`), title: t('Show in the Finder', 'Afficher dans le Finder') }
    : { aria: t(`Show ${name} in Explorer`, `Afficher ${name} dans l'Explorateur`), title: t('Show in Explorer', 'Afficher dans l\'Explorateur') };
}

/** Passe sur les infobulles de index.html (écrites avec « Ctrl Maj X ») : forme ⌘ sur Mac, rien sous Windows. */
export function localizeShortcutTitles(root: ParentNode, mac: boolean = IS_MAC): void {
  if (!mac) return;
  for (const el of root.querySelectorAll('[title]')) {
    const title = el.getAttribute('title') ?? '';
    const next = keys(title, true);
    if (next !== title) el.setAttribute('title', next);
  }
}

/** Dossier parent d'un chemin local ; sous Windows, '' désigne la liste des lecteurs. */
export function parentDir(path: string, mac: boolean = IS_MAC): string {
  if (mac) {
    const trimmed = path.replace(/\/+$/, '');
    const cut = trimmed.lastIndexOf('/');
    return cut <= 0 ? '/' : trimmed.slice(0, cut);
  }
  return /^[A-Za-z]:\\?$/.test(path) ? '' : path.replace(/[\\/][^\\/]+[\\/]?$/, '').replace(/^([A-Za-z]:)$/, '$1\\');
}

export function joinPath(dir: string, name: string, mac: boolean = IS_MAC): string {
  if (/[\\/]$/.test(dir)) return dir + name;
  return `${dir}${mac ? '/' : '\\'}${name}`;
}

/** Raccourcis du panneau local : sur Mac, la racine et les volumes (pas de lecteurs). Windows : la liste des lecteurs. */
export function places(mac: boolean = IS_MAC): { label: string; path: string }[] {
  return mac ? [{ label: t('Root', 'Racine'), path: '/' }, { label: t('Volumes', 'Volumes'), path: '/Volumes' }] : [];
}

/** Dernier élément d'un chemin local (reçu du glisser-déposer) : « \ » n'est un séparateur que sous Windows. */
export function baseName(path: string, mac: boolean = IS_MAC): string {
  if (!mac) return path.split(/[\\/]/).pop() ?? path;
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** Nom venu d'un serveur, rendu sûr pour le système local (Windows : caractères réservés ; Mac : « / » seulement). */
export function localName(name: string, mac: boolean = IS_MAC): string {
  if (mac) {
    // eslint-disable-next-line no-control-regex
    const cleaned = name.replace(/[/\x00]/g, '_');
    return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return cleaned || '_';
}
