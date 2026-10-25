// Rendu Markdown minimal et sûr pour les notes : tout le HTML saisi est échappé.
// Titres, gras, italique, code, blocs de code, listes, cases à cocher, citations, liens, séparateurs.

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text: string): string {
  // Le code en ligne d'abord : son contenu n'est pas interprété.
  const parts = text.split(/(`[^`]+`)/);
  return parts.map((p) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return `<code>${escape(p.slice(1, -1))}</code>`;
    return escape(p)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  }).join('');
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let paragraph: string[] = [];
  let task = 0;

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => { if (list) out.push(`</${list}>`); list = null; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```\s*(\S*)/);
    if (fence) {
      flushParagraph(); closeList();
      const code: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre class="md-code" data-lang="${escape(fence[1])}"><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (heading) {
      flushParagraph(); closeList();
      out.push(`<h${heading[1].length + 2}>${inline(heading[2])}</h${heading[1].length + 2}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph(); closeList();
      out.push('<hr>');
    } else if (item) {
      flushParagraph();
      const kind = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      const check = item[2].match(/^\[([ xX])\]\s+(.*)$/);
      out.push(check
        ? `<li class="md-task"><input type="checkbox" data-task="${task++}"${check[1] === ' ' ? '' : ' checked'}> ${inline(check[2])}</li>`
        : `<li>${inline(item[2])}</li>`);
    } else if (line.startsWith('>')) {
      flushParagraph(); closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (!line.trim()) {
      flushParagraph(); closeList();
    } else {
      closeList();
      paragraph.push(line);
    }
  }
  flushParagraph(); closeList();
  return out.join('\n');
}

/** Coche ou décoche la n-ième case « - [ ] » du texte source. */
export function toggleTask(source: string, index: number): string {
  let n = 0;
  let inCode = false;
  return source.split('\n').map((line) => {
    if (/^```/.test(line)) inCode = !inCode;
    if (inCode) return line;
    const m = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](\s+.*)$/);
    if (!m) return line;
    return n++ === index ? `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${m[3]}` : line;
  }).join('\n');
}
