// Commandes enregistrées : palette (Ctrl+Maj+P) et fenêtre de gestion.
import { api, errorText, Session, Snippet, SnippetScope } from './api';
import { h, icon } from './dom';
import { t } from './i18n';

export interface SnippetContext {
  snippets: Snippet[];
  folders: string[];
  /** Session de l'onglet actif (les commandes proposées dépendent d'elle). */
  session?: Session;
  /** Envoie le texte au terminal actif (ou à tous, en saisie multiple). */
  send(text: string): void;
  /** Recharge la liste après une modification. */
  reload(): Promise<Snippet[]>;
  toast(message: string, kind?: 'info' | 'error'): void;
}

/** Commandes proposées pour une session : globales, de ses dossiers, et les siennes. */
export function applicable(snippets: Snippet[], session?: Session): Snippet[] {
  return snippets
    .filter((s) => {
      if (s.scope.kind === 'all') return true;
      if (!session) return false;
      if (s.scope.kind === 'session') return s.scope.id === session.id;
      return session.folder === s.scope.path || session.folder.startsWith(`${s.scope.path}/`);
    })
    .sort((a, b) => scopeRank(b.scope) - scopeRank(a.scope) || a.name.localeCompare(b.name, 'fr'));
}

const scopeRank = (s: SnippetScope) => (s.kind === 'session' ? 2 : s.kind === 'folder' ? 1 : 0);

export function scopeLabel(scope: SnippetScope, sessions: Session[] = []): string {
  if (scope.kind === 'all') return t('All sessions', 'Toutes les sessions');
  if (scope.kind === 'folder') return t(`Folder ${scope.path}`, `Dossier ${scope.path}`);
  return t(`Session ${sessions.find((s) => s.id === scope.id)?.name ?? '(deleted)'}`, `Session ${sessions.find((s) => s.id === scope.id)?.name ?? '(supprimée)'}`);
}

/** Remplace {{host}}, {{username}}, {{name}}… par les valeurs de la session. */
export function expand(command: string, session?: Session): string {
  if (!session) return command;
  const vars: Record<string, unknown> = { ...session.values, name: session.name, folder: session.folder };
  return command.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, key: string) => (vars[key] != null ? String(vars[key]) : all));
}

/** Texte prêt pour le terminal : retours à la ligne en Entrée, Entrée finale si demandé. */
export function toTerminal(command: string, run: boolean): string {
  let text = command.replace(/\r?\n/g, '\r');
  if (run && !text.endsWith('\r')) text += '\r';
  return text;
}

// ---------- Palette ----------

