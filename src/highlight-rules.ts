// Règles de mise en évidence : type et valeurs par défaut (sans dépendance, lues par les paramètres).

export interface HighlightRule {
  id: string;
  /** Mot, expression ou expression régulière. */
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Mot entier seulement. */
  wholeWord: boolean;
  /** Couleur du texte (#rrggbb). */
  color: string;
  /** Fond coloré plutôt que texte coloré. */
  background: boolean;
  enabled: boolean;
}

export const DEFAULT_RULES: HighlightRule[] = [
  { id: 'err', pattern: 'error|erreur|errors|failed|failure|fatal|denied|refused|échec|critical|critique|panic|exception', regex: true, caseSensitive: false, wholeWord: true, color: '#ff5f56', background: false, enabled: true },
  { id: 'warn', pattern: 'warning|warn|avertissement|deprecated|timeout|timed out', regex: true, caseSensitive: false, wholeWord: true, color: '#ffbd2e', background: false, enabled: true },
  { id: 'ok', pattern: 'success|succeeded|réussi|active \\(running\\)|passed|done', regex: true, caseSensitive: false, wholeWord: true, color: '#27c93f', background: false, enabled: true },
  { id: 'ip', pattern: '(?<![\\d.])(?:\\d{1,3}\\.){3}\\d{1,3}(?!\\.?\\d)(?::\\d+)?', regex: true, caseSensitive: false, wholeWord: false, color: '#5ccfe6', background: false, enabled: true },
];
