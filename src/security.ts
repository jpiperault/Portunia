// Verrouillage (écran de déverrouillage, inactivité) et licence.
import { invoke } from '@tauri-apps/api/core';
import { errorText, Edition, LicenseStatus, LockStatus, security } from './api';
import { h, icon } from './dom';
import { t } from './i18n';
import { IS_MAC } from './platform';

type Toast = (message: string, kind?: 'info' | 'error') => void;

// ---------- Biométrie : Windows Hello ou Touch ID ----------

export type BiometricKind = 'hello' | 'touchid';

/** Nom du capteur (vide si aucun). */
export const biometricLabel = (kind: BiometricKind | null): string =>
  kind === 'touchid' ? 'Touch ID' : kind === 'hello' ? 'Windows Hello' : '';

/**
 * Option « déverrouiller avec la biométrie » des Paramètres : masquée sans capteur. Si elle est
 * encore active alors que le capteur a disparu, elle reste visible (grisée) pour pouvoir la retirer.
 */
export function biometricOption(kind: BiometricKind | null, enabled: boolean, mac: boolean = IS_MAC): { kind: BiometricKind; disabled: boolean } | null {
  if (kind) return { kind, disabled: false };
  return enabled ? { kind: mac ? 'touchid' : 'hello', disabled: true } : null;
}

/**
 * Action de la case « déverrouiller avec la biométrie ». Sur Mac, l'activer passe par l'invite
 * Touch ID (aucun mot de passe : le coffre est déjà déverrouillé) ; le reste (désactiver, Windows
 * Hello) garde la commande d'options d'origine.
 */
export function biometricToggleAction(mac: boolean, checked: boolean): 'enable-touch-id' | 'set-options' {
  return mac && checked ? 'enable-touch-id' : 'set-options';
}

/** Textes de l'interface pour un capteur (ceux de Windows Hello sont inchangés). */
export function biometricTexts(kind: BiometricKind) {
  const label = biometricLabel(kind);
  const mac = kind === 'touchid';
  return {
    label,
    toggle: t(`Unlock with ${label}`, `Déverrouiller avec ${label}`),
    cancelled: t(`${label} check cancelled.`, `Vérification ${label} annulée.`),
    hint: mac ? t('Fingerprint.', 'Empreinte digitale.') : t('Face, fingerprint or Windows PIN.', 'Visage, empreinte ou code PIN Windows.'),
    unavailable: mac ? t('Touch ID is not set up on this Mac', 'Touch ID n\'est pas configuré sur ce Mac') : t('Windows Hello is not set up on this PC', 'Windows Hello n\'est pas configuré sur ce PC'),
  };
}

/**
 * Après une action qui a échoué, le cœur a pu changer d'état quand même (ex. mot de passe changé
 * mais Touch ID désactivé) : on relit l'état réel et on l'affiche. Un cœur injoignable n'écrase rien.
 */
export async function refreshAfterFailure<T>(load: () => Promise<T>, render: (state: T) => void): Promise<void> {
  try { render(await load()); } catch { /* état inchangé à l'écran */ }
}

/** Capteur disponible et déverrouillage (commandes du cœur ; `unlock_hello` reste l'alias Windows). */
const biometric = {
  kind: () => invoke<BiometricKind | null>('biometric_kind').catch(() => null),
  unlock: () => (IS_MAC ? invoke<boolean>('unlock_biometric') : security.unlockHello()),
  /** macOS : invite Touch ID puis clé rangée dans le Trousseau, sans mot de passe (coffre déverrouillé). */
  enable: (timeoutMinutes: number) => invoke<LockStatus>('enable_touch_id', { timeoutMinutes }),
};

/** Icône empreinte (Touch ID) ou silhouette (Windows Hello). */
function biometricIcon(kind: BiometricKind, size = 14): SVGSVGElement {
  if (kind !== 'touchid') return icon('user', size);
  // Même cadre que les autres icônes (classe .ic), tracé d'empreinte.
  const svg = icon('user', size);
  svg.querySelector('path')?.setAttribute('d', 'M12 4a7 7 0 0 0-7 7v2M12 8a3 3 0 0 0-3 3v3a8 8 0 0 0 1 4M12 12v3a11 11 0 0 0 1.5 5M16 10a4 4 0 0 0-1-2M19 13v-2a7 7 0 0 0-2-5M16 14v1a14 14 0 0 1-1 4');
  return svg;
}

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
  const kind = status.hello && status.helloAvailable ? await biometric.kind() : null;
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
      if (await biometric.unlock()) done();
      else error.textContent = biometricTexts(kind ?? (IS_MAC ? 'touchid' : 'hello')).cancelled;
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
      kind && h('button', { type: 'button', class: 'btn', onclick: tryHello }, biometricIcon(kind), biometricLabel(kind))));
  document.body.append(overlay);
  input.focus();
  if (kind) tryHello();
}

// ---------- Paramètres : Sécurité et Licence ----------

