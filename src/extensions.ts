import { Manifest } from './api';
import { h, icon, viewIcon } from './dom';
import { t } from './i18n';

const VIEW_LABEL: Record<string, string> = {
  terminal: t('Terminal view', 'Vue terminal'),
  screen: t('Screen in a tab', 'Écran dans un onglet'),
  desktop: t('External application', 'Application externe'),
  web: t('Web view', 'Vue web'),
  files: t('Files in two panes', 'Fichiers en deux volets'),
};

/** Extensions du cœur, qu'on ne peut pas désactiver. */
const CORE = new Set(['local']);

/** Offre où chaque extension du catalogue est comprise (le blocage par offre n'est pas codé). */
const OFFER: Record<string, string> = {
  sftp: t('Free', 'Gratuit'),
  ftp: t('Free', 'Gratuit'),
};

export interface ExtensionHost {
  /** Intégrée d'office, ou prise dans le catalogue. */
  installed: (id: string) => boolean;
  enabled: (id: string) => boolean;
  setEnabled: (id: string, on: boolean) => void;
  /** Catalogue : installer, ou retirer une extension que plus aucune session n'utilise. */
  install: (id: string, on: boolean) => void;
}

/** Page « Extensions » : chaque protocole s'active ou se désactive séparément ; le catalogue propose les autres. */
export function renderExtensions(protocols: Manifest[], usage: Record<string, number>, host: ExtensionHost): HTMLElement {
  const installed = protocols.filter((p) => host.installed(p.id));
  const available = protocols.filter((p) => !host.installed(p.id));
  const active = installed.filter((p) => host.enabled(p.id)).length;
  const list = h('div', { class: 'ext-list' });

  const row = (p: Manifest): HTMLElement => {
    const on = host.enabled(p.id);
    const core = CORE.has(p.id);
    const count = usage[p.id] ?? 0;
    const el = h('div', { class: `ext-row${on ? '' : ' off'}` });
    const toggle = h('button', {
      type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-label': `Activer ${p.name}`,
      disabled: core, title: core ? t('Part of Portunia\'s core', 'Fait partie du cœur de Portunia') : on ? t('Disable', 'Désactiver') : t('Enable', 'Activer'),
      onclick: () => {
        // Désactiver une extension utilisée : on prévient d'abord, dans la ligne.
        if (on && count > 0) return confirmOff();
        host.setEnabled(p.id, !on);
      },
    });
    const confirmOff = () => {
      el.querySelector('.ext-confirm')?.remove();
      const box = h('div', { class: 'ext-confirm', role: 'alert' },
        h('p', {}, t(`${count} ${p.name} session(s) will stay in the tree, greyed out. Right-click one of them › Enable the extension to turn it back on.`, `${count} session(s) ${p.name} resteront dans l'arborescence, grisées. Clic droit sur l'une d'elles › Activer l'extension pour la réactiver.`)),
        h('span', { class: 'ext-confirm-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => box.remove() }, t('Cancel', 'Annuler')),
          h('button', { type: 'button', class: 'btn danger', onclick: () => host.setEnabled(p.id, false) }, t('Disable', 'Désactiver'))));
      el.append(box);
      (box.querySelector('.btn') as HTMLElement).focus();
    };
    // Extension du catalogue que plus aucune session n'utilise : on peut la retirer.
    const remove = p.catalog && count === 0 && h('button', {
      type: 'button', class: 'btn sm', title: t('Back to the catalogue', 'Remettre dans le catalogue'), onclick: () => host.install(p.id, false),
    }, t('Remove', 'Retirer'));
    el.append(
      h('div', { class: `ext-ico badge-${p.id}` }, icon(viewIcon(p.view), 20)),
      h('div', { class: 'ext-meta' },
        h('h4', {}, p.name, h('span', { class: 'ext-tag' }, core ? t('Core', 'Cœur') : p.catalog ? t('Catalogue', 'Catalogue') : p.builtin ? t('Built-in', 'Intégrée') : t('External', 'Externe'))),
        h('p', {}, p.description),
        h('p', { class: 'muted small' }, p.id === 'gate' ? t(`v${p.version} · SSH Gate · its servers are added to the sidebar`, `v${p.version} · Gate SSH · ses serveurs s'ajoutent dans la barre latérale`) : `v${p.version} · ${VIEW_LABEL[p.view] ?? p.view} · ${p.fields.length} champ(s)`)),
      h('div', { class: 'ext-side' },
        h('span', { class: 'ext-count' }, p.id === 'gate' ? `${count} Gate${count > 1 ? 's' : ''}` : `${count} session${count > 1 ? 's' : ''}`),
        remove,
        toggle));
    return el;
  };
  list.append(...installed.map(row));

  const card = (p: Manifest): HTMLElement =>
    h('div', { class: 'cat-card' },
      h('div', { class: 'cat-top' },
        h('div', { class: `ext-ico badge-${p.id}` }, icon(viewIcon(p.view), 20)),
        h('div', { class: 'ext-meta' },
          h('h4', {}, p.name, OFFER[p.id] && h('span', { class: 'ext-tag offer' }, OFFER[p.id])),
          h('p', { class: 'muted small' }, `v${p.version} · ${t('signed by Portunia', 'signée par Portunia')}`))),
      h('p', {}, p.description),
      h('button', { type: 'button', class: 'btn primary', onclick: () => host.install(p.id, true) }, icon('plus', 14), t('Install', 'Installer')));

  return h('div', { class: 'ext-page' },
    h('header', {},
      h('h2', {}, 'Extensions'),
      h('p', { class: 'muted' }, t('Each protocol is an extension. Disable the ones you do not use: they disappear from the menus and from the « New session » window, your sessions are kept.', 'Chaque protocole est une extension. Désactivez celles qui ne vous servent pas : elles disparaissent des menus et de la fenêtre « Nouvelle session », vos sessions sont conservées.'))),
    h('h3', { class: 'label' }, t(`${active} enabled out of ${installed.length}`, `${active} activée(s) sur ${installed.length}`)),
    list,
    h('h3', { class: 'label' }, t('Catalogue', 'Catalogue')),
    available.length
      ? h('div', { class: 'cat-grid' }, ...available.map(card))
      : h('p', { class: 'muted' }, t('Every extension of the catalogue is installed.', 'Toutes les extensions du catalogue sont installées.')),
    h('p', { class: 'muted small' }, t('More to come: WebDAV, Windows shares (SMB), Azure Blob, Google Cloud Storage…', 'À venir : WebDAV, partages Windows (SMB), Azure Blob, Google Cloud Storage…')));
}
