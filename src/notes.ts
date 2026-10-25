// Notes Markdown d'une session : panneau de droite, aperçu ou édition, enregistrement automatique.
import { openUrl } from '@tauri-apps/plugin-opener';
import { errorText, notes } from './api';
import { h, icon } from './dom';
import { renderMarkdown, toggleTask } from './markdown';

const PLACEHOLDER = `# Notes sur ce serveur

- Rôle, contacts, procédures…
- [ ] Case à cocher

\`\`\`
commande à envoyer au terminal (clic sur le bloc)
\`\`\``;

export class NotesPanel {
  readonly el = h('section', { class: 'notes-panel', 'aria-label': 'Notes de la session' });
  private text = '';
  private editing = false;
  private loaded = false;
  private saveTimer = 0;
  private readonly status = h('span', { class: 'muted small grow' });
  private readonly body = h('div', { class: 'notes-body' });

  constructor(
    private readonly sessionId: string,
    private readonly title: string,
    private readonly toast: (m: string, k?: 'info' | 'error') => void,
    /** Envoie un bloc de code au terminal de l'onglet. */
    private readonly send: ((text: string) => void) | null,
    private readonly onChange: (hasNote: boolean) => void,
  ) {
    this.load();
  }

  private async load() {
    try {
      this.text = await notes.get(this.sessionId);
      this.loaded = true;
      this.editing = !this.text;
      this.render();
    } catch (e) {
      this.el.replaceChildren(h('p', { class: 'form-error', style: 'padding: 12px' }, errorText(e)));
    }
  }

  private save() {
    window.clearTimeout(this.saveTimer);
    this.status.textContent = 'Enregistrement…';
    this.saveTimer = window.setTimeout(async () => {
      try {
        await notes.set(this.sessionId, this.text);
        this.status.textContent = 'Enregistré';
        this.onChange(!!this.text.trim());
      } catch (e) {
        this.status.textContent = '';
        this.toast(errorText(e), 'error');
      }
    }, 500);
  }

  /** Enregistre tout de suite (fermeture de l'onglet). */
  flush() {
    if (!this.saveTimer || !this.loaded) return;
    window.clearTimeout(this.saveTimer);
    notes.set(this.sessionId, this.text).catch(() => {});
  }

  private render() {
    const toggle = h('button', {
      type: 'button', class: 'btn sm', title: this.editing ? 'Afficher le rendu' : 'Modifier la note (Markdown)',
      onclick: () => { this.editing = !this.editing; this.render(); },
    }, icon(this.editing ? 'check' : 'edit', 14), this.editing ? 'Terminé' : 'Modifier');

    if (this.editing) {
      const area = h('textarea', { class: 'notes-editor', spellcheck: 'true', placeholder: PLACEHOLDER, 'aria-label': 'Texte de la note (Markdown)' });
      area.value = this.text;
      area.addEventListener('input', () => { this.text = area.value; this.save(); });
      area.addEventListener('keydown', (e) => {
        // Tab insère une indentation au lieu de quitter le champ.
        if (e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
          area.dispatchEvent(new Event('input'));
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          this.editing = false; this.render();
        }
      });
      this.body.replaceChildren(area);
      requestAnimationFrame(() => area.focus());
    } else {
      const view = h('div', { class: 'notes-view md' });
      view.innerHTML = this.text.trim() ? renderMarkdown(this.text) : '';
      if (!this.text.trim()) view.append(h('p', { class: 'muted' }, 'Pas encore de note. « Modifier » pour en écrire une.'));
      view.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const link = target.closest('a');
        if (link) { e.preventDefault(); openUrl(link.href).catch((err) => this.toast(errorText(err), 'error')); return; }
        if (target instanceof HTMLInputElement && target.dataset.task) {
          this.text = toggleTask(this.text, Number(target.dataset.task));
          this.save();
          return;
        }
        const code = target.closest('pre.md-code');
        if (code && this.send) {
          const text = code.textContent ?? '';
          this.send(text.endsWith('\n') ? text : `${text}\n`);
          this.toast('Commande envoyée au terminal');
        }
      });
      for (const pre of view.querySelectorAll('pre.md-code')) {
        (pre as HTMLElement).title = this.send ? 'Cliquer pour envoyer au terminal' : '';
        if (this.send) pre.classList.add('sendable');
      }
      view.addEventListener('dblclick', (e) => {
        if (!(e.target as HTMLElement).closest('a, pre, input')) { this.editing = true; this.render(); }
      });
      this.body.replaceChildren(view);
    }
    this.el.replaceChildren(
      h('header', { class: 'notes-head' }, icon('edit', 14), h('strong', { class: 'grow ellipsis' }, `Notes · ${this.title}`), toggle),
      this.body,
      h('footer', { class: 'notes-foot' }, this.status,
        h('span', { class: 'muted small' }, this.editing ? 'Markdown · Échap pour l\'aperçu' : 'Double-clic pour modifier')));
  }
}