export function openPalette(ctx: SnippetContext) {
  const list = applicable(ctx.snippets, ctx.session);
  const input = h('input', { type: 'search', class: 'palette-input', placeholder: t('Search for a command…', 'Rechercher une commande…'), 'aria-label': t('Search for a command', 'Rechercher une commande'), spellcheck: 'false' });
  const results = h('div', { class: 'palette-list', role: 'listbox' });
  let shown: Snippet[] = [];
  let index = 0;

  const run = (s: Snippet) => {
    dialog.close();
    ctx.send(toTerminal(expand(s.command, ctx.session), s.run));
  };

  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = list.filter((s) => !q || `${s.name} ${s.command}`.toLowerCase().includes(q));
    index = Math.min(index, Math.max(0, shown.length - 1));
    results.replaceChildren(...(shown.length
      ? shown.map((s, i) => h('button', {
          class: `palette-item${i === index ? ' selected' : ''}`, role: 'option', 'aria-selected': String(i === index),
          onclick: () => run(s), onmouseenter: () => { index = i; render(); },
        },
          h('span', { class: 'palette-name' }, s.name, !s.run && h('span', { class: 'chip' }, t('without Enter', 'sans Entrée'))),
          h('code', { class: 'palette-cmd ellipsis' }, s.command.split('\n')[0] + (s.command.includes('\n') ? ' …' : '')),
          h('span', { class: 'muted small' }, scopeLabel(s.scope))))
      : [h('p', { class: 'muted palette-empty' }, list.length ? t('No matching command.', 'Aucune commande ne correspond.') : t('No saved command for this session.', 'Aucune commande enregistrée pour cette session.'))]));
    results.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => { index = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); index = Math.min(index + 1, shown.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); index = Math.max(index - 1, 0); render(); }
    else if (e.key === 'Enter' && shown[index]) { e.preventDefault(); run(shown[index]); }
  });

  const dialog = h('dialog', { class: 'dialog palette', 'aria-label': t('Saved commands', 'Commandes enregistrées') },
    input, results,
    h('footer', { class: 'palette-foot' },
      h('span', { class: 'muted small grow' }, t('↑↓ choose · Enter send · Esc close', '↑↓ choisir · Entrée envoyer · Échap fermer')),
      h('button', { class: 'btn', onclick: () => { dialog.close(); openSnippetManager(ctx); } }, icon('edit', 14), t('Manage commands', 'Gérer les commandes'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  render();
  input.focus();
}

// ---------- Gestion ----------

export function openSnippetManager(ctx: SnippetContext, editing?: Snippet) {
  let snippets = ctx.snippets;
  const listBox = h('div', { class: 'snip-list' });
  const formBox = h('div', {});
  const sessionsById = ctx.session ? [ctx.session] : [];

  const renderList = () => {
    listBox.replaceChildren(...(snippets.length
      ? [...snippets].sort((a, b) => a.name.localeCompare(b.name, 'fr')).map((s) => h('div', { class: 'snip-row' },
          h('div', { class: 'grow', style: 'min-width: 0' },
            h('div', {}, h('strong', {}, s.name), ' ', h('span', { class: 'muted small' }, `· ${scopeLabel(s.scope, sessionsById)}`)),
            h('code', { class: 'palette-cmd ellipsis block' }, s.command.split('\n')[0])),
          h('button', { class: 'icon-btn sm', 'aria-label': t(`Edit ${s.name}`, `Modifier ${s.name}`), title: t('Edit', 'Modifier'), onclick: () => renderForm(s) }, icon('edit', 14)),
          h('button', {
            class: 'icon-btn sm', 'aria-label': t(`Delete ${s.name}`, `Supprimer ${s.name}`), title: t('Delete', 'Supprimer'),
            onclick: async () => {
              if (!confirm(t(`Delete the command « ${s.name} »?`, `Supprimer la commande « ${s.name} » ?`))) return;
              try { await api.deleteSnippet(s.id); snippets = await ctx.reload(); renderList(); } catch (e) { ctx.toast(errorText(e), 'error'); }
            },
          }, icon('trash', 14))))
      : [h('p', { class: 'muted' }, t('No command yet.', 'Aucune commande pour l\'instant.'))]));
  };

  const renderForm = (s?: Snippet) => {
    const scopes: { label: string; value: SnippetScope }[] = [
      { label: t('All sessions', 'Toutes les sessions'), value: { kind: 'all' } },
      ...(ctx.session ? [{ label: t(`This session: ${ctx.session.name}`, `Cette session : ${ctx.session.name}`), value: { kind: 'session', id: ctx.session.id } as SnippetScope }] : []),
      ...ctx.folders.map((f) => ({ label: t(`Folder: ${f}`, `Dossier : ${f}`), value: { kind: 'folder', path: f } as SnippetScope })),
    ];
    // Une commande d'une autre session garde sa portée même si elle n'est pas dans la liste.
    if (s && !scopes.some((o) => JSON.stringify(o.value) === JSON.stringify(s.scope))) {
      scopes.push({ label: scopeLabel(s.scope), value: s.scope });
    }
    const defaultScope = s?.scope ?? (ctx.session?.folder ? { kind: 'folder', path: ctx.session.folder } : { kind: 'all' });
    const name = h('input', { type: 'text', value: s?.name ?? '', placeholder: t('Restart nginx', 'Redémarrer nginx') });
    const command = h('textarea', { class: 'snip-cmd', rows: '4', spellcheck: 'false', placeholder: 'sudo systemctl restart nginx' });
    command.value = s?.command ?? '';
    const scope = h('select', {}, ...scopes.map((o, i) => h('option', { value: String(i), selected: JSON.stringify(o.value) === JSON.stringify(defaultScope) }, o.label)));
    const run = h('input', { type: 'checkbox', checked: s?.run ?? true });
    const error = h('p', { class: 'form-error' });

    const save = async () => {
      try {
        await api.saveSnippet({ id: s?.id ?? '', name: name.value, command: command.value, scope: scopes[Number(scope.value)].value, run: run.checked });
        snippets = await ctx.reload();
        renderList();
        formBox.replaceChildren();
      } catch (e) {
        error.textContent = errorText(e);
      }
    };

    formBox.replaceChildren(h('section', { class: 'ext-fields' },
      h('div', { class: 'ext-head' }, h('h3', {}, s ? t('Edit the command', 'Modifier la commande') : t('New command', 'Nouvelle commande'))),
      h('label', { class: 'fld' }, t('Name', 'Nom'), name),
      h('label', { class: 'fld' }, t('Command (several lines allowed)', 'Commande (plusieurs lignes possibles)'), command),
      h('p', { class: 'muted small', style: 'margin: 0' }, t('Variables replaced by the session: {{host}}, {{port}}, {{username}}, {{name}}, {{folder}}.', 'Variables remplacées par la session : {{host}}, {{port}}, {{username}}, {{name}}, {{folder}}.')),
      h('label', { class: 'fld' }, t('Offered for', 'Proposée pour'), scope),
      h('label', { class: 'check' }, run, t('Press Enter after the command', 'Appuyer sur Entrée après la commande')),
      error,
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => formBox.replaceChildren() }, t('Cancel', 'Annuler')),
        h('button', { type: 'button', class: 'btn primary', onclick: save }, t('Save', 'Enregistrer')))));
    name.focus();
  };

  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'snip-title' },
    h('div', { class: 'snip-dialog' },
      h('header', { class: 'dlg-head' },
        h('h2', { id: 'snip-title' }, t('Saved commands', 'Commandes enregistrées')),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close', 'Fermer'), onclick: () => dialog.close() }, icon('close'))),
      h('div', { class: 'dlg-body' },
        h('button', { type: 'button', class: 'btn primary', style: 'align-self: flex-start', onclick: () => renderForm() }, icon('plus', 14), t('New command', 'Nouvelle commande')),
        formBox,
        listBox)));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  renderList();
  if (editing) renderForm(editing);
}