export function securitySection(toast: Toast, refresh: () => void): HTMLElement {
  const box = h('div', { class: 'settings-block' });
  let sensor: BiometricKind | null = null;
  Promise.all([security.lockStatus(), biometric.kind()]).then(([s, k]) => { sensor = k; render(s); }).catch((e) => box.replaceChildren(h('p', { class: 'form-error' }, errorText(e))));

  function render(s: LockStatus) {
    timeoutMinutes = s.enabled ? s.timeoutMinutes : 0;
    const bio = biometricOption(sensor, s.hello);
    const bioTexts = bio && biometricTexts(bio.kind);
    const current =h('input', { type: 'password', placeholder: t('Current password', 'Mot de passe actuel'), autocomplete: 'current-password' });
    const next = h('input', { type: 'password', placeholder: t('New password (8 characters min.)', 'Nouveau mot de passe (8 caractères min.)'), autocomplete: 'new-password' });
    const confirm2 = h('input', { type: 'password', placeholder: t('Confirm', 'Confirmer'), autocomplete: 'new-password' });
    const save = async () => {
      if (next.value !== confirm2.value) return toast(t('The two passwords do not match', 'Les deux mots de passe ne correspondent pas'), 'error');
      // Première activation : les données vont être chiffrées, l'oubli du mot de passe serait sans recours.
      const bioName = IS_MAC ? 'Touch ID' : 'Windows Hello';
      if (!s.enabled && !confirm(t(`Your sessions, notes and shared credentials will be encrypted on this ${IS_MAC ? 'Mac' : 'PC'}.\n\nIf you forget this password (and without ${bioName}), they will be lost: nobody will be able to recover them. Remember to export a protected backup.\n\nEnable the master password?`, `Vos sessions, notes et identifiants partagés vont être chiffrés sur ce ${IS_MAC ? 'Mac' : 'PC'}.\n\nSi vous oubliez ce mot de passe (et sans ${bioName}), ils seront perdus : personne ne pourra les récupérer. Pensez à exporter une sauvegarde protégée.\n\nActiver le mot de passe maître ?`))) return;
      try { render(await security.lockSetPassword(current.value, next.value)); toast(t('Master password saved', 'Mot de passe maître enregistré')); refresh(); }
      catch (e) { toast(errorText(e), 'error'); await refreshAfterFailure(security.lockStatus, render); }
    };
    box.replaceChildren(...[
      h('p', { class: 'muted small', style: 'margin: 0' }, s.enabled
        ? t('Portunia asks for the master password at startup and after a period of inactivity. Locked, it opens no session and reads no saved password.', 'Portunia demande le mot de passe maître au démarrage et après une période d\'inactivité. Verrouillé, il n\'ouvre aucune session et ne lit aucun mot de passe enregistré.')
        : t('Protect Portunia with a master password: it will be asked at startup and after a period of inactivity, and your data will be encrypted on this PC.', 'Protégez Portunia par un mot de passe maître : il sera demandé au démarrage et après une période d\'inactivité, et vos données seront chiffrées sur ce PC.')),
      s.enabled && h('p', { class: `small ${s.encrypted ? 'muted' : 'form-error'}`, style: 'margin: 0' }, s.encrypted
        ? t(`Sessions, notes, shared credentials and server fingerprints are encrypted on this ${IS_MAC ? 'Mac' : 'PC'} (AES-256). Forgotten password and no ${IS_MAC ? 'Touch ID' : 'Windows Hello'}: they would be lost. Export a protected backup now and then (Import / export).`, `Sessions, notes, identifiants partagés et empreintes des serveurs sont chiffrés sur ce ${IS_MAC ? 'Mac' : 'PC'} (AES-256). Mot de passe oublié et sans ${IS_MAC ? 'Touch ID' : 'Windows Hello'} : ils seraient perdus. Exportez de temps en temps une sauvegarde protégée (Importer / exporter).`)
        : t('Your data will be encrypted at the next unlock with the password.', 'Vos données seront chiffrées au prochain déverrouillage par mot de passe.')),
      h('div', { class: 'pw-grid' }, s.enabled && current, next, confirm2,
        h('button', { type: 'button', class: 'btn', onclick: save }, s.enabled ? t('Change the password', 'Changer le mot de passe') : t('Enable locking', 'Activer le verrouillage'))),
      s.enabled && h('div', { class: 'row2' },
        h('label', { class: 'fld' }, t('Lock after', 'Verrouiller après'),
          h('select', { onchange: async (e: Event) => { try { render(await security.lockSetOptions(s.hello, Number((e.target as HTMLSelectElement).value))); } catch (err) { toast(errorText(err), 'error'); await refreshAfterFailure(security.lockStatus, render); } } },
            ...[[0, t('Never', 'Jamais')], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure']].map(([v, l]) => h('option', { value: String(v), selected: v === s.timeoutMinutes }, String(l))))),
        bio && h('label', { class: `check setting${bio.disabled ? ' disabled' : ''}`, title: bio.disabled ? bioTexts?.unavailable : '' },
          h('input', { type: 'checkbox', checked: s.hello, disabled: bio.disabled && !s.hello, onchange: async (e: Event) => { try { const checked = (e.target as HTMLInputElement).checked; render(biometricToggleAction(IS_MAC, checked) === 'enable-touch-id' ? await biometric.enable(s.timeoutMinutes) : await security.lockSetOptions(checked, s.timeoutMinutes)); } catch (err) { toast(errorText(err), 'error'); await refreshAfterFailure(security.lockStatus, render); } } }),
          h('span', {}, bioTexts?.toggle, h('span', { class: 'muted small block' }, bioTexts?.hint)))),
      s.enabled && h('button', {
        type: 'button', class: 'btn', style: 'align-self: flex-start',
        onclick: async () => {
          const pw = prompt(t('Current master password, to disable locking:', 'Mot de passe maître actuel, pour désactiver le verrouillage :'));
          if (pw === null) return;
          try { render(await security.lockDisable(pw)); toast(t('Locking disabled', 'Verrouillage désactivé')); refresh(); } catch (e) { toast(errorText(e), 'error'); await refreshAfterFailure(security.lockStatus, render); }
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
