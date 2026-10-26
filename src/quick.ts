// Connexion rapide : « ssh deploy@10.0.1.12 », « rdp srv-01 », « https://nas:5001 »…
import { h, icon } from './dom';

export interface QuickTarget {
  protocol: string;
  /** Nom affiché dans l'onglet. */
  name: string;
  values: Record<string, unknown>;
}

const KEYWORDS: Record<string, string> = {
  ssh: 'ssh', sftp: 'ssh', rdp: 'rdp', mstsc: 'rdp', vnc: 'vnc', telnet: 'telnet', serial: 'serial', com: 'serial',
};

/** « user@hôte:port » → morceaux (IPv6 entre crochets accepté). */
function splitTarget(text: string): { user?: string; host: string; port?: number } | null {
  let rest = text.trim();
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at > 0) { user = rest.slice(0, at); rest = rest.slice(at + 1); }
  let host = rest;
  let port: number | undefined;
  const v6 = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) { host = v6[1]; port = v6[2] ? Number(v6[2]) : undefined; }
  else {
    const m = rest.match(/^([^:\s]+)(?::(\d+))?$/);
    if (!m) return null;
    host = m[1];
    port = m[2] ? Number(m[2]) : undefined;
  }
  if (!host || !/^[\w.\-:]+$/.test(host)) return null;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  return { user, host, port };
}

/** Comprend la saisie, ou renvoie null si ce n'est pas une connexion rapide. */
export function parseQuick(input: string): QuickTarget | null {
  const text = input.trim();
  if (!text) return null;

  // « ssh -J bastion user@hôte » (ou -J à la fin) : serveur de rebond, comme OpenSSH.
  const before = text.match(/^(?:ssh\s+)?-J\s+(\S+)\s+(\S+)$/i);
  const after = text.match(/^ssh\s+(\S+)\s+-J\s+(\S+)$/i);
  if (before || after) {
    const [jump, target] = before ? [before[1], before[2]] : [after![2], after![1]];
    const t = parseQuick(`ssh ${target}`);
    return t && { ...t, name: `${t.name} via ${jump}`, values: { ...t.values, jump } };
  }

  // Adresse web
  if (/^https?:\/\/\S+$/i.test(text)) {
    try {
      const url = new URL(text);
      return { protocol: 'web', name: url.host, values: { url: text } };
    } catch { return null; }
  }

  // ftp://user@hôte, ftps://hôte:2121
  const ftp = text.match(/^(ftps?):\/\/(.+?)\/?$/i);
  if (ftp) {
    const t = splitTarget(ftp[2]);
    if (!t) return null;
    const values: Record<string, unknown> = { host: t.host, security: ftp[1].toLowerCase() === 'ftps' ? 'explicit' : 'none' };
    if (t.port) values.port = t.port;
    if (t.user) values.username = t.user;
    return { protocol: 'ftp', name: `${ftp[1].toLowerCase()}://${t.user ? `${t.user}@` : ''}${t.host}${t.port ? `:${t.port}` : ''}`, values };
  }

  // ssh://user@hôte:port, rdp://hôte…
  const scheme = text.match(/^(ssh|rdp|vnc|telnet):\/\/(.+)$/i);
  const [keyword, target] = scheme
    ? [scheme[1].toLowerCase(), scheme[2].replace(/\/$/, '')]
    : (() => {
        const parts = text.split(/\s+/);
        return parts.length === 2 && KEYWORDS[parts[0].toLowerCase()] ? [parts[0].toLowerCase(), parts[1]] : ['', text];
      })();

  // Port série : « serial COM3 », « COM3 », « com3@9600 »
  const com = (keyword === 'serial' || keyword === 'com' || !keyword) && target.match(/^(com\d+)(?:@(\d+))?$/i);
  if (com) {
    return { protocol: 'serial', name: com[1].toUpperCase(), values: { port: com[1].toUpperCase(), baud: com[2] ?? '115200' } };
  }

  const protocol = KEYWORDS[keyword] ?? '';
  // Sans mot-clé, seule la forme « user@hôte » est comprise (SSH) : un simple mot reste une recherche.
  if (!protocol && !target.includes('@')) return null;
  const t = splitTarget(target);
  if (!t) return null;
  const proto = protocol || 'ssh';
  const values: Record<string, unknown> = { host: t.host };
  if (t.port) values.port = t.port;
  if (t.user) values.username = t.user;
  // Clé par défaut puis agent ; un mot de passe est demandé si les deux échouent.
  if (proto === 'ssh') values.auth = 'auto';
  if (proto === 'rdp') values.client = 'tab';
  const name = `${t.user ? `${t.user}@` : ''}${t.host}${t.port ? `:${t.port}` : ''}`;
  return { protocol: proto, name, values };
}

