// Menu contextuel minimal (clic droit ou bouton « … »).
import { h, icon } from './dom';
import { t } from './i18n';

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  action: () => void;
}

let current: HTMLElement | null = null;
const currentMenu = (el: HTMLElement) => { current = el; };

export function closeMenu() {
  current?.remove();
  current = null;
}

export function showMenu(x: number, y: number, items: (MenuItem | 'separator')[]) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' },
    ...items.map((item) =>
      item === 'separator'
        ? h('div', { class: 'menu-sep', role: 'separator' })
        : h('button', {
            class: `menu-item${item.danger ? ' danger' : ''}`, role: 'menuitem',
            onclick: () => { closeMenu(); item.action(); },
          }, item.icon ? icon(item.icon, 14) : h('span', { class: 'menu-pad' }), item.label)));
  document.body.append(menu);
  current = menu;
  // Reste dans la fenêtre.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}

document.addEventListener('pointerdown', (e) => {
  if (current && !current.contains(e.target as Node)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (!current) return;
  if (e.key === 'Escape') { closeMenu(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const buttons = [...current.querySelectorAll<HTMLButtonElement>('button')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  }
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

/** Petite palette de couleurs (couleur d'un dossier). */
export function showColorPicker(x: number, y: number, selected: string | undefined, colors: Record<string, { label: string; value: string }>, pick: (color: string | null) => void) {
  closeMenu();
  const swatch = (key: string | null, label: string, value?: string) =>
    h('button', {
      class: `color-swatch${key === null ? ' none' : ''}${(selected ?? null) === key ? ' on' : ''}`,
      title: label, 'aria-label': label, style: value ? `background: ${value}` : '',
      onclick: () => { closeMenu(); pick(key); },
    });
  const menu = h('div', { class: 'menu', role: 'dialog', 'aria-label': t('Folder colour', 'Couleur du dossier') },
    h('div', { class: 'muted small', style: 'padding: 6px 10px 2px' }, t('Folder colour', 'Couleur du dossier')),
    h('div', { class: 'color-swatches' },
      swatch(null, t('None', 'Aucune')),
      ...Object.entries(colors).map(([key, c]) => swatch(key, c.label, c.value))));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  currentMenu(menu);
}
