// Mise en évidence dans le terminal : mots-clés colorés (erreurs, avertissements, adresses IP…).
// Le flux reçu n'est pas modifié : les couleurs sont des « décorations » xterm posées après coup,
// donc elles n'abîment ni les séquences d'échappement ni les enregistrements.
import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { h, icon } from './dom';
import { onSettingsChange, settings, updateSettings } from './settings';
import { DEFAULT_RULES, HighlightRule } from './highlight-rules';

export type { HighlightRule };


const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Expression compilée d'une règle, ou null si elle est invalide ou vide. */
export function compile(rule: HighlightRule): RegExp | null {
  if (!rule.pattern.trim()) return null;
  try {
    let source = rule.regex ? rule.pattern : escapeRegex(rule.pattern);
    // \b ne connaît pas les lettres accentuées : bornes « pas une lettre ni un chiffre ».
    if (rule.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
    const re = new RegExp(source, `gu${rule.caseSensitive ? '' : 'i'}`);
    // Une expression qui peut correspondre à du vide bloquerait la boucle.
    return re.test('') ? null : (re.lastIndex = 0, re);
  } catch {
    return null;
  }
}

/** Plages [début, fin) colorées d'une ligne ; la première règle l'emporte en cas de chevauchement. */
export function matches(line: string, rules: { re: RegExp; rule: HighlightRule }[]): { start: number; end: number; rule: HighlightRule }[] {
  const out: { start: number; end: number; rule: HighlightRule }[] = [];
  for (const { re, rule } of rules) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const start = m.index;
      const end = start + m[0].length;
      if (!out.some((o) => start < o.end && end > o.start)) out.push({ start, end, rule });
      if (out.length > 50) return out;
    }
  }
  return out;
}

/** Lignes colorées en plus de l'écran visible (défilement fluide). */
const MARGIN = 20;

interface Painted {
  /** Suit la ligne quand le contenu défile. */
  marker: IMarker;
  /** Texte au moment de la coloration : s'il change (ligne réécrite), on recolore. */
  text: string;
  decorations: IDisposable[];
}

/**
 * Seules les lignes affichées (et une marge) sont colorées, au plus une fois par image :
 * le coût dépend de la taille de la fenêtre, pas de la quantité de texte reçue.
 */
export class Highlighter {
  private compiled: { re: RegExp; rule: HighlightRule }[] = [];
  private painted: Painted[] = [];
  private frame = 0;
  private timer = 0;
  /** Dernière écriture : pendant un flot de texte, on recolore moins souvent. */
  private lastWrite = 0;
  private readonly subs: IDisposable[] = [];
  private readonly unsubscribe: () => void;

  constructor(private readonly term: Terminal) {
    this.load();
    const schedule = () => this.schedule();
    this.subs.push(
      term.onWriteParsed(() => { this.lastWrite = performance.now(); this.schedule(); }),
      term.onScroll(schedule),
      term.onResize(schedule),
    );
    this.unsubscribe = onSettingsChange(() => { this.load(); this.clear(); this.schedule(); });
  }

  private load() {
    const s = settings().highlight;
    this.compiled = s.enabled
      ? s.rules.filter((r) => r.enabled).map((rule) => ({ rule, re: compile(rule) })).filter((x): x is { re: RegExp; rule: HighlightRule } => !!x.re)
      : [];
  }

  private schedule() {
    if (this.frame || this.timer) return;
    // Flot de texte en cours : le contenu défile trop vite pour être lu, on recolore toutes les 200 ms.
    if (performance.now() - this.lastWrite < 100) {
      this.timer = window.setTimeout(() => { this.timer = 0; this.paint(); }, 200);
    } else {
      this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); });
    }
  }

  private clear() {
    for (const p of this.painted) this.drop(p);
    this.painted = [];
  }

  private drop(p: Painted) {
    for (const d of p.decorations) d.dispose();
    p.marker.dispose();
  }

  private paint() {
    const buffer = this.term.buffer.active;
    // Plein écran (vim, htop…) ou rien à colorer : pas de décoration.
    if (!this.compiled.length || buffer.type === 'alternate') return this.clear();
    const first = Math.max(0, buffer.viewportY - MARGIN);
    const last = buffer.viewportY + this.term.rows + MARGIN;
    const cursor = buffer.baseY + buffer.cursorY;
    const byLine = new Map<number, Painted>();
    const keep: Painted[] = [];
    for (const p of this.painted) {
      const y = p.marker.line;
      if (p.marker.isDisposed || y < first || y > last || byLine.has(y)) this.drop(p);
      else { byLine.set(y, p); keep.push(p); }
    }
    this.painted = keep;
    for (let y = first; y <= Math.min(last, buffer.length - 1); y++) {
      const text = buffer.getLine(y)?.translateToString(true) ?? '';
      const existing = byLine.get(y);
      if (existing && existing.text === text) continue;
      if (existing) {
        this.drop(existing);
        this.painted = this.painted.filter((p) => p !== existing);
      }
      if (!text) continue;
      const found = matches(text, this.compiled);
      if (!found.length) continue;
      const marker = this.term.registerMarker(y - cursor);
      if (!marker) continue;
      const decorations: IDisposable[] = [];
      for (const m of found) {
        const deco = this.term.registerDecoration({
          marker, x: m.start, width: m.end - m.start, layer: 'top',
          ...(m.rule.background ? { backgroundColor: m.rule.color, foregroundColor: '#000000' } : { foregroundColor: m.rule.color }),
        });
        if (deco) decorations.push(deco);
      }
      this.painted.push({ marker, text, decorations });
    }
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.timer);
    this.unsubscribe();
    for (const s of this.subs) s.dispose();
    this.clear();
  }
}

