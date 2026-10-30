// Import (~/.ssh/config, PuTTY, mRemoteNG) et sauvegarde / restauration Portunia.
import { open, save } from '@tauri-apps/plugin-dialog';
import { api, errorText, ImportCandidate, ImportSource } from './api';
import { badge, h, icon } from './dom';
import { t } from './i18n';

interface SourceInfo {
  id: ImportSource;
  title: string;
  description: string;
  folder: string;
  /** La source est un fichier que l'on peut choisir. */
  file: boolean;
}

const SOURCES: SourceInfo[] = [
  { id: 'ssh-config', title: 'OpenSSH (~/.ssh/config)', description: t('Hosts, users, ports, keys and forwards (LocalForward, DynamicForward).', 'Hôtes, utilisateurs, ports, clés et redirections (LocalForward, DynamicForward).'), folder: 'Import SSH', file: true },
  { id: 'putty', title: 'PuTTY', description: t('SSH and Telnet sessions saved in PuTTY on this PC, with their .ppk keys and tunnels.', 'Sessions SSH et Telnet enregistrées dans PuTTY sur ce PC, avec leurs clés .ppk et tunnels.'), folder: 'PuTTY', file: false },
  { id: 'mremoteng', title: 'mRemoteNG (confCons.xml)', description: t('SSH, RDP, Telnet and web connections, keeping the folder tree.', 'Connexions SSH, RDP, Telnet et web, en gardant l\'arborescence des dossiers.'), folder: 'mRemoteNG', file: true },
];

