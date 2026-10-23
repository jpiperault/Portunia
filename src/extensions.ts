import { Manifest } from './api';
import { h, icon, viewIcon } from './dom';

const VIEW_LABEL: Record<string, string> = {
  terminal: 'Vue terminal',
  screen: 'Écran dans un onglet',
  desktop: 'Application externe',
  web: 'Vue web',
};

/** Page « Extensions » : les protocoles connus du cœur. */
export function renderExtensions(protocols: Manifest[], usage: Record<string, number>): HTMLElement {
  return h('div', { class: 'ext-page' },
    h('header', {},
      h('h2', {}, 'Extensions'),
      h('p', { class: 'muted' }, 'Chaque protocole est une extension indépendante qui déclare ses champs et sa vue. Le cœur de Termoria ne dépend d\'aucun protocole.')),
    h('h3', { class: 'label' }, `Protocoles installés (${protocols.length})`),
    h('div', { class: 'ext-cards' },
      ...protocols.map((p) =>
        h('article', { class: 'ext-card' },
          h('div', { class: 'ext-card-head' },
            h('div', { class: `ext-ico badge-${p.id}` }, icon(viewIcon(p.view), 20)),
            h('div', {},
              h('h4', {}, p.name),
              h('p', { class: 'muted small' }, `v${p.version} · ${p.builtin ? 'intégrée' : 'externe'} · ${VIEW_LABEL[p.view] ?? p.view}`))),
          h('p', {}, p.description),
          h('div', { class: 'chips' },
            h('span', { class: 'chip' }, `${usage[p.id] ?? 0} session(s)`),
            h('span', { class: 'chip' }, `${p.fields.length} champ(s)`))))),
    h('h3', { class: 'label' }, 'Ajouter un protocole'),
    h('p', { class: 'muted' },
      'Pour l\'instant, un nouveau protocole s\'ajoute en implémentant le trait ',
      h('code', {}, 'Connector'),
      ' dans src-tauri/src/connectors/ puis en l\'enregistrant dans registry.rs. ',
      'Le chargement d\'extensions externes sans recompiler est prévu pour une prochaine version.'));
}
