// Verrouillage (écran de déverrouillage, inactivité) et licence.
import { errorText, Edition, LicenseStatus, LockStatus, security } from './api';
import { h, icon } from './dom';

type Toast = (message: string, kind?: 'info' | 'error') => void;

export const EDITION_LABEL: Record<Edition, string> = { free: 'Gratuit', pro: 'Pro', team: 'Équipes' };

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
  return h('span', { class: `chip pro${f.allowed ? '' : ' locked'}`, title: f.allowed ? (license?.preview ? 'Inclus pendant l\'avant-première' : 'Inclus dans votre licence') : `Réservé à l'édition ${EDITION_LABEL[f.edition]}` },
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
  const input = h('input', { type: 'password', placeholder: 'Mot de passe maître', 'aria-label': 'Mot de passe maître', autocomplete: 'current-password' });
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
  const tryPassword = async () => {
    error.textContent = '';
    try {
      await security.unlock(input.value);
      done();
    } catch (e) {
      error.textContent = errorText(e);
      input.select();
    }
  };
  const tryHello = async () => {
    error.textContent = '';
    try {
      if (await security.unlockHello()) done();
      else error.textContent = 'Vérification Windows Hello annulée.';
    } catch (e) {
      error.textContent = errorText(e);
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPassword(); });

  overlay = h('div', { class: 'lock-screen', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lock-title' },
    h('form', { class: 'lock-card', onsubmit: (e: Event) => { e.preventDefault(); tryPassword(); } },
      h('div', { class: 'lock-icon' }, icon('lock', 28)),
      h('h2', { id: 'lock-title' }, 'Termoria est verrouillé'),
      h('p', { class: 'muted small' }, 'Les sessions ouvertes continuent de tourner en arrière-plan.'),
      input,
      error,
      h('button', { type: 'submit', class: 'btn primary' }, 'Déverrouiller'),
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
    const current = h('input', { type: 'password', placeholder: 'Mot de passe actuel', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', placeholder: 'Nouveau mot de passe (8 caractères min.)', autocomplete: 'new-password' });
    const confirm2 = h('input', { type: 'password', placeholder: 'Confirmer', autocomplete: 'new-password' });
    const save = async () => {
      if (next.value !== confirm2.value) return toast('Les deux mots de passe ne correspondent pas', 'error');
      try { render(await security.lockSetPassword(current.value, next.value)); toast('Mot de passe maître enregistré'); refresh(); }
      catch (e) { toast(errorText(e), 'error'); }
    };
    box.replaceChildren(...[
      h('p', { class: 'muted small', style: 'margin: 0' }, s.enabled
        ? 'Termoria demande le mot de passe maître au démarrage et après une période d\'inactivité. Verrouillé, il n\'ouvre aucune session et ne lit aucun mot de passe enregistré.'
        : 'Protégez Termoria par un mot de passe maître : il sera demandé au démarrage et après une période d\'inactivité.'),
      h('div', { class: 'pw-grid' }, s.enabled && current, next, confirm2,
        h('button', { type: 'button', class: 'btn', onclick: save }, s.enabled ? 'Changer le mot de passe' : 'Activer le verrouillage')),
      s.enabled && h('div', { class: 'row2' },
        h('label', { class: 'fld' }, 'Verrouiller après',
          h('select', { onchange: async (e: Event) => { try { render(await security.lockSetOptions(s.hello, Number((e.target as HTMLSelectElement).value))); } catch (err) { toast(errorText(err), 'error'); } } },
            ...[[0, 'Jamais'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 heure']].map(([v, l]) => h('option', { value: String(v), selected: v === s.timeoutMinutes }, String(l))))),
        h('label', { class: `check setting${s.helloAvailable ? '' : ' disabled'}`, title: s.helloAvailable ? '' : 'Windows Hello n\'est pas configuré sur ce PC' },
          h('input', { type: 'checkbox', checked: s.hello, disabled: !s.helloAvailable, onchange: async (e: Event) => { try { render(await security.lockSetOptions((e.target as HTMLInputElement).checked, s.timeoutMinutes)); } catch (err) { toast(errorText(err), 'error'); } } }),
          h('span', {}, 'Déverrouiller avec Windows Hello', h('span', { class: 'muted small block' }, 'Visage, empreinte ou code PIN Windows.')))),
      s.enabled && h('button', {
        type: 'button', class: 'btn', style: 'align-self: flex-start',
        onclick: async () => {
          const pw = prompt('Mot de passe maître actuel, pour désactiver le verrouillage :');
          if (pw === null) return;
          try { render(await security.lockDisable(pw)); toast('Verrouillage désactivé'); refresh(); } catch (e) { toast(errorText(e), 'error'); }
        },
      }, 'Désactiver le verrouillage')].filter((n): n is Exclude<typeof n, false> => n !== false));
  }
  return box;
}

export function licenseSection(toast: Toast): HTMLElement {
  const box = h('div', { class: 'settings-block' });
  const render = (s: LicenseStatus) => {
    license = s;
    const text = h('textarea', { class: 'snip-cmd', rows: '3', placeholder: 'Collez ici la licence reçue par e-mail', spellcheck: 'false' });
    box.replaceChildren(
      h('div', { class: 'lic-head' },
        h('span', { class: `edition edition-${s.edition}` }, EDITION_LABEL[s.edition]),
        s.license
          ? h('span', { class: 'muted small' }, `${s.license.name} · ${s.license.email}${s.license.expires ? ` · ${s.expired ? 'expirée le' : 'valable jusqu\'au'} ${s.license.expires}` : ''}`)
          : h('span', { class: 'muted small' }, 'Aucune licence'),
        s.preview && h('span', { class: 'chip' }, 'Avant-première : toutes les fonctions sont débloquées')),
      h('ul', { class: 'lic-features' }, ...s.features.map((f) =>
        h('li', {}, icon(f.allowed ? 'check' : 'lock', 13), f.label, ' ', h('span', { class: 'muted small' }, `(${EDITION_LABEL[f.edition]})`)))),
      s.license
        ? h('button', { type: 'button', class: 'btn', style: 'align-self: flex-start', onclick: async () => { if (confirm('Retirer la licence de ce PC ?')) render(await security.licenseRemove()); } }, 'Retirer la licence')
        : h('div', { class: 'lic-activate' }, text,
            h('button', { type: 'button', class: 'btn primary', onclick: async () => {
              try { render(await security.licenseActivate(text.value)); toast('Licence activée, merci !'); }
              catch (e) { toast(errorText(e), 'error'); }
            } }, 'Activer')));
  };
  security.licenseStatus().then(render).catch((e) => box.replaceChildren(h('p', { class: 'form-error' }, errorText(e))));
  return box;
}
