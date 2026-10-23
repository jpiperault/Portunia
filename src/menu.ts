// Menu contextuel minimal (clic droit ou bouton « … »).
import { h, icon } from './dom';

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  action: () => void;
}

let current: HTMLElement | null = null;

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
