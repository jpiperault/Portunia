import { Manifest } from './api';
import { h, icon, viewIcon } from './dom';
import { t } from './i18n';

const VIEW_LABEL: Record<string, string> = {
  terminal: t('Terminal view', 'Vue terminal'),
  screen: t('Screen in a tab', 'Écran dans un onglet'),
  desktop: t('External application', 'Application externe'),
  web: t('Web view', 'Vue web'),
};

/** Extensions du cœur, qu'on ne peut pas désactiver. */
const CORE = new Set(['local']);

/** Page « Extensions » : chaque protocole s'active ou se désactive séparément. */
export function renderExtensions(
  protocols: Manifest[],
  usage: Record<string, number>,
  enabled: (id: string) => boolean,
  setEnabled: (id: string, on: boolean) => void,
): HTMLElement {
  const active = protocols.filter((p) => enabled(p.id)).length;
  const list = h('div', { class: 'ext-list' });

  const row = (p: Manifest): HTMLElement => {
    const on = enabled(p.id);
    const core = CORE.has(p.id);
    const count = usage[p.id] ?? 0;
    const el = h('div', { class: `ext-row${on ? '' : ' off'}` });
    const toggle = h('button', {
      type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': `Activer ${p.name}`,
      disabled: core, title: core ? t('Part of Portunia\'s core', 'Fait partie du cœur de Portunia') : on ? t('Disable', 'Désactiver') : t('Enable', 'Activer'),
      onclick: () => {
        // Désactiver une extension utilisée : on prévient d'abord, dans la ligne.
        if (on && count > 0) return confirmOff();
        setEnabled(p.id, !on);
      },
    });
    const confirmOff = () => {
      el.querySelector('.ext-confirm')?.remove();
      const box = h('div', { class: 'ext-confirm', role: 'alert' },
        h('p', {}, t(`${count} ${p.name} session(s) will stay in the tree, greyed out. Right-click one of them › Enable the extension to turn it back on.`, `${count} session(s) ${p.name} resteront dans l'arborescence, grisées. Clic droit sur l'une d'elles › Activer l'extension pour la réactiver.`)),
        h('span', { class: 'ext-confirm-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => box.remove() }, t('Cancel', 'Annuler')),
          h('button', { type: 'button', class: 'btn danger', onclick: () => setEnabled(p.id, false) }, t('Disable', 'Désactiver'))));
      el.append(box);
      (box.querySelector('.btn') as HTMLElement).focus();
    };
    el.append(
      h('div', { class: `ext-ico badge-${p.id}` }, icon(viewIcon(p.view), 20)),
      h('div', { class: 'ext-meta' },
        h('h4', {}, p.name, h('span', { class: 'ext-tag' }, core ? t('Core', 'Cœur') : p.builtin ? t('Built-in', 'Intégrée') : t('External', 'Externe'))),
        h('p', {}, p.description),
        h('p', { class: 'muted small' }, p.id === 'heimdia' ? t(`v${p.version} · SSH bastion · its servers are added to the sidebar`, `v${p.version} · Bastion SSH · ses serveurs s'ajoutent dans la barre latérale`) : `v${p.version} · ${VIEW_LABEL[p.view] ?? p.view} · ${p.fields.length} champ(s)`)),
      h('div', { class: 'ext-side' },
        h('span', { class: 'ext-count' }, p.id === 'heimdia' ? `${count} bastion${count > 1 ? 's' : ''}` : `${count} session${count > 1 ? 's' : ''}`),
        toggle));
    return el;
  };
  list.append(...protocols.map(row));

  return h('div', { class: 'ext-page' },
    h('header', {},
      h('h2', {}, 'Extensions'),
      h('p', { class: 'muted' }, t('Each protocol is an extension. Disable the ones you do not use: they disappear from the menus and from the « New session » window, your sessions are kept.', 'Chaque protocole est une extension. Désactivez celles qui ne vous servent pas : elles disparaissent des menus et de la fenêtre « Nouvelle session », vos sessions sont conservées.'))),
    h('h3', { class: 'label' }, t(`${active} enabled out of ${protocols.length}`, `${active} activée(s) sur ${protocols.length}`)),
    list,
    h('h3', { class: 'label' }, t('Catalogue', 'Catalogue')),
    h('p', { class: 'muted' }, t('Coming soon: new extensions published and signed by Portunia, installed in one click.', 'Bientôt : de nouvelles extensions publiées et signées par Portunia, à installer en un clic.')));
}
