// Identifiants partagés : un compte utilisé par plusieurs sessions (champ « Identifiants partagés »).
import { open } from '@tauri-apps/plugin-dialog';
import { Credential, credentials, errorText } from './api';
import { h, icon } from './dom';

type Toast = (m: string, k?: 'info' | 'error') => void;

const AUTH_LABEL: Record<Credential['auth'], string> = { password: 'Mot de passe', key: 'Clé privée', agent: 'Agent SSH' };

export function openCredentialManager(toast: Toast, onChange: () => void) {
  const listBox = h('div', { class: 'key-list' });
  const formBox = h('div', {});
  const error = h('p', { class: 'form-error', role: 'alert' });

  const refresh = async () => {
    try {
      const list = await credentials.list();
      listBox.replaceChildren(...(list.length
        ? list.map((c) => h('div', { class: 'key-row' },
            icon(c.auth === 'password' ? 'lock' : c.auth === 'key' ? 'link' : 'user', 16),
            h('div', { class: 'grow', style: 'min-width: 0' },
              h('div', { class: 'key-title' }, h('strong', {}, c.name), h('span', { class: 'chip' }, AUTH_LABEL[c.auth])),
              h('div', { class: 'muted small ellipsis' }, [c.domain && `${c.domain}\\`, c.username || '(utilisateur de la session)'].filter(Boolean).join('')),
              h('div', { class: 'muted small ellipsis', title: c.usedBy.join(', ') },
                c.usedBy.length ? `Utilisé par ${c.usedBy.length} session${c.usedBy.length > 1 ? 's' : ''} : ${c.usedBy.join(', ')}` : 'Utilisé par aucune session')),
            h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Modifier ${c.name}`, title: 'Modifier', onclick: () => edit(c) }, icon('edit', 14)),
            h('button', {
              type: 'button', class: 'icon-btn sm', 'aria-label': `Supprimer ${c.name}`, title: 'Supprimer',
              onclick: async () => {
                if (!confirm(`Supprimer l'identifiant « ${c.name} » et son mot de passe enregistré ?`)) return;
                try { await credentials.remove(c.id); await refresh(); onChange(); } catch (e) { error.textContent = errorText(e); }
              },
            }, icon('trash', 14))))
        : [h('p', { class: 'muted', style: 'margin: 0' }, 'Aucun identifiant partagé. Créez-en un, puis choisissez-le dans le champ « Identifiants partagés » de vos sessions.')]));
    } catch (e) {
      error.textContent = errorText(e);
    }
  };

  const edit = (existing?: Credential) => {
    error.textContent = '';
    let auth: Credential['auth'] = existing?.auth ?? 'password';
    const name = h('input', { type: 'text', value: existing?.name ?? '', placeholder: 'Admin production', required: true });
    const user = h('input', { type: 'text', value: existing?.username ?? '', placeholder: 'admin', spellcheck: 'false' });
    const domain = h('input', { type: 'text', value: existing?.domain ?? '', placeholder: 'Facultatif (RDP) : CORP', spellcheck: 'false' });
    const keyPath = h('input', { type: 'text', value: existing?.keyPath ?? '', placeholder: 'Vide = ~/.ssh/id_ed25519, id_ecdsa ou id_rsa', spellcheck: 'false' });
    const secret = h('input', { type: 'password', autocomplete: 'new-password' });
    const authBox = h('div', {});

    const renderAuth = () => {
      const saved = (key: string) => existing?.auth === auth && existing.secretKeys.includes(key);
      secret.placeholder = saved(auth === 'key' ? 'passphrase' : 'password') ? '•••••••• enregistré — laisser vide pour conserver' : '';
      authBox.replaceChildren(
        h('fieldset', { class: 'fld' }, h('legend', {}, 'Authentification'),
          h('div', { class: 'seg' }, ...(Object.keys(AUTH_LABEL) as Credential['auth'][]).map((a) =>
            h('label', { class: `seg-opt${auth === a ? ' on' : ''}` },
              h('input', { type: 'radio', name: 'cred-auth', value: a, checked: auth === a, onchange: () => { auth = a; renderAuth(); } }),
              AUTH_LABEL[a])))),
        ...(auth === 'password' ? [h('label', { class: 'fld' }, 'Mot de passe', secret)] : []),
        ...(auth === 'key' ? [
          h('div', { class: 'row2' },
            h('label', { class: 'fld' }, 'Fichier de clé privée',
              h('div', { class: 'net-row' }, keyPath,
                h('button', {
                  type: 'button', class: 'btn sm', title: 'Choisir le fichier',
                  onclick: async () => { const p = await open({ multiple: false, directory: false }); if (typeof p === 'string') keyPath.value = p; },
                }, '…'))),
            h('label', { class: 'fld' }, 'Phrase de passe de la clé', secret))] : []),
        ...(auth === 'agent' ? [h('p', { class: 'muted small', style: 'margin: 0' }, 'Les clés chargées dans Pageant ou l\'agent OpenSSH de Windows sont utilisées.')] : []));
    };
    renderAuth();

    formBox.replaceChildren(h('div', { class: 'cred-form' },
      h('h3', { style: 'margin: 0; font-size: 14px' }, existing ? `Modifier « ${existing.name} »` : 'Nouvel identifiant'),
      h('div', { class: 'row2' }, h('label', { class: 'fld' }, 'Nom *', name), h('label', { class: 'fld' }, 'Utilisateur', user)),
      h('label', { class: 'fld' }, 'Domaine Windows', domain),
      authBox,
      h('div', { style: 'display: flex; gap: 8px; justify-content: flex-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => formBox.replaceChildren(addBtn) }, 'Annuler'),
        h('button', {
          type: 'button', class: 'btn primary',
          onclick: async () => {
            error.textContent = '';
            const secrets: Record<string, string> = secret.value ? { [auth === 'key' ? 'passphrase' : 'password']: secret.value } : {};
            try {
              await credentials.save({
                id: existing?.id ?? '', name: name.value, username: user.value.trim(), auth,
                keyPath: auth === 'key' ? keyPath.value.trim() : '', domain: domain.value.trim(), secretKeys: [],
              }, secrets);
              toast(`Identifiant « ${name.value.trim()} » enregistré`);
              formBox.replaceChildren(addBtn);
              await refresh();
              onChange();
            } catch (e) {
              error.textContent = errorText(e);
            }
          },
        }, 'Enregistrer'))));
    name.focus();
  };

  const addBtn = h('button', { type: 'button', class: 'btn', onclick: () => edit() }, icon('plus', 14), 'Nouvel identifiant');
  formBox.append(addBtn);

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'cred-title', style: 'width: min(640px, calc(100vw - 32px))' },
    h('header', { class: 'dlg-head' },
      h('h2', { id: 'cred-title' }, 'Identifiants partagés'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => dialog.close() }, icon('close'))),
    h('div', { class: 'dlg-body' },
      h('p', { class: 'muted small', style: 'margin: 0' }, 'Un même compte pour plusieurs sessions : changez le mot de passe ici, toutes les sessions qui l\'utilisent suivent. Les mots de passe restent dans le Gestionnaire d\'identifiants Windows.'),
      listBox, formBox, error),
    h('footer', { class: 'dlg-foot' }, h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Fermer')));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  refresh();
}
