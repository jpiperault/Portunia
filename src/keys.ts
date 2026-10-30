// Assistant de clés SSH : liste de ~/.ssh, création, installation sur le serveur de l'onglet.
import { errorText, KeyInfo, sshKeys } from './api';
import { h, icon } from './dom';
import { t } from './i18n';

interface Opts {
  toast: (m: string, k?: 'info' | 'error') => void;
  /** Connexion SSH ouverte : permet d'installer la clé sur ce serveur. */
  connectionId?: string;
  serverLabel?: string;
  /** Proposé après l'installation : la session utilisera cette clé. */
  onUseKey?: (key: KeyInfo, passphrase: string | null) => void;
}

export function openKeyManager({ toast, connectionId, serverLabel, onUseKey }: Opts) {
  let keys: KeyInfo[] = [];
  /** Phrases secrètes des clés créées dans cette fenêtre (pour la session). */
  const passphrases = new Map<string, string>();
  const listBox = h('div', { class: 'key-list' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  const install = async (key: KeyInfo, button: HTMLButtonElement) => {
    if (!connectionId) return;
    button.disabled = true;
    error.textContent = '';
    try {
      const result = await sshKeys.install(connectionId, key.public);
      toast(result === 'added' ? t(`Key ${key.name} added on ${serverLabel}`, `Clé ${key.name} ajoutée sur ${serverLabel}`) : t(`Key ${key.name} was already installed on ${serverLabel}`, `La clé ${key.name} était déjà installée sur ${serverLabel}`));
      if (onUseKey && confirm(t(`Use key ${key.name} for session « ${serverLabel} »?\nThe password will no longer be asked.`, `Utiliser la clé ${key.name} pour la session « ${serverLabel} » ?\nLe mot de passe ne sera plus demandé.`))) {
        onUseKey(key, passphrases.get(key.path) ?? null);
        dialog.close();
      }
    } catch (e) {
      error.textContent = errorText(e);
    } finally {
      button.disabled = false;
    }
  };

  const renderList = () => {
    listBox.replaceChildren(...(keys.length
      ? keys.map((k) => {
          const installBtn = connectionId
            ? h('button', { type: 'button', class: 'btn primary sm', title: t(`Add this key to ~/.ssh/authorized_keys on ${serverLabel}`, `Ajouter cette clé à ~/.ssh/authorized_keys sur ${serverLabel}`) }, icon('upload', 14), t('Install', 'Installer'))
            : null;
          installBtn?.addEventListener('click', () => install(k, installBtn));
          return h('div', { class: 'key-row' },
            icon('lock', 16),
            h('div', { class: 'grow', style: 'min-width: 0' },
              h('div', { class: 'key-title' }, h('strong', {}, k.name), h('span', { class: 'chip' }, k.algorithm), k.encrypted && h('span', { class: 'chip' }, t('passphrase', 'phrase secrète'))),
              h('div', { class: 'mono muted small ellipsis', title: k.fingerprint }, k.fingerprint),
              k.comment && h('div', { class: 'muted small ellipsis' }, k.comment)),
            h('button', {
              type: 'button', class: 'icon-btn sm', 'aria-label': t(`Copy public key ${k.name}`, `Copier la clé publique ${k.name}`), title: t('Copy the public key', 'Copier la clé publique'),
              onclick: () => navigator.clipboard.writeText(k.public).then(() => toast(t('Public key copied', 'Clé publique copiée'))),
            }, icon('copy', 14)),
            installBtn);
        })
      : [h('p', { class: 'muted', style: 'margin: 0' }, t('No key in ~/.ssh. Create one below.', 'Aucune clé dans ~/.ssh. Créez-en une ci-dessous.'))]));
  };

  const refresh = async () => {
    try { keys = await sshKeys.list(); } catch (e) { error.textContent = errorText(e); }
    renderList();
    if (!keys.length) create.open = true;
    if (!nameInput.value || keys.some((k) => k.name === nameInput.value)) nameInput.value = freeName();
  };

  // ---------- Création ----------
  let kind: 'ed25519' | 'rsa' = 'ed25519';
  const freeName = () => {
    const base = kind === 'rsa' ? 'id_rsa' : 'id_ed25519';
    if (!keys.some((k) => k.name === base)) return base;
    let i = 2;
    while (keys.some((k) => k.name === `${base}_${i}`)) i++;
    return `${base}_${i}`;
  };
  const nameInput = h('input', { type: 'text', spellcheck: 'false', required: true });
  const commentInput = h('input', { type: 'text', spellcheck: 'false' });
  const pass1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: t('Recommended', 'Recommandée') });
  const pass2 = h('input', { type: 'password', autocomplete: 'new-password' });
  sshKeys.defaultComment().then((c) => { if (!commentInput.value) commentInput.value = c; }).catch(() => {});
  const kinds = h('div', { class: 'seg' });
  const renderKinds = () => kinds.replaceChildren(...([['ed25519', t('Ed25519 (recommended)', 'Ed25519 (recommandé)')], ['rsa', 'RSA 4096 (anciens serveurs)']] as const).map(([value, label]) =>
    h('label', { class: `seg-opt${kind === value ? ' on' : ''}` },
      h('input', {
        type: 'radio', name: 'key-kind', value, checked: kind === value,
        onchange: () => {
          const wasFree = !nameInput.value || nameInput.value === freeName();
          kind = value;
          if (wasFree || /^id_(rsa|ed25519)(_\d+)?$/.test(nameInput.value)) nameInput.value = freeName();
          renderKinds();
        },
      }), label)));
  renderKinds();

  const createBtn = h('button', { type: 'button', class: 'btn primary', style: 'align-self: flex-end' }, t('Create the key', 'Créer la clé'));
  createBtn.addEventListener('click', async () => {
    error.textContent = '';
    if (pass1.value !== pass2.value) { error.textContent = t('The two passphrases do not match.', 'Les deux phrases secrètes ne correspondent pas.'); return; }
    createBtn.disabled = true;
    createBtn.textContent = kind === 'rsa' ? t('Creating (a few seconds)…', 'Création (quelques secondes)…') : t('Creating…', 'Création…');
    try {
      const key = await sshKeys.generate(nameInput.value.trim(), kind, commentInput.value, pass1.value || null);
      if (pass1.value) passphrases.set(key.path, pass1.value);
      pass1.value = pass2.value = '';
      toast(t(`Key ${key.name} created in ~/.ssh`, `Clé ${key.name} créée dans ~/.ssh`));
      create.open = false;
      await refresh();
      // Installation directe sur le serveur de l'onglet.
      const btn = connectionId && listBox.querySelectorAll<HTMLButtonElement>('.key-row')[keys.findIndex((k) => k.path === key.path)]?.querySelector<HTMLButtonElement>('.btn.primary');
      if (btn && confirm(t(`Install key ${key.name} on ${serverLabel} now?`, `Installer la clé ${key.name} sur ${serverLabel} maintenant ?`))) install(key, btn);
    } catch (e) {
      error.textContent = errorText(e);
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = t('Create the key', 'Créer la clé');
    }
  });

  const create = h('details', { class: 'shell-add' },
    h('summary', {}, t('Create a new key', 'Créer une nouvelle clé')),
    h('fieldset', { class: 'fld' }, h('legend', {}, 'Type'), kinds),
    h('div', { class: 'row2' },
      h('label', { class: 'fld' }, t('File name (in ~/.ssh)', 'Nom du fichier (dans ~/.ssh)'), nameInput),
      h('label', { class: 'fld' }, t('Comment', 'Commentaire'), commentInput)),
    h('div', { class: 'row2' },
      h('label', { class: 'fld' }, t('Passphrase', 'Phrase secrète'), pass1),
      h('label', { class: 'fld' }, t('Confirmation', 'Confirmation'), pass2)),
    h('p', { class: 'muted small', style: 'margin: 0' }, t('The passphrase protects the key if the file is copied. Without it, anyone who gets the file can connect to your servers.', 'La phrase secrète protège la clé si le fichier est copié. Sans elle, toute personne qui obtient le fichier peut se connecter à vos serveurs.')),
    createBtn);

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'keys-title', style: 'width: min(640px, calc(100vw - 32px))' },
    h('header', { class: 'dlg-head' },
      h('h2', { id: 'keys-title' }, t('SSH keys', 'Clés SSH')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close', 'Fermer'), onclick: () => dialog.close() }, icon('close'))),
    h('div', { class: 'dlg-body' },
      connectionId
        ? h('p', { class: 'muted small', style: 'margin: 0' }, t(`« Install » adds the public key to ~/.ssh/authorized_keys on ${serverLabel}, with the right permissions. After that, no more password needed.`, `« Installer » ajoute la clé publique à ~/.ssh/authorized_keys sur ${serverLabel}, avec les bons droits. Ensuite, plus besoin de mot de passe.`))
        : h('p', { class: 'muted small', style: 'margin: 0' }, t('To install a key on a server, connect first (even with a password), then « SSH key » in the toolbar.', 'Pour installer une clé sur un serveur, connectez-vous d\'abord (même par mot de passe), puis « Clé SSH » dans la barre d\'outils.')),
      listBox, create, error),
    h('footer', { class: 'dlg-foot' }, h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, t('Close', 'Fermer'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  refresh();
}
