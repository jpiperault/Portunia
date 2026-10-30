// Verrouillage (écran de déverrouillage, inactivité) et licence.
import { errorText, Edition, LicenseStatus, LockStatus, security } from './api';
import { h, icon } from './dom';
import { t } from './i18n';

type Toast = (message: string, kind?: 'info' | 'error') => void;

export const EDITION_LABEL: Record<Edition, string> = { free: t('Free', 'Gratuit'), pro: 'Pro', team: t('Teams', 'Équipes') };

let license: LicenseStatus | null = null;

/** Point de contrôle côté interface (le cœur Rust vérifie aussi). */
export const currentEdition = (): Edition => license?.edition ?? 'free';

export const allows = (feature: string) => license?.features.find((f) => f.feature === feature)?.allowed ?? false;

export async function loadLicense() {
  license = await security.licenseStatus().catch(() => null);
  return license;
}

/** Petite étiquette « PRO » à côté d'une fonctionnalité payante. */
export function proChip(feature: string): HTMLElement | null {
  const f = license?.features.find((x) => x.feature === feature);
  if (!f) return null;
  return h('span', { class: `chip pro${f.allowed ? '' : ' locked'}`, title: f.allowed ? (license?.preview ? t('Included during the preview', 'Inclus pendant l\'avant-première') : t('Included in your licence', 'Inclus dans votre licence')) : t(`Reserved for the ${EDITION_LABEL[f.edition]} edition`, `Réservé à l'édition ${EDITION_LABEL[f.edition]}`) },
    EDITION_LABEL[f.edition].toUpperCase());
}

// ---------- Écran de verrouillage ----------

let overlay: HTMLElement | null = null;
/** Écran de verrouillage affiché. */
export const isLocked = () => overlay !== null;
let lastActivity = Date.now();
let timeoutMinutes = 0;

export async function initLock(onUnlocked: () => void) {
  const status = await security.lockStatus().catch(() => null);
  if (!status) return;
  timeoutMinutes = status.enabled ? status.timeoutMinutes : 0;
  for (const ev of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(ev, () => { lastActivity = Date.now(); }, { capture: true, passive: true });
  }
  // Verrouillage automatique après inactivité.
  setInterval(async () => {
    if (!timeoutMinutes || overlay || Date.now() - lastActivity < timeoutMinutes * 60_000) return;
    try { await security.lockNow(); showLockScreen(onUnlocked); } catch { /* verrouillage désactivé entre-temps */ }
  }, 15_000);
  if (status.locked) showLockScreen(onUnlocked, status);
}