export function openImportExport(done: (message: string) => void, toast: (m: string, k?: 'info' | 'error') => void) {
  const body = h('div', { class: 'dlg-body' });

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'imp-title' },
    h('div', { class: 'snip-dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'imp-title' }, t('Import / export', 'Importer / exporter')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close', 'Fermer'), onclick: () => dialog.close() }, icon('close'))),
      body));
  dialog.addEventListener('close', () => dialog.remove());

  const home = async () => {
    const cards = await Promise.all(SOURCES.map(async (src) => {
      const path = h('input', { type: 'text', class: 'imp-path', spellcheck: 'false', 'aria-label': t(`${src.title} file`, `Fichier ${src.title}`) });
      if (src.file) path.value = await api.importDefaultPath(src.id).catch(() => '');
      const folder = h('input', { type: 'text', value: src.folder, 'aria-label': t('Destination folder', 'Dossier de destination') });
      return h('section', { class: 'ext-fields' },
        h('div', { class: 'ext-head' }, h('h3', {}, src.title)),
        h('p', { class: 'muted small', style: 'margin: 0' }, src.description),
        src.file && h('div', { class: 'imp-file' }, path,
          h('button', {
            type: 'button', class: 'btn', onclick: async () => {
              const picked = await open({ multiple: false, directory: false, title: src.title });
              if (typeof picked === 'string') path.value = picked;
            },
          }, t('Choose…', 'Choisir…'))),
        h('div', { class: 'imp-actions' },
          h('label', { class: 'imp-folder' }, h('span', { class: 'muted small' }, t('Put in the folder', 'Ranger dans le dossier')), folder),
          h('button', {
            type: 'button', class: 'btn primary',
            onclick: async () => {
              try {
                const found = await api.importPreview(src.id, src.file ? path.value : null, folder.value);
                preview(src, found);
              } catch (e) { toast(errorText(e), 'error'); }
            },
          }, t('Analyse', 'Analyser'))));
    }));

    const exportPass = h('input', { type: 'password', autocomplete: 'new-password', placeholder: t('Empty = unencrypted file', 'Vide = fichier en clair') });
    body.replaceChildren(
      h('p', { class: 'muted small', style: 'margin: 0' }, t('Passwords are never imported or exported: they stay in the Windows Credential Manager.', 'Les mots de passe ne sont jamais importés ni exportés : ils restent dans le Gestionnaire d\'identifiants Windows.')),
      ...cards,
      h('section', { class: 'ext-fields' },
        h('div', { class: 'ext-head' }, h('h3', {}, t('Portunia backup', 'Sauvegarde Portunia'))),
        h('p', { class: 'muted small', style: 'margin: 0' }, t('A file with all your sessions, folders, notes and commands, to back them up or copy them to another PC. Protect it with a passphrase: without one, anyone who opens it can read it.', 'Un fichier avec toutes vos sessions, dossiers, notes et commandes, pour les sauvegarder ou les copier sur un autre PC. Protégez-le par une phrase de passe : sans elle, il est lisible par quiconque l\'ouvre.')),
        h('label', { class: 'fld' }, t('Passphrase (recommended, 8 characters min.)', 'Phrase de passe (recommandée, 8 caractères min.)'), exportPass),
        h('div', { class: 'imp-actions' },
          h('button', {
            type: 'button', class: 'btn', onclick: async () => {
              const date = new Date().toISOString().slice(0, 10);
              const path = await save({ defaultPath: `portunia-sauvegarde-${date}.json`, filters: [{ name: t('Portunia backup', 'Sauvegarde Portunia'), extensions: ['json'] }] });
              if (!path) return;
              try {
                const n = await api.exportBackup(path, exportPass.value || null);
                toast(t(`${n} session(s) exported${exportPass.value ? ' (encrypted file)' : ''}`, `${n} session(s) exportée(s)${exportPass.value ? ' (fichier chiffré)' : ''}`));
                exportPass.value = '';
              } catch (e) { toast(errorText(e), 'error'); }
            },
          }, icon('download', 14), t('Export…', 'Exporter…')),
          h('button', {
            type: 'button', class: 'btn', onclick: async () => {
              const path = await open({ multiple: false, directory: false, filters: [{ name: t('Portunia backup', 'Sauvegarde Portunia'), extensions: ['json'] }] });
              if (typeof path !== 'string') return;
              try {
                let r;
                try {
                  r = await api.importBackup(path, null);
                } catch (e) {
                  // Sauvegarde chiffrée : on demande sa phrase de passe.
                  if (!errorText(e).startsWith('PHRASE_REQUISE')) throw e;
                  const pass = await askPassphrase();
                  if (pass === null) return;
                  r = await api.importBackup(path, pass);
                }
                dialog.close();
                done(t(
                  `${r.added} session(s) restored${r.skipped ? `, ${r.skipped} already present` : ''}${r.snippets ? `, ${r.snippets} command(s)` : ''}`,
                  `${r.added} session(s) restaurée(s)${r.skipped ? `, ${r.skipped} déjà présente(s)` : ''}${r.snippets ? `, ${r.snippets} commande(s)` : ''}`));
              } catch (e) { toast(errorText(e), 'error'); }
            },
          }, icon('upload', 14), t('Restore…', 'Restaurer…')))));
  };

  const preview = (src: SourceInfo, found: ImportCandidate[]) => {
    const rows = found.map((c) => ({ c, check: h('input', { type: 'checkbox', checked: !c.duplicate && c.session.protocol !== '', disabled: c.session.protocol === '' }) }));
    const importable = rows.filter((r) => !r.check.disabled);
    const count = h('span', {});
    const refresh = () => { count.textContent = t(`Import ${importable.filter((r) => r.check.checked).length} session(s)`, `Importer ${importable.filter((r) => r.check.checked).length} session(s)`); };
    rows.forEach((r) => r.check.addEventListener('change', refresh));
    refresh();

    body.replaceChildren(
      h('div', { class: 'ext-head' },
        h('h3', { style: 'margin: 0' }, t(`${src.title}: ${found.length} session(s) found`, `${src.title} : ${found.length} session(s) trouvée(s)`)),
        h('button', { type: 'button', class: 'btn', onclick: () => home() }, t('Back', 'Retour'))),
      found.length
        ? h('div', { class: 'imp-list' }, ...rows.map(({ c, check }) => {
            const v = c.session.values;
            const target = String(v.url ?? [v.username && `${v.username}@`, v.host, v.port && `:${v.port}`].filter(Boolean).join(''));
            return h('label', { class: `imp-row${check.disabled ? ' off' : ''}` },
              check,
              h('div', { class: 'grow', style: 'min-width: 0' },
                h('div', { class: 'imp-line' },
                  h('strong', { class: 'ellipsis' }, c.session.name),
                  c.session.protocol && badge(c.session.protocol),
                  c.duplicate && h('span', { class: 'chip' }, t('already present', 'déjà présente'))),
                h('div', { class: 'muted small ellipsis' }, target, c.session.folder && ` · ${c.session.folder}`),
                c.note && h('div', { class: 'small imp-note' }, c.note)));
          }))
        : h('p', { class: 'muted' }, t('No session found.', 'Aucune session trouvée.')),
      h('div', { class: 'imp-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => { const all = importable.some((r) => !r.check.checked); importable.forEach((r) => { r.check.checked = all; }); refresh(); } }, t('Check / uncheck all', 'Tout cocher / décocher')),
        h('button', {
          type: 'button', class: 'btn primary',
          onclick: async () => {
            const chosen = importable.filter((r) => r.check.checked).map((r) => r.c.session);
            if (!chosen.length) return;
            try {
              const n = await api.importApply(chosen);
              dialog.close();
              done(t(`${n} session(s) imported from ${src.title}`, `${n} session(s) importée(s) depuis ${src.title}`));
            } catch (e) { toast(errorText(e), 'error'); }
          },
        }, count)));
  };

  document.body.append(dialog);
  dialog.showModal();
  home();
}

/** Phrase de passe d'une sauvegarde chiffrée (null : annulé). */
function askPassphrase(): Promise<string | null> {
  return new Promise((resolve) => {
    let value: string | null = null;
    const input = h('input', { type: 'password', autocomplete: 'off', 'aria-label': t('Passphrase', 'Phrase de passe') });
    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'pass-title', style: 'width: min(440px, calc(100vw - 32px))' },
      h('form', { method: 'dialog', onsubmit: () => { value = input.value; } },
        h('header', { class: 'dlg-head' }, h('h2', { id: 'pass-title' }, t('Protected backup', 'Sauvegarde protégée'))),
        h('div', { class: 'dlg-body' },
          h('p', { class: 'muted small', style: 'margin: 0' }, t('This backup is encrypted. Type the passphrase chosen at export.', 'Cette sauvegarde est chiffrée. Saisissez la phrase de passe choisie à l’export.')),
          input),
        h('footer', { class: 'dlg-foot' },
          h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, t('Cancel', 'Annuler')),
          h('button', { type: 'submit', class: 'btn primary' }, t('Restore', 'Restaurer')))));
    dialog.addEventListener('close', () => { dialog.remove(); resolve(value); });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}