/** Texte d'aide affiché sous la barre de connexion rapide. */
export const QUICK_HELP = 'adresse seule (fenêtre de connexion) · ssh user@hôte[:port] · ssh -J bastion user@hôte · rdp hôte · vnc hôte:5901 · telnet hôte · https://adresse · ftps://user@hôte · COM3@9600';

// ---------- Historique des connexions rapides ----------

const HISTORY_KEY = 'termoria.quickHistory';
const HISTORY_MAX = 8;

export function quickHistory(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

export function rememberQuick(input: string) {
  const text = input.trim();
  const list = [text, ...quickHistory().filter((x) => x !== text)].slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* stockage indisponible */ }
}

export function forgetQuick(input: string) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(quickHistory().filter((x) => x !== input))); } catch { /* idem */ }
}

// ---------- Palette globale (Ctrl+Maj+O) ----------

export interface PaletteEntry {
  label: string;
  /** Texte secondaire (dossier, commande…). */
  hint?: string;
  /** Groupe affiché à droite : Session, Shell local, Action… */
  group: string;
  icon: string;
  /** Mots supplémentaires pour la recherche (hôte, étiquettes…). */
  keywords?: string;
  action: () => void;
}

/** Score de correspondance simple : préfixe > mot > sous-chaîne > lettres dans l'ordre. */
function score(q: string, text: string): number {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.includes(` ${q}`) || t.includes(`/${q}`) || t.includes(`@${q}`)) return 3;
  if (t.includes(q)) return 2;
  let i = 0;
  for (const c of t) if (c === q[i]) i++;
  return i === q.length ? 1 : 0;
}

