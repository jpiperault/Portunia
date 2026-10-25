// Petits utilitaires DOM : pas de framework, pour garder l'appli légère.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (typeof value === 'boolean' && key in el) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children) if (child != null && child !== false) el.append(child);
  return el;
}

const ICONS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  close: 'M7 7l10 10M17 7 7 17',
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  terminal: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM7 9l3 3-3 3M13 15h4',
  desktop: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8 20h8M12 16v4',
  web: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  puzzle: 'M10 4h4v3a2 2 0 1 0 4 0V4h2v6h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H4v-6h3a2 2 0 1 0 0-4H4V4z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  fileEdit: 'M6 3h8l4 4v5M14 3v4h4M6 3v18h6M14.5 20.5l5-5 2 2-5 5h-2z',
  folderUp: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 17v-6M9.5 13.5 12 11l2.5 2.5',
  folderPlus: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  home: 'M3 11l9-7 9 7M5 10v10h14V10',
  up: 'M12 19V5M5 12l7-7 7 7',
  files: 'M8 3h7l4 4v11H8zM15 3v4h4M5 7v14h11',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  play: 'M7 5l12 7-12 7z',
  move: 'M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  commands: 'M4 6l4 4-4 4M10 16h10M10 6h10M14 11h6',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  check: 'M5 12l4 4L19 6',
  pause: 'M8 5v14M16 5v14',
  prompt: 'M4 17l6-5-6-5M12 19h8',
  wsl: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  git: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  palette: 'M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2 0-1.5 1-2 2.5-2H18a3 3 0 0 0 3-3c0-6-4-11-9-11zM7.5 12h.01M10 7.5h.01M15 7.5h.01',
  tunnel: 'M3 18V11a9 9 0 0 1 18 0v7M7 18v-6a5 5 0 0 1 10 0v6M3 18h4M17 18h4',
  split: 'M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM12 4v16',
  broadcast: 'M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
};

export function icon(name: keyof typeof ICONS | string, size = 16): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ic');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.terminal);
  svg.append(path);
  return svg;
}

export function viewIcon(view: string): string {
  return view === 'desktop' || view === 'screen' ? 'desktop' : view === 'web' ? 'web' : view === 'files' ? 'files' : 'terminal';
}

/** Étiquette courte et couleur pour un protocole. */
export function badge(protocolId: string): HTMLElement {
  return h('span', { class: `badge badge-${protocolId}` }, protocolId.toUpperCase());
}
