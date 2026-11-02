// Toutes les sessions en tableau : recherche, facettes, tri et sélection multiple.
import { Session } from './api';
import { badge, h, icon } from './dom';
import { t } from './i18n';
import { paint } from './theme';

export interface LibraryHost {
  sessions(): Session[];
  isConnected(id: string): boolean;
  isPinned(id: string): boolean;
  /** Adresse affichée (user@hôte, URL…). */
  target(s: Session): string;
  /** Dernière ouverture (horodatage), si elle est connue. */
  lastOpened(id: string): number | undefined;
  folderColor(path: string): string | undefined;
  open(list: Session[]): void;
  edit(s: Session): void;
  /** Commande sur plusieurs serveurs (Pro). */
  multiExec(ids: string[]): void;
  newSession(): void;
}

type Key = 'name' | 'target' | 'protocol' | 'folder' | 'tags' | 'last';

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

export class SessionLibrary {
  readonly el: HTMLElement;
  private q = '';
  private folder: string | null = null;
  private protocol: string | null = null;
  private tag: string | null = null;
  private key: Key = 'folder';
  private dir = 1;
  private readonly selected = new Set<string>();
  private readonly search: HTMLInputElement;
  private readonly count = h('span', { class: 'muted small' });
  private readonly openBtn: HTMLButtonElement;
  private readonly execBtn: HTMLButtonElement;
  private readonly facets = h('aside', { class: 'lib-facets', 'aria-label': t('Filters', 'Filtres') });
  private readonly table = h('div', { class: 'lib-table' });

  constructor(private readonly host: LibraryHost) {
    this.search = h('input', {
      type: 'search', class: 'input', placeholder: t('Name, address, folder, tag…', 'Nom, adresse, dossier, étiquette…'), 'aria-label': t('Search the sessions', 'Chercher dans les sessions'),
      oninput: () => { this.q = this.search.value; this.render(); },
    }) as HTMLInputElement;
    this.openBtn = h('button', { class: 'btn primary', onclick: () => this.host.open(this.picked()) }) as HTMLButtonElement;
    this.execBtn = h('button', { class: 'btn', onclick: () => this.host.multiExec(this.picked().filter((s) => s.protocol === 'ssh').map((s) => s.id)) }, icon('commands', 14), t('Command on the selection', 'Commande sur la sélection')) as HTMLButtonElement;
    this.el = h('div', { class: 'lib' },
      h('div', { class: 'lib-bar' },
        h('label', { class: 'lib-search' }, icon('search', 15), this.search),
        this.count,
        h('div', { class: 'lib-actions' }, this.openBtn, this.execBtn,
          h('button', { class: 'btn', onclick: () => this.host.newSession() }, icon('plus', 14), t('New session', 'Nouvelle session')))),
      h('div', { class: 'lib-body' }, this.facets, this.table));
    this.render();
  }

  focus() {
    this.search.focus();
  }

  private picked(): Session[] {
    return this.host.sessions().filter((s) => this.selected.has(s.id));
  }

