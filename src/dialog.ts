// Formulaire « Nouvelle session » : les champs viennent du manifeste de l'extension.
import { api, errorText, Field, Manifest, Session } from './api';
import { h, icon, viewIcon } from './dom';
import { tunnelEditor } from './tunnels';
import { t } from './i18n';

export interface DialogResult {
  session: Session;
  connect: boolean;
}

interface Opts {
  protocols: Manifest[];
  folders: string[];
  existing?: Session;
  defaultFolder?: string;
  /** Titre de la fenêtre (sinon « Nouvelle session » ou « Modifier la session »). */
  title?: string;
}

export function openSessionDialog({ protocols, folders, existing, defaultFolder, title }: Opts): Promise<DialogResult | null> {
  return new Promise((resolve) => {
    let protocol = protocols.find((p) => p.id === existing?.protocol) ?? protocols[0];
    // Valeurs saisies, conservées quand on change de protocole.
    const values: Record<string, unknown> = { ...(existing?.values ?? {}) };
    const secrets: Record<string, string> = {};

    const nameInput = h('input', { type: 'text', required: true, value: existing?.name ?? '', placeholder: 'srv-web-01' });
    const folderInput = h('input', { type: 'text', list: 'folders-list', value: existing?.folder ?? defaultFolder ?? '', placeholder: 'Production' });
    const tagsInput = h('input', { type: 'text', value: existing?.tags.join(', ') ?? '', placeholder: 'linux, nginx' });
    const datalist = h('datalist', { id: 'folders-list' }, ...folders.map((f) => h('option', { value: f })));
    const picker = h('div', { class: 'proto-grid', role: 'radiogroup', 'aria-label': t('Protocol', 'Protocole') });
    const fieldsBox = h('section', { class: 'ext-fields' });
    const error = h('p', { class: 'form-error', role: 'alert' });

    const fieldValue = (f: Field) => (f.key in values ? values[f.key] : f.default);
    const filled = (key: string) => String(values[key] ?? '').trim() !== '';
    const visible = (f: Field) =>
      !(f.hiddenBy && filled(f.hiddenBy))
      && (!f.showIf || matches(String(fieldValue(protocol.fields.find((x) => x.key === f.showIf!.key)!) ?? ''), f.showIf.equals));
    // « !x » : toute valeur sauf x.
    const matches = (value: string, equals: string) => (equals.startsWith('!') ? value !== equals.slice(1) : value === equals);

    function renderPicker() {
      picker.replaceChildren(
        ...protocols.map((p) =>
          h('button', {
            type: 'button', role: 'radio', 'aria-checked': String(p.id === protocol.id),
            class: `proto${p.id === protocol.id ? ' selected' : ''}`,
            onclick: () => { protocol = p; renderPicker(); renderFields(); },
          }, icon(viewIcon(p.view), 20), p.name),
        ),
      );
    }

    function renderInput(f: Field): HTMLElement {
      const current = fieldValue(f);
      const set = (v: unknown) => {
        // Champ « identifiants partagés » : on ne redessine que s'il passe de vide à rempli (ou l'inverse), pour garder le focus.
        const wasFilled = filled(f.key);
        values[f.key] = v;
        if (protocol.fields.some((x) => x.showIf?.key === f.key) || (protocol.fields.some((x) => x.hiddenBy === f.key) && wasFilled !== filled(f.key))) {
          renderFields();
          if (f.kind.type !== 'choice' && f.kind.type !== 'bool') fieldsBox.querySelector<HTMLInputElement>(`[data-key="${f.key}"]`)?.focus();
        }
      };
      switch (f.kind.type) {
        case 'bool':
          return h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: Boolean(current), onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }),
            f.label);
        case 'choice':
          return h('fieldset', { class: 'fld' }, h('legend', {}, f.label),
            h('div', { class: 'seg' }, ...f.kind.options.map((o) =>
              h('label', { class: `seg-opt${String(current) === o.value ? ' on' : ''}` },
                h('input', { type: 'radio', name: `f-${f.key}`, value: o.value, checked: String(current) === o.value, onchange: () => set(o.value) }),
                o.label))));
        case 'tunnels':
          return tunnelEditor(current, (list) => { values[f.key] = list.map((t) => ({ ...t })); });
        case 'secret': {
          const saved = existing?.protocol === protocol.id && existing.secretKeys.includes(f.key);
          return h('label', { class: 'fld' }, f.label,
            h('input', {
              type: 'password', autocomplete: 'new-password', value: secrets[f.key] ?? '',
              placeholder: saved ? t('•••••••• saved — leave empty to keep', '•••••••• enregistré — laisser vide pour conserver') : '',
              oninput: (e: Event) => { secrets[f.key] = (e.target as HTMLInputElement).value; },
            }));
        }
        default: {
          const isNum = f.kind.type === 'number';
          // Champ « suggest » : texte libre + liste proposée par l'extension (ex. ports COM).
          const listId = f.kind.type === 'suggest' ? `sugg-${f.key}` : undefined;
          const datalist = listId ? h('datalist', { id: listId }) : null;
          if (datalist && f.kind.type === 'suggest') {
            api.fieldSuggestions(protocol.id, f.kind.source)
              .then((opts) => {
                datalist.replaceChildren(...opts.map((o) => h('option', { value: o.value }, o.label)));
                // Un seul choix possible pour un champ obligatoire (ex. un seul port COM) : prérempli.
                if (f.required && !current && opts.length === 1) { values[f.key] = opts[0].value; renderFields(); }
              })
              .catch(() => {});
          }
          return h('label', { class: `fld${isNum ? ' fld-small' : ''}` }, f.label + (f.required ? ' *' : ''),
            h('input', {
              type: isNum ? 'number' : 'text', value: current == null ? '' : String(current), list: listId,
              placeholder: f.placeholder ?? '', spellcheck: 'false', 'data-key': f.key,
              oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; set(isNum && v !== '' ? Number(v) : v); },
            }),
            datalist);
        }
      }
    }

    function renderFields() {
      fieldsBox.replaceChildren(
        h('div', { class: 'ext-head' }, h('h3', {}, t('Connection', 'Connexion')),
          h('span', { class: 'muted' }, `Champs fournis par l'extension ${protocol.name} ${protocol.version}`)),
        h('div', { class: 'ext-grid' }, ...protocol.fields.filter(visible).map(renderInput)),
      );
    }

    function collect(): Session | null {
      const name = nameInput.value.trim();
      if (!name) { error.textContent = t('Give the session a name.', 'Donnez un nom à la session.'); nameInput.focus(); return null; }
      const out: Record<string, unknown> = {};
      for (const f of protocol.fields) {
        if (f.kind.type === 'secret' || !visible(f)) continue;
        const v = fieldValue(f);
        if (f.required && (v == null || String(v).trim() === '')) { error.textContent = `Champ requis : ${f.label}.`; return null; }
        if (v != null && v !== '') out[f.key] = v;
      }
      return {
        id: existing?.id ?? '', name, folder: folderInput.value.trim(), protocol: protocol.id, values: out,
        tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
        secretKeys: existing?.secretKeys ?? [],
      };
    }

    async function submit(connect: boolean) {
      error.textContent = '';
      const session = collect();
      if (!session) return;
      const visibleSecrets = Object.fromEntries(Object.entries(secrets).filter(([k, v]) => v && protocol.fields.some((f) => f.key === k && visible(f))));
      try {
        const saved = await api.saveSession(session, visibleSecrets);
        close({ session: saved, connect });
      } catch (e) {
        error.textContent = errorText(e);
      }
    }

    const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' },
      h('form', { method: 'dialog', onsubmit: (e: Event) => { e.preventDefault(); submit(true); } },
        h('header', { class: 'dlg-head' },
          h('h2', { id: 'dlg-title' }, title ?? (existing ? t('Edit session', 'Modifier la session') : t('New session', 'Nouvelle session'))),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close', 'Fermer'), onclick: () => close(null) }, icon('close'))),
        h('div', { class: 'dlg-body' },
          h('fieldset', { class: 'fld' }, h('legend', {}, t('Protocol', 'Protocole')), picker),
          h('div', { class: 'row2' },
            h('label', { class: 'fld' }, t('Name *', 'Nom *'), nameInput),
            h('label', { class: 'fld' }, t('Folder', 'Dossier'), folderInput, datalist)),
          fieldsBox,
          h('label', { class: 'fld' }, t('Tags (comma-separated)', 'Étiquettes (séparées par des virgules)'), tagsInput),
          error),
        h('footer', { class: 'dlg-foot' },
          h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, t('Cancel', 'Annuler')),
          h('button', { type: 'button', class: 'btn', onclick: () => submit(false) }, t('Save', 'Enregistrer')),
          h('button', { type: 'submit', class: 'btn primary' }, t('Save and connect', 'Enregistrer et se connecter')))));

    function close(result: DialogResult | null) {
      dialog.close();
      dialog.remove();
      resolve(result);
    }
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });

    renderPicker();
    renderFields();
    document.body.append(dialog);
    dialog.showModal();
    nameInput.focus();
  });
}
