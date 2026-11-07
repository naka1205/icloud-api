/**
 * Mail preview sanitizers — exact port of internal/mail/preview.go.
 *
 * sanitizePreview = sanitizePlainPreview(stripHTML(raw))
 * sanitizePlainPreview: if the text looks like CSS, strip its rules; if it
 * still looks like CSS (or is empty) return "".
 */

const htmlNoiseBlockRe =
  /<(?:style|script|head|title|noscript)\b[^>]*>.*?<\/\s*(?:style|script|head|title|noscript)\s*>/gis;
const htmlCommentRe = /<!--.*?-->/gs;
const htmlBreakRe = /<br\s*\/?>/gi;
const htmlBlockEndRe = /<\/(?:p|div|tr|h[1-6])\s*>/gi;
const htmlListItemRe = /<li\b[^>]*>/gi;
const htmlTagRe = /<[^>]+>/gs;

const cssSignalRe =
  /(@font-face|@media|@import|@supports|@keyframes|(^|[\s;{])(-webkit-|-moz-|-ms-|mso-)[\w-]*|(^|[\s;{])(font-family|text-size-adjust|border-collapse|mso-table-[\w-]+)\s*:)/gi;
const cssDeclarationRe = /(^|[;{])\s*[-a-z_][\w-]*\s*:\s*[^;{}]+/gi;

const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    const named = namedEntities[entity];
    return named !== undefined ? named : whole;
  });
}

export function normalizePreview(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines: string[] = [];
  let prevBlank = false;
  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      if (!prevBlank) lines.push('');
      prevBlank = true;
    } else {
      lines.push(trimmed);
      prevBlank = false;
    }
  }
  return lines.join('\n').trim();
}

export function stripHTML(raw: string): string {
  let s = raw.replace(htmlNoiseBlockRe, '');
  s = s.replace(htmlCommentRe, '');
  s = s.replace(htmlBreakRe, '\n');
  s = s.replace(htmlBlockEndRe, '\n');
  s = s.replace(htmlListItemRe, '\n- ');
  s = s.replace(htmlTagRe, '');
  return normalizePreview(unescapeHtml(s));
}

function looksLikeCSS(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  const braces = (trimmed.match(/{/g) ?? []).length;
  const semicolons = (trimmed.match(/;/g) ?? []).length;
  const signals = (trimmed.match(cssSignalRe) ?? []).length;
  const declarations = (trimmed.match(cssDeclarationRe) ?? []).length;
  const first = trimmed[0];
  const selectorStart = first === '.' || first === '#' || first === '@';
  if (braces === 0) return signals >= 2 && semicolons >= 3;
  if (selectorStart && declarations >= 1) return true;
  return (
    (signals >= 2 && semicolons >= 2) ||
    (braces >= 3 && declarations >= 3 && semicolons >= 3)
  );
}

function matchingBrace(s: string, open: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stripCSSRules(text: string): string {
  let result = text;
  for (let guard = 0; guard < 1000; guard++) {
    const open = result.indexOf('{');
    if (open === -1) break;
    const close = matchingBrace(result, open);
    if (close === -1) break;
    let start = open;
    while (start > 0) {
      const prev = result[start - 1];
      if (prev === '}' || prev === '\n' || prev === '\r') break;
      start--;
    }
    result = result.slice(0, start) + result.slice(close + 1);
  }
  return result;
}

export function sanitizePlainPreview(raw: string): string {
  let text = normalizePreview(raw);
  if (text === '' || !looksLikeCSS(text)) return text;
  text = normalizePreview(stripCSSRules(text));
  if (text === '' || looksLikeCSS(text)) return '';
  return text;
}

export function sanitizePreview(raw: string): string {
  return sanitizePlainPreview(stripHTML(raw));
}