export async function lockNow(toast: Toast, onUnlocked: () => void) {
  try {
    await security.lockNow();
    showLockScreen(onUnlocked);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

async function showLockScreen(onUnlocked: () => void, known?: LockStatus) {
  if (overlay) return;
  const status = known ?? await security.lockStatus();
  const input = h('input', { type: 'password', placeholder: t('Master password', 'Mot de passe maître'), 'aria-label': t('Master password', 'Mot de passe maître'), autocomplete: 'current-password' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  // Tout le reste devient inerte : ni focus, ni clic, ni frappe sous l'écran de verrouillage
  // (sinon Tab ramènerait le curseur dans un terminal ouvert).
  const behind = [...document.body.children].filter((el) => !el.hasAttribute('inert'));
  (document.activeElement as HTMLElement | null)?.blur();
  for (const el of behind) el.setAttribute('inert', '');
  const done = () => {
    for (const el of behind) el.removeAttribute('inert');
    overlay?.remove();
    overlay = null;
    lastActivity = Date.now();
    onUnlocked();
  };
  const unlockButton = h('button', { type: 'submit', class: 'btn primary' }, t('Unlock', 'Déverrouiller'));
  const tryPassword = async () => {
    if (unlockButton.disabled) return;
    error.textContent = '';
    // La vérification du mot de passe est volontairement coûteuse (contre les essais en série).
    unlockButton.disabled = true;
    unlockButton.textContent = t('Unlocking…', 'Déverrouillage…');
    try {
      await security.unlock(input.value);
      done();
    } catch (e) {
      error.textContent = errorText(e);
      input.select();
    } finally {
      unlockButton.disabled = false;
      unlockButton.textContent = t('Unlock', 'Déverrouiller');
    }
  };
  const tryHello = async () => {
    error.textContent = '';
    try {
      if (await security.unlockHello()) done();
      else error.textContent = t('Windows Hello check cancelled.', 'Vérification Windows Hello annulée.');
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPassword(); });

  overlay = h('div', { class: 'lock-screen', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lock-title' },
    h('form', { class: 'lock-card', onsubmit: (e: Event) => { e.preventDefault(); tryPassword(); } },
      h('div', { class: 'lock-icon' }, icon('lock', 28)),
      h('h2', { id: 'lock-title' }, t('Portunia is locked', 'Portunia est verrouillé')),
      h('p', { class: 'muted small' }, t('Open sessions keep running in the background.', 'Les sessions ouvertes continuent de tourner en arrière-plan.')),
      input,
      error,
      unlockButton,
      status.hello && status.helloAvailable && h('button', { type: 'button', class: 'btn', onclick: tryHello }, icon('user', 14), 'Windows Hello')));
  document.body.append(overlay);
  input.focus();
  if (status.hello && status.helloAvailable) tryHello();
}

// ---------- Paramètres : Sécurité et Licence ----------

export function securitySection(toast: Toast, refresh: () => void): HTMLElement {
  const box = h('div', { class: 'settings-block' });
  security.lockStatus().then((s) => render(s)).catch((e) => box.replaceChildren(h('p', { class: 'form-error' }, errorText(e))));

  function render(s: LockStatus) {
    timeoutMinutes = s.enabled ? s.timeoutMinutes : 0;
    const current = h('input', { type: 'password', placeholder: t('Current password', 'Mot de passe actuel'), autocomplete: 'current-password' });
    const next = h('input', { type: 'password', placeholder: t('New password (8 characters min.)', 'Nouveau mot de passe (8 caractères min.)'), autocomplete: 'new-password' });
    const confirm2 = h('input', { type: 'password', placeholder: t('Confirm', 'Confirmer'), autocomplete: 'new-password' });
    const save = async () => {
      if (next.value !== confirm2.value) return toast(t('The two passwords do not match', 'Les deux mots de passe ne correspondent pas'), 'error');
      // Première activation : les données vont être chiffrées, l'oubli du mot de passe serait sans recours.
      if (!s.enabled && !confirm(t('Your sessions, notes and shared credentials will be encrypted on this PC.\n\nIf you forget this password (and without Windows Hello), they will be lost: nobody will be able to recover them. Remember to export a protected backup.\n\nEnable the master password?', 'Vos sessions, notes et identifiants partagés vont être chiffrés sur ce PC.\n\nSi vous oubliez ce mot de passe (et sans Windows Hello), ils seront perdus : personne ne pourra les récupérer. Pensez à exporter une sauvegarde protégée.\n\nActiver le mot de passe maître ?'))) return;
      try { render(await security.lockSetPassword(current.value, next.value)); toast(t('Master password saved', 'Mot de passe maître enregistré')); refresh(); }
      catch (e) { toast(errorText(e), 'error'); }
    };
    box.replaceChildren(...[
      h('p', { class: 'muted small', style: 'margin: 0' }, s.enabled
        ? t('Portunia asks for the master password at startup and after a period of inactivity. Locked, it opens no session and reads no saved password.', 'Portunia demande le mot de passe maître au démarrage et après une période d\'inactivité. Verrouillé, il n\'ouvre aucune session et ne lit aucun mot de passe enregistré.')
        : t('Protect Portunia with a master password: it will be asked at startup and after a period of inactivity, and your data will be encrypted on this PC.', 'Protégez Portunia par un mot de passe maître : il sera demandé au démarrage et après une période d\'inactivité, et vos données seront chiffrées sur ce PC.')),
      s.enabled && h('p', { class: `small ${s.encrypted ? 'muted' : 'form-error'}`, style: 'margin: 0' }, s.encrypted
        ? t('Sessions, notes, shared credentials and server fingerprints are encrypted on this PC (AES-256). Forgotten password and no Windows Hello: they would be lost. Export a protected backup now and then (Import / export).', 'Sessions, notes, identifiants partagés et empreintes des serveurs sont chiffrés sur ce PC (AES-256). Mot de passe oublié et sans Windows Hello : ils seraient perdus. Exportez de temps en temps une sauvegarde protégée (Importer / exporter).')
        : t('Your data will be encrypted at the next unlock with the password.', 'Vos données seront chiffrées au prochain déverrouillage par mot de passe.')),
      h('div', { class: 'pw-grid' }, s.enabled && current, next, confirm2,
        h('button', { type: 'button', class: 'btn', onclick: save }, s.enabled ? t('Change the password', 'Changer le mot de passe') : t('Enable locking', 'Activer le verrouillage'))),
      s.enabled && h('div', { class: 'row2' },
        h('label', { class: 'fld' }, t('Lock after', 'Verrouiller après'),
          h('select', { onchange: async (e: Event) => { try { render(await security.lockSetOptions(s.hello, Number((e.target as HTMLSelectElement).value))); } catch (err) { toast(errorText(err), 'error'); } } },
            ...[[0, t('Never', 'Jamais')], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure']].map(([v, l]) => h('option', { value: String(v), selected: v === s.timeoutMinutes }, String(l))))),
        h('label', { class: `check setting${s.helloAvailable ? '' : ' disabled'}`, title: s.helloAvailable ? '' : t('Windows Hello is not set up on this PC', 'Windows Hello n\'est pas configuré sur ce PC') },
          h('input', { type: 'checkbox', checked: s.hello, disabled: !s.helloAvailable, onchange: async (e: Event) => { try { render(await security.lockSetOptions((e.target as HTMLInputElement).checked, s.timeoutMinutes)); } catch (err) { toast(errorText(err), 'error'); } } }),
          h('span', {}, t('Unlock with Windows Hello', 'Déverrouiller avec Windows Hello'), h('span', { class: 'muted small block' }, t('Face, fingerprint or Windows PIN.', 'Visage, empreinte ou code PIN Windows.'))))),
      s.enabled && h('button', {
        type: 'button', class: 'btn', style: 'align-self: flex-start',
        onclick: async () => {
          const pw = prompt(t('Current master password, to disable locking:', 'Mot de passe maître actuel, pour désactiver le verrouillage :'));
          if (pw === null) return;
          try { render(await security.lockDisable(pw)); toast(t('Locking disabled', 'Verrouillage désactivé')); refresh(); } catch (e) { toast(errorText(e), 'error'); }
        },
      }, t('Disable locking', 'Désactiver le verrouillage'))].filter((n): n is Exclude<typeof n, false> => n !== false));
  }
  return box;
}

export function licenseSection(toast: Toast): HTMLElement {
  const box = h('div', { class: 'settings-block' });
  const render = (s: LicenseStatus) => {
    license = s;
    const text = h('textarea', { class: 'snip-cmd', rows: '3', placeholder: t('Paste here the licence received by e-mail', 'Collez ici la licence reçue par e-mail'), spellcheck: 'false' });
    box.replaceChildren(
      h('div', { class: 'lic-head' },
        h('span', { class: `edition edition-${s.edition}` }, EDITION_LABEL[s.edition]),
        s.license
          ? h('span', { class: 'muted small' }, `${s.license.name} · ${s.license.email}${s.license.expires ? ` · ${s.expired ? t('expired on', 'expirée le') : t('valid until', 'valable jusqu\'au')} ${s.license.expires}` : ''}`)
          : h('span', { class: 'muted small' }, t('No licence', 'Aucune licence')),
        s.preview && h('span', { class: 'chip' }, t('Preview: every feature is unlocked', 'Avant-première : toutes les fonctions sont débloquées'))),
      h('ul', { class: 'lic-features' }, ...s.features.map((f) =>
        h('li', {}, icon(f.allowed ? 'check' : 'lock', 13), f.label, ' ', h('span', { class: 'muted small' }, `(${EDITION_LABEL[f.edition]})`)))),
      s.license
        ? h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: async () => { if (confirm(t('Remove the licence from this PC?', 'Retirer la licence de ce PC ?'))) render(await security.licenseRemove()); } }, t('Remove the licence', 'Retirer la licence'))
        : h('div', { class: 'lic-activate' }, text,
            h('button', { type: 'button', class: 'btn primary', onclick: async () => {
              try { render(await security.licenseActivate(text.value)); toast(t('Licence activated, thank you!', 'Licence activée, merci !')); }
              catch (e) { toast(errorText(e), 'error'); }
            } }, t('Enable', 'Activer'))));
  };
  security.licenseStatus().then(render).catch((e) => box.replaceChildren(h('p', { class: 'form-error' }, errorText(e))));
  return box;
}
