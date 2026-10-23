// Import (~/.ssh/config, PuTTY, mRemoteNG) et sauvegarde / restauration Termoria.
import { open, save } from '@tauri-apps/plugin-dialog';
import { api, errorText, ImportCandidate, ImportSource } from './api';
import { badge, h, icon } from './dom';

interface SourceInfo {
  id: ImportSource;
  title: string;
  description: string;
  folder: string;
  /** La source est un fichier que l'on peut choisir. */
  file: boolean;
}

const SOURCES: SourceInfo[] = [
  { id: 'ssh-config', title: 'OpenSSH (~/.ssh/config)', description: 'Hôtes, utilisateurs, ports, clés et redirections (LocalForward, DynamicForward).', folder: 'Import SSH', file: true },
  { id: 'putty', title: 'PuTTY', description: 'Sessions SSH et Telnet enregistrées dans PuTTY sur ce PC, avec leurs clés .ppk et tunnels.', folder: 'PuTTY', file: false },
  { id: 'mremoteng', title: 'mRemoteNG (confCons.xml)', description: 'Connexions SSH, RDP, Telnet et web, en gardant l\'arborescence des dossiers.', folder: 'mRemoteNG', file: true },
];

export function openImportExport(done: (message: string) => void, toast: (m: string, k?: 'info' | 'error') => void) {
  const body = h('div', { class: 'dlg-body' });

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'imp-title' },
    h('div', { class: 'snip-dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'imp-title' }, 'Importer / exporter'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => dialog.close() }, icon('close'))),
      body));
  dialog.addEventListener('close', () => dialog.remove());

  const home = async () => {
    const cards = await Promise.all(SOURCES.map(async (src) => {
      const path = h('input', { type: 'text', class: 'imp-path', spellcheck: 'false', 'aria-label': `Fichier ${src.title}` });
      if (src.file) path.value = await api.importDefaultPath(src.id).catch(() => '');
      const folder = h('input', { type: 'text', value: src.folder, 'aria-label': 'Dossier de destination' });
      return h('section', { class: 'ext-fields' },
        h('div', { class: 'ext-head' }, h('h3', {}, src.title)),
        h('p', { class: 'muted small', style: 'margin: 0' }, src.description),
        src.file && h('div', { class: 'imp-file' }, path,
          h('button', {
            type: 'button', class: 'btn', onclick: async () => {
              const picked = await open({ multiple: false, directory: false, title: src.title });
              if (typeof picked === 'string') path.value = picked;
            },
          }, 'Choisir…')),
        h('div', { class: 'imp-actions' },
          h('label', { class: 'imp-folder' }, h('span', { class: 'muted small' }, 'Ranger dans le dossier'), folder),
          h('button', {
            type: 'button', class: 'btn primary',
            onclick: async () => {
              try {
                const found = await api.importPreview(src.id, src.file ? path.value : null, folder.value);
                preview(src, found);
              } catch (e) { toast(errorText(e), 'error'); }
            },
          }, 'Analyser')));
    }));

    body.replaceChildren(
      h('p', { class: 'muted small', style: 'margin: 0' }, 'Les mots de passe ne sont jamais importés ni exportés : ils restent dans le Gestionnaire d\'identifiants Windows.'),
      ...cards,
      h('section', { class: 'ext-fields' },
        h('div', { class: 'ext-head' }, h('h3', {}, 'Sauvegarde Termoria')),
        h('p', { class: 'muted small', style: 'margin: 0' }, 'Un fichier avec toutes vos sessions, dossiers et commandes, pour les sauvegarder ou les copier sur un autre PC.'),
        h('div', { class: 'imp-actions' },
          h('button', {
            type: 'button', class: 'btn', onclick: async () => {
              const date = new Date().toISOString().slice(0, 10);
              const path = await save({ defaultPath: `termoria-sauvegarde-${date}.json`, filters: [{ name: 'Sauvegarde Termoria', extensions: ['json'] }] });
              if (!path) return;
              try {
                const n = await api.exportBackup(path);
                toast(`${n} session(s) exportée(s)`);
              } catch (e) { toast(errorText(e), 'error'); }
            },
          }, icon('download', 14), 'Exporter…'),
          h('button', {
            type: 'button', class: 'btn', onclick: async () => {
              const path = await open({ multiple: false, directory: false, filters: [{ name: 'Sauvegarde Termoria', extensions: ['json'] }] });
              if (typeof path !== 'string') return;
              try {
                const r = await api.importBackup(path);
                dialog.close();
                done(`${r.added} session(s) restaurée(s)${r.skipped ? `, ${r.skipped} déjà présente(s)` : ''}${r.snippets ? `, ${r.snippets} commande(s)` : ''}`);
              } catch (e) { toast(errorText(e), 'error'); }
            },
          }, icon('upload', 14), 'Restaurer…'))));
  };

  const preview = (src: SourceInfo, found: ImportCandidate[]) => {
    const rows = found.map((c) => ({ c, check: h('input', { type: 'checkbox', checked: !c.duplicate && c.session.protocol !== '', disabled: c.session.protocol === '' }) }));
    const importable = rows.filter((r) => !r.check.disabled);
    const count = h('span', {});
    const refresh = () => { count.textContent = `Importer ${importable.filter((r) => r.check.checked).length} session(s)`; };
    rows.forEach((r) => r.check.addEventListener('change', refresh));
    refresh();

    body.replaceChildren(
      h('div', { class: 'ext-head' },
        h('h3', { style: 'margin: 0' }, `${src.title} : ${found.length} session(s) trouvée(s)`),
        h('button', { type: 'button', class: 'btn', onclick: () => home() }, 'Retour')),
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
                  c.duplicate && h('span', { class: 'chip' }, 'déjà présente')),
                h('div', { class: 'muted small ellipsis' }, target, c.session.folder && ` · ${c.session.folder}`),
                c.note && h('div', { class: 'small imp-note' }, c.note)));
          }))
        : h('p', { class: 'muted' }, 'Aucune session trouvée.'),
      h('div', { class: 'imp-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => { const all = importable.some((r) => !r.check.checked); importable.forEach((r) => { r.check.checked = all; }); refresh(); } }, 'Tout cocher / décocher'),
        h('button', {
          type: 'button', class: 'btn primary',
          onclick: async () => {
            const chosen = importable.filter((r) => r.check.checked).map((r) => r.c.session);
            if (!chosen.length) return;
            try {
              const n = await api.importApply(chosen);
              dialog.close();
              done(`${n} session(s) importée(s) depuis ${src.title}`);
            } catch (e) { toast(errorText(e), 'error'); }
          },
        }, count)));
  };

  document.body.append(dialog);
  dialog.showModal();
  home();
}
