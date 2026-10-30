// Shells locaux : section « Ce PC » de la barre latérale et réglages.
import { errorText, shells, ShellSpec } from './api';
import { h, icon } from './dom';
import { settings, updateSettings } from './settings';
import { t } from './i18n';

let detected: ShellSpec[] = [];
let loaded = false;
export const shellsLoaded = () => loaded;

export async function loadShells(): Promise<ShellSpec[]> {
  detected = await shells.detect().catch(() => []);
  loaded = true;
  return detected;
}

/** Shells détectés + personnalisés, y compris les masqués. */
export const allShells = (): ShellSpec[] => [...detected, ...settings().localShells.custom];

export const visibleShells = (): ShellSpec[] => allShells().filter((s) => !settings().localShells.hidden.includes(s.id));

/** Shell par défaut : celui choisi, sinon le premier visible. */
export function defaultShell(): ShellSpec | undefined {
  const list = visibleShells();
  return list.find((s) => s.id === settings().localShells.defaultId) ?? list[0];
}

/** Icône et couleur selon le type de shell. */
export function shellIcon(s: ShellSpec, size = 16): SVGSVGElement {
  const name = s.icon === 'wsl' ? 'wsl' : s.icon === 'git' ? 'git' : s.icon === 'cmd' || s.icon === 'custom' ? 'terminal' : 'prompt';
  const el = icon(name, size);
  el.classList.add(`shell-ico`, `shell-${s.icon || 'custom'}`);
  return el;
}

function setLocal(patch: Partial<ReturnType<typeof settings>['localShells']>) {
  updateSettings({ localShells: { ...settings().localShells, ...patch } });
}

export const setDefaultShell = (id: string) => setLocal({ defaultId: id });
export const hideShell = (id: string) => setLocal({ hidden: [...settings().localShells.hidden, id] });

// ---------- Paramètres › Shells locaux ----------

export function shellSettings(toast: (m: string, k?: 'info' | 'error') => void): HTMLElement {
  const box = h('div', { class: 'settings-block' });

  const render = () => {
    const cfg = settings().localShells;
    const def = defaultShell();
    const rows = allShells().map((s) => {
      const custom = cfg.custom.some((c) => c.id === s.id);
      return h('div', { class: `shell-row${cfg.hidden.includes(s.id) ? ' off' : ''}` },
        h('input', {
          type: 'checkbox', checked: !cfg.hidden.includes(s.id), 'aria-label': `Afficher ${s.name}`,
          onchange: (e: Event) => {
            const show = (e.target as HTMLInputElement).checked;
            setLocal({ hidden: show ? cfg.hidden.filter((x) => x !== s.id) : [...cfg.hidden, s.id] });
            render();
          },
        }),
        shellIcon(s),
        h('div', { class: 'grow', style: 'min-width: 0' },
          h('div', {}, s.name, def?.id === s.id && h('span', { class: 'chip', style: 'margin-left: 8px' }, t('default', 'par défaut'))),
          h('div', { class: 'mono muted small ellipsis', title: `${s.command} ${s.args.join(' ')}` }, `${s.command} ${s.args.join(' ')}`)),
        def?.id !== s.id && h('button', { type: 'button', class: 'btn sm', onclick: () => { setDefaultShell(s.id); render(); } }, t('Default', 'Par défaut')),
        custom && h('button', {
          type: 'button', class: 'icon-btn sm', 'aria-label': `Retirer ${s.name}`, title: t('Remove', 'Retirer'),
          onclick: () => { setLocal({ custom: cfg.custom.filter((c) => c.id !== s.id) }); render(); },
        }, icon('trash', 14)));
    });

    const name = h('input', { type: 'text', placeholder: 'Python 3.13' });
    const command = h('input', { type: 'text', placeholder: 'py.exe', spellcheck: 'false' });
    const args = h('input', { type: 'text', placeholder: '-3.13', spellcheck: 'false' });
    const cwd = h('input', { type: 'text', placeholder: t('Empty: home folder', 'Vide : dossier personnel'), spellcheck: 'false' });

    box.replaceChildren(
      h('p', { class: 'muted small', style: 'margin: 0' }, t('Shells found on this PC. Checked ones appear under « This PC » and in the tabs\' « + » menu. Ctrl+Shift+T opens the default shell.', 'Shells trouvés sur ce PC. Ceux qui sont cochés apparaissent dans « Ce PC » et dans le menu « + » des onglets. Ctrl+Maj+T ouvre le shell par défaut.')),
      ...(rows.length ? rows : [h('p', { class: 'muted' }, t('No shell detected.', 'Aucun shell détecté.'))]),
      h('details', { class: 'shell-add' },
        h('summary', {}, t('Add a custom shell', 'Ajouter un shell personnalisé')),
        h('div', { class: 'row2' },
          h('label', { class: 'fld' }, t('Name', 'Nom'), name),
          h('label', { class: 'fld' }, t('Program', 'Programme'), command)),
        h('div', { class: 'row2' },
          h('label', { class: 'fld' }, 'Arguments', args),
          h('label', { class: 'fld' }, t('Start folder', 'Dossier de départ'), cwd)),
        h('button', {
          type: 'button', class: 'btn primary', style: 'align-self: flex-end',
          onclick: () => {
            if (!name.value.trim() || !command.value.trim()) return toast(t('Give a name and a program', 'Indiquez un nom et un programme'), 'error');
            const spec: ShellSpec = {
              id: `custom:${crypto.randomUUID()}`, name: name.value.trim(), command: command.value.trim(),
              args: splitArgs(args.value), cwd: cwd.value.trim(), icon: 'custom',
            };
            setLocal({ custom: [...cfg.custom, spec] });
            render();
          },
        }, t('Add', 'Ajouter'))),
      h('label', { class: 'check setting' },
        h('input', { type: 'checkbox', checked: cfg.atStartup, onchange: (e: Event) => setLocal({ atStartup: (e.target as HTMLInputElement).checked }) }),
        h('span', {}, t('Open the default shell when Portunia starts', 'Ouvrir le shell par défaut au démarrage de Portunia'), h('span', { class: 'muted small block' }, t('Handy if Portunia replaces Windows Terminal.', 'Pratique si Portunia remplace Windows Terminal.')))));
  };

  if (detected.length) render();
  else loadShells().then(render).catch((e) => box.replaceChildren(h('p', { class: 'form-error' }, errorText(e))));
  return box;
}

/** Découpe une ligne d'arguments en respectant les guillemets doubles. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let has = false;
  for (const c of line) {
    if (c === '"') { quoted = !quoted; has = true; }
    else if (/\s/.test(c) && !quoted) { if (has) { out.push(current); current = ''; has = false; } }
    else { current += c; has = true; }
  }
  if (has) out.push(current);
  return out;
}