  private matches(s: Session, skip?: 'folder' | 'protocol' | 'tag'): boolean {
    if (skip !== 'folder' && this.folder !== null && s.folder !== this.folder && !s.folder.startsWith(`${this.folder}/`)) return false;
    if (skip !== 'protocol' && this.protocol && s.protocol !== this.protocol) return false;
    if (skip !== 'tag' && this.tag && !s.tags.includes(this.tag)) return false;
    const words = this.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [s.name, this.host.target(s), s.folder, s.protocol, ...s.tags].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  private value(s: Session, key: Key): string | number {
    switch (key) {
      case 'name': return s.name;
      case 'target': return this.host.target(s);
      case 'protocol': return s.protocol;
      case 'folder': return s.folder;
      case 'tags': return s.tags.join(' ');
      case 'last': return -(this.host.lastOpened(s.id) ?? 0);
    }
  }

  render() {
    const all = this.host.sessions();
    const ids = new Set(all.map((s) => s.id));
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
    const shown = all.filter((s) => this.matches(s)).sort((a, b) => {
      const va = this.value(a, this.key);
      const vb = this.value(b, this.key);
      const d = typeof va === 'number' && typeof vb === 'number' ? va - vb : collator.compare(String(va), String(vb));
      return d * this.dir || collator.compare(a.name, b.name);
    });
    this.count.textContent = t(`${shown.length} of ${all.length}`, `${shown.length} sur ${all.length}`);
    const n = this.selected.size;
    this.openBtn.replaceChildren(icon('play', 14), n ? t(`Open (${n})`, `Ouvrir (${n})`) : t('Open', 'Ouvrir'));
    this.openBtn.disabled = !n;
    this.execBtn.disabled = !this.picked().some((s) => s.protocol === 'ssh');
    this.renderFacets(all);
    this.renderTable(shown);
  }

  private renderFacets(all: Session[]) {
    const group = (title: string, items: HTMLElement[]) => (items.length ? [h('div', { class: 'tree-section' }, title), ...items] : []);
    const item = (label: string, count: number, on: boolean, pick: () => void, color?: string, depth = 0) => {
      const b = h('button', { type: 'button', class: `lib-facet${on ? ' on' : ''}`, 'aria-pressed': String(on), style: `padding-left: ${8 + depth * 12}px`, onclick: pick },
        h('span', { class: 'grow ellipsis' }, label), h('span', { class: 'count' }, String(count)));
      if (color) paint(b, color);
      return b;
    };
    const folders = [...new Set(all.flatMap((s) => s.folder.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))).filter(Boolean))].sort(collator.compare);
    const protocols = [...new Set(all.map((s) => s.protocol))].sort();
    const tagCount = new Map<string, number>();
    all.forEach((s) => s.tags.forEach((tag) => tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)));
    const tags = [...tagCount.keys()].sort((a, b) => (tagCount.get(b) ?? 0) - (tagCount.get(a) ?? 0)).slice(0, 12);
    const inFolder = (s: Session, f: string) => s.folder === f || s.folder.startsWith(`${f}/`);
    this.facets.replaceChildren(
      ...group(t('Folders', 'Dossiers'), folders.map((f) => item(f.slice(f.lastIndexOf('/') + 1), all.filter((s) => this.matches(s, 'folder') && inFolder(s, f)).length, this.folder === f,
        () => { this.folder = this.folder === f ? null : f; this.render(); }, this.host.folderColor(f), f.split('/').length - 1))),
      ...group(t('Protocols', 'Protocoles'), protocols.map((p) => item(p.toUpperCase(), all.filter((s) => this.matches(s, 'protocol') && s.protocol === p).length, this.protocol === p,
        () => { this.protocol = this.protocol === p ? null : p; this.render(); }))),
      ...group(t('Tags', 'Étiquettes'), tags.map((tag) => item(`#${tag}`, all.filter((s) => this.matches(s, 'tag') && s.tags.includes(tag)).length, this.tag === tag,
        () => { this.tag = this.tag === tag ? null : tag; this.render(); }))));
  }

  private renderTable(shown: Session[]) {
    const cols: [Key, string][] = [
      ['name', t('Name', 'Nom')], ['target', t('Address', 'Adresse')], ['protocol', t('Protocol', 'Protocole')],
      ['folder', t('Folder', 'Dossier')], ['tags', t('Tags', 'Étiquettes')], ['last', t('Last opened', 'Dernière ouverture')],
    ];
    const allOn = shown.length > 0 && shown.every((s) => this.selected.has(s.id));
    const head = h('tr', {},
      h('th', { class: 'lib-check' }, h('input', {
        type: 'checkbox', checked: allOn, 'aria-label': t('Select all', 'Tout sélectionner'),
        onchange: () => { shown.forEach((s) => (allOn ? this.selected.delete(s.id) : this.selected.add(s.id))); this.render(); },
      })),
      ...cols.map(([key, label]) => h('th', { 'aria-sort': this.key === key ? (this.dir > 0 ? 'ascending' : 'descending') : 'none' },
        h('button', { type: 'button', class: 'lib-sort', onclick: () => { this.dir = this.key === key ? -this.dir : 1; this.key = key; this.render(); } },
          label, this.key === key && icon(this.dir > 0 ? 'chevronDown' : 'up', 12)))));
    const rows = shown.map((s) => {
      const on = this.selected.has(s.id);
      const last = this.host.lastOpened(s.id);
      const toggle = () => { if (on) this.selected.delete(s.id); else this.selected.add(s.id); this.render(); };
      const tr = h('tr', {
        class: on ? 'on' : '', tabindex: '0', title: t('Double-click or Enter: open', 'Double-clic ou Entrée : ouvrir'),
        onclick: (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('input, button')) toggle(); },
        ondblclick: () => this.host.open([s]),
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') this.host.open([s]); else if (e.key === ' ') { e.preventDefault(); toggle(); } else if (e.key === 'F2') this.host.edit(s); },
      },
        h('td', { class: 'lib-check' }, h('input', { type: 'checkbox', checked: on, 'aria-label': t(`Select ${s.name}`, `Sélectionner ${s.name}`), onchange: toggle })),
        h('td', {}, h('span', { class: 'lib-name' }, h('span', { class: `dot${this.host.isConnected(s.id) ? ' on' : ''}` }), h('b', {}, s.name),
          this.host.isPinned(s.id) && h('span', { class: 'pin-mark' }, icon('star', 11)))),
        h('td', { class: 'mono' }, this.host.target(s)),
        h('td', {}, badge(s.protocol)),
        h('td', {}, s.folder.split('/').join(' › ')),
        h('td', { class: 'muted' }, s.tags.map((tag) => `#${tag}`).join(' ')),
        h('td', { class: 'muted' }, last ? new Date(last).toLocaleString() : '—'));
      paint(tr, this.host.folderColor(s.folder));
      return tr;
    });
    this.table.replaceChildren(shown.length
      ? h('table', { class: 'tbl lib-tbl' }, h('thead', {}, head), h('tbody', {}, ...rows))
      : h('p', { class: 'muted', style: 'padding: 16px' }, t('No session matches.', 'Aucune session ne correspond.')));
  }
}