export function openCommandPalette(entries: PaletteEntry[], onQuick: (target: QuickTarget, input: string) => void, initial = '', onAddress?: (address: string) => void) {
  const input = h('input', {
    type: 'search', class: 'palette-input', value: initial, spellcheck: 'false',
    placeholder: 'Session, shell, action… ou connexion rapide : ssh user@hôte', 'aria-label': 'Rechercher ou se connecter',
  });
  const results = h('div', { class: 'palette-list', role: 'listbox' });
  let shown: PaletteEntry[] = [];
  let index = 0;

  const quickEntry = (text: string, target: QuickTarget, recent = false): PaletteEntry => ({
    label: recent ? text : `Connexion rapide : ${target.name}`,
    hint: recent ? `${target.protocol.toUpperCase()} · récent` : `${target.protocol.toUpperCase()} · non enregistrée`,
    group: 'Connexion rapide', icon: target.protocol === 'web' ? 'web' : target.protocol === 'rdp' || target.protocol === 'vnc' ? 'desktop' : 'link',
    action: () => { rememberQuick(text); onQuick(target, text); },
  });

  const render = () => {
    const raw = input.value.trim();
    const q = raw.toLowerCase();
    const quick = parseQuick(raw);
    const recent = quickHistory()
      .filter((x) => !q || score(q, x) > 0)
      .map((x) => [x, parseQuick(x)] as const)
      .filter((pair): pair is readonly [string, QuickTarget] => !!pair[1] && pair[0] !== raw)
      .slice(0, q ? 3 : 5)
      .map(([x, t]) => quickEntry(x, t, true));
    const matched = q
      ? entries
          .map((e) => ({ e, s: Math.max(score(q, e.label), score(q, `${e.hint ?? ''} ${e.keywords ?? ''}`) - 1) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.e)
      : entries;
    const address: PaletteEntry[] = !quick && onAddress && looksLikeAddress(raw)
      ? [{ label: `Se connecter à ${raw}…`, hint: 'identifiant et mot de passe saisis à la main', group: 'Connexion rapide', icon: 'link', action: () => onAddress(raw) }]
      : [];
    shown = [...(quick ? [quickEntry(raw, quick)] : []), ...address, ...recent, ...matched].slice(0, 60);
    index = Math.min(index, Math.max(0, shown.length - 1));
    results.replaceChildren(...(shown.length
      ? shown.map((e, i) => h('button', {
          class: `palette-item${i === index ? ' selected' : ''}`, role: 'option', 'aria-selected': String(i === index),
          onclick: () => run(e), onmouseenter: () => { index = i; render(); },
        },
          h('span', { class: 'palette-name' }, icon(e.icon, 14), e.label),
          e.hint ? h('span', { class: 'palette-cmd ellipsis' }, e.hint) : h('span', { class: 'palette-cmd' }),
          h('span', { class: 'muted small' }, e.group)))
      : [h('p', { class: 'muted palette-empty' }, `Rien ne correspond. Exemples : ${QUICK_HELP}`)]));
    results.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };

  const run = (e: PaletteEntry) => { dialog.close(); e.action(); };

  input.addEventListener('input', () => { index = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(index + 1, shown.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(index - 1, 0); render(); }
    else if (e.key === 'Enter' && shown[index]) { e.preventDefault(); run(shown[index]); }
    else if (e.key === 'Delete' && e.shiftKey && shown[index]?.group === 'Connexion rapide') {
      // Maj+Suppr : retirer une entrée de l'historique
      e.preventDefault(); forgetQuick(shown[index].label); render();
    }
  });

  const dialog = h('dialog', { class: 'dialog palette', 'aria-label': 'Palette de commandes' },
    input, results,
    h('footer', { class: 'palette-foot' },
      h('span', { class: 'muted small grow' }, '↑↓ choisir · Entrée ouvrir · Maj+Suppr oublier un récent · Échap fermer')));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  render();
  input.focus();
  input.select();
}

// ---------- Identifiants d'une connexion rapide ----------

/** Demande l'identifiant (si absent) et le mot de passe. Rien n'est enregistré. */
export function askCredentials(target: QuickTarget, reason: string, passwordOptional = false): Promise<{ username: string; password: string } | null> {
  return new Promise((resolve) => {
    const knownUser = typeof target.values.username === 'string' ? target.values.username : '';
    const user = h('input', { type: 'text', value: knownUser, required: true, spellcheck: 'false', autocomplete: 'off' });
    const pass = h('input', { type: 'password', required: !passwordOptional, autocomplete: 'off' });
    let result: { username: string; password: string } | null = null;
    const form = h('form', { method: 'dialog' },
      h('header', { class: 'dlg-head' }, h('h2', {}, `Connexion à ${target.values.host ?? target.name}`)),
      h('div', { class: 'dlg-body' },
        h('p', { class: 'muted small', style: 'margin: 0; white-space: pre-line' }, reason),
        h('label', { class: 'fld' }, 'Identifiant', user),
        h('label', { class: 'fld' }, passwordOptional ? 'Mot de passe (vide = clé de la session)' : 'Mot de passe', pass),
        h('p', { class: 'muted small', style: 'margin: 0' }, 'Le mot de passe sert uniquement à cette connexion : il n\'est pas enregistré.')),
      h('footer', { class: 'dlg-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Annuler'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Se connecter')));
    form.addEventListener('submit', () => { result = { username: user.value.trim(), password: pass.value }; });
    const dialog = h('dialog', { class: 'dialog', 'aria-label': 'Identifiants' }, form);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    (knownUser ? pass : user).focus();
  });
}

// ---------- Fenêtre « Connexion rapide » ----------

/** Protocoles proposés, et les identifiants que chacun demande. */
const QUICK_PROTOCOLS: { id: string; label: string; user: boolean; password: boolean }[] = [
  { id: 'ssh', label: 'SSH', user: true, password: true },
  { id: 'rdp', label: 'Bureau à distance', user: true, password: true },
  { id: 'ftp', label: 'FTP / FTPS', user: true, password: true },
  { id: 'vnc', label: 'VNC', user: false, password: true },
  { id: 'telnet', label: 'Telnet', user: false, password: false },
];

/** Adresse seule (IP, nom avec un point, hôte:port) : on propose la fenêtre de connexion rapide. */
export function looksLikeAddress(input: string): boolean {
  const text = input.trim();
  if (!text || /\s/.test(text)) return false;
  const t = splitTarget(text);
  return !!t && (t.port !== undefined || /^[\d.]+$/.test(t.host) || t.host.includes('.') || t.host.includes(':'));
}

/**
 * Connexion sans session enregistrée : protocole, adresse, identifiant et mot de passe
 * saisis à la main. Rien n'est enregistré ; `text` sert à l'historique (sans mot de passe).
 */
export function openQuickConnect(enabled: (protocol: string) => boolean, initial = ''): Promise<{ target: QuickTarget; text: string } | null> {
  return new Promise((resolve) => {
    const choices = QUICK_PROTOCOLS.filter((p) => enabled(p.id));
    if (!choices.length) { resolve(null); return; }
    const first = splitTarget(initial);
    let protocol = choices[0];
    const address = h('input', { type: 'text', required: true, spellcheck: 'false', autocomplete: 'off', placeholder: 'serveur.exemple.fr, 10.0.0.12 ou hôte:port', value: first ? `${first.host}${first.port ? `:${first.port}` : ''}` : initial });
    const user = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', value: first?.user ?? '' });
    const pass = h('input', { type: 'password', autocomplete: 'off' });
    const userField = h('label', { class: 'fld' }, 'Identifiant', user);
    const passHint = h('span', { class: 'muted small' });
    const passField = h('label', { class: 'fld' }, h('span', {}, 'Mot de passe ', passHint), pass);
    const error = h('p', { class: 'form-error', role: 'alert' });
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Protocole' });
    const renderProtocol = () => {
      seg.replaceChildren(...choices.map((p) => h('button', {
        type: 'button', class: `seg-opt${p === protocol ? ' on' : ''}`, role: 'radio', 'aria-checked': String(p === protocol),
        onclick: () => { protocol = p; renderProtocol(); },
      }, p.label)));
      userField.hidden = !protocol.user;
      passField.hidden = !protocol.password;
      passHint.textContent = protocol.id === 'ssh' ? '(vide = clé SSH ou agent)' : '';
    };
    renderProtocol();

    let result: { target: QuickTarget; text: string } | null = null;
    const form = h('form', { method: 'dialog' },
      h('header', { class: 'dlg-head' }, h('h2', {}, 'Connexion rapide')),
      h('div', { class: 'dlg-body' },
        seg,
        h('label', { class: 'fld' }, 'Adresse du serveur', address),
        userField,
        passField,
        error,
        h('p', { class: 'muted small', style: 'margin: 0' }, 'Rien n\'est enregistré : l\'identifiant et le mot de passe servent uniquement à cette connexion. Vous pourrez l\'enregistrer comme session depuis l\'onglet.')),
      h('footer', { class: 'dlg-foot' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Annuler'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Se connecter')));
    form.addEventListener('submit', (e) => {
      const t = splitTarget(address.value);
      const username = (t?.user ?? user.value).trim();
      if (!t) { e.preventDefault(); error.textContent = 'Adresse non comprise. Exemples : 10.0.0.12, serveur.exemple.fr:2222.'; return; }
      if (protocol.user && protocol.id !== 'rdp' && !username) { e.preventDefault(); error.textContent = 'Indiquez l\'identifiant.'; user.focus(); return; }
      const values: Record<string, unknown> = { host: t.host };
      if (t.port) values.port = t.port;
      if (protocol.user && username) values.username = username;
      if (protocol.password && pass.value) values.password = pass.value;
      if (protocol.id === 'ssh') values.auth = pass.value ? 'password' : 'auto';
      if (protocol.id === 'rdp') values.client = 'tab';
      if (protocol.id === 'ftp') values.security = 'explicit';
      const where = `${username && protocol.user ? `${username}@` : ''}${t.host}${t.port ? `:${t.port}` : ''}`;
      const scheme = protocol.id === 'ftp' ? `ftps://${where}` : `${protocol.id} ${where}`;
      result = { target: { protocol: protocol.id, name: where, values }, text: scheme };
    });
    const dialog = h('dialog', { class: 'dialog', 'aria-label': 'Connexion rapide' }, form);
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
    document.body.append(dialog);
    dialog.showModal();
    (address.value ? (user.value ? pass : user) : address).focus();
  });
}