// ---------- Paramètres › Mise en évidence ----------

export function highlightSettings(): HTMLElement {
  const box = h('div', { class: 'settings-block' });
  const set = (patch: Partial<ReturnType<typeof settings>['highlight']>) => updateSettings({ highlight: { ...settings().highlight, ...patch } });
  const setRule = (id: string, patch: Partial<HighlightRule>) => set({ rules: settings().highlight.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const render = () => {
    const cfg = settings().highlight;
    const preview = (rule: HighlightRule) => h('span', { class: 'hl-preview', style: rule.background ? `background: ${rule.color}; color: #000` : `color: ${rule.color}` }, 'Exemple');
    box.replaceChildren(
      h('label', { class: 'check setting' },
        h('input', { type: 'checkbox', checked: cfg.enabled, onchange: (e: Event) => { set({ enabled: (e.target as HTMLInputElement).checked }); render(); } }),
        h('span', {}, 'Colorer les mots-clés dans les terminaux', h('span', { class: 'muted small block' }, 'Erreurs en rouge, avertissements en orange, adresses IP… Les programmes en plein écran (vim, htop) ne sont pas touchés.'))),
      ...cfg.rules.map((r) => {
        const invalid = !compile(r);
        return h('div', { class: `hl-row${r.enabled ? '' : ' off'}` },
          h('input', { type: 'checkbox', checked: r.enabled, 'aria-label': 'Règle active', onchange: (e: Event) => { setRule(r.id, { enabled: (e.target as HTMLInputElement).checked }); render(); } }),
          h('input', { type: 'color', value: r.color, 'aria-label': 'Couleur', onchange: (e: Event) => { setRule(r.id, { color: (e.target as HTMLInputElement).value }); render(); } }),
          h('input', {
            type: 'text', class: `grow mono${invalid ? ' invalid' : ''}`, value: r.pattern, spellcheck: 'false', 'aria-label': 'Mot ou expression',
            title: invalid ? 'Expression invalide' : '',
            onchange: (e: Event) => { setRule(r.id, { pattern: (e.target as HTMLInputElement).value }); render(); },
          }),
          h('label', { class: 'check small', title: 'Expression régulière (ex. : error|fail)' },
            h('input', { type: 'checkbox', checked: r.regex, onchange: (e: Event) => { setRule(r.id, { regex: (e.target as HTMLInputElement).checked }); render(); } }), '.*'),
          h('label', { class: 'check small', title: 'Mot entier' },
            h('input', { type: 'checkbox', checked: r.wholeWord, onchange: (e: Event) => { setRule(r.id, { wholeWord: (e.target as HTMLInputElement).checked }); render(); } }), 'Mot'),
          h('label', { class: 'check small', title: 'Respecter les majuscules' },
            h('input', { type: 'checkbox', checked: r.caseSensitive, onchange: (e: Event) => { setRule(r.id, { caseSensitive: (e.target as HTMLInputElement).checked }); render(); } }), 'Aa'),
          h('label', { class: 'check small', title: 'Fond coloré' },
            h('input', { type: 'checkbox', checked: r.background, onchange: (e: Event) => { setRule(r.id, { background: (e.target as HTMLInputElement).checked }); render(); } }), 'Fond'),
          preview(r),
          h('button', {
            type: 'button', class: 'icon-btn sm', 'aria-label': 'Supprimer la règle', title: 'Supprimer',
            onclick: () => { set({ rules: settings().highlight.rules.filter((x) => x.id !== r.id) }); render(); },
          }, icon('trash', 14)));
      }),
      h('div', { style: 'display: flex; gap: 8px' },
        h('button', {
          type: 'button', class: 'btn sm',
          onclick: () => {
            set({ rules: [...settings().highlight.rules, { id: crypto.randomUUID(), pattern: '', regex: false, caseSensitive: false, wholeWord: true, color: '#c792ea', background: false, enabled: true }] });
            render();
            box.querySelector<HTMLInputElement>('.hl-row:last-of-type input[type=text]')?.focus();
          },
        }, icon('plus', 14), 'Ajouter une règle'),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { if (confirm('Revenir aux règles proposées par défaut ?')) { set({ rules: DEFAULT_RULES }); render(); } } }, 'Règles par défaut')));
  };
  render();
  return box;
}
