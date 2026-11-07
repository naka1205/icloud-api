import { sanitizePlainPreview, sanitizePreview } from './preview.js';

/**
 * Minimal RFC822 parsing, quoted-printable decoding and RFC2047 word
 * decoding — supporting pieces for internal/mail/client.go's readBody.
 *
 * Go does NOT decode base64 bodies; that behaviour is replicated (do not
 * "improve" it). Body text is used for previews only.
 */

export interface ParsedMessage {
  headers: Map<string, string>;
  body: string;
}

/** Split a raw message into headers (unfolded, keys lower-cased) and body. */
export function parseRfc822(raw: string): ParsedMessage {
  let headerPart = raw;
  let body = '';
  const idx = raw.search(/\r?\n\r?\n/);
  if (idx >= 0) {
    headerPart = raw.slice(0, idx);
    const sepLen = raw[idx] === '\r' ? 4 : 2;
    body = raw.slice(idx + sepLen);
  }
  const headers = new Map<string, string>();
  let currentKey = '';
  for (const line of headerPart.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentKey !== '') {
      const prev = headers.get(currentKey) ?? '';
      headers.set(currentKey, prev + ' ' + line.trim());
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    currentKey = line.slice(0, colon).trim().toLowerCase();
    headers.set(currentKey, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

/** Decode quoted-printable text (soft line breaks, =XX bytes). */
export function decodeQuotedPrintable(input: string): string {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  let i = 0;
  while (i < withoutSoftBreaks.length) {
    const c = withoutSoftBreaks[i];
    if (c === '=' && i + 2 < withoutSoftBreaks.length + 1) {
      const hex = withoutSoftBreaks.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    const code = withoutSoftBreaks.charCodeAt(i);
    if (code < 128) bytes.push(code);
    else {
      const buf = Buffer.from(withoutSoftBreaks[i], 'utf8');
      for (const b of buf) bytes.push(b);
    }
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

const encodedWordRe = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/** Decode RFC2047 encoded words (=?UTF-8?B?...?= / =?...?Q?...?=). */
export function decodeRfc2047(input: string): string {
  if (!input.includes('=?')) return input;
  return input.replace(encodedWordRe, (_whole, charset: string, enc: string, text: string) => {
    try {
      let buf: Buffer;
      if (enc.toUpperCase() === 'B') {
        buf = Buffer.from(text, 'base64');
      } else {
        const q = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)),
        );
        buf = Buffer.from(q, 'latin1');
      }
      const cs = charset.toLowerCase();
      if (cs === 'utf-8' || cs === 'utf8') return buf.toString('utf8');
      if (cs === 'iso-8859-1' || cs === 'latin1') return buf.toString('latin1');
      return buf.toString('utf8');
    } catch {
      return _whole;
    }
  });
}

/**
 * readBody: HTML bodies are QP-decoded (when applicable) then run through
 * sanitizePreview; anything else is treated as text/plain and run through
 * sanitizePlainPreview. Base64 is NOT decoded, matching Go.
 */
export function readBody(raw: string): { body: string; contentType: string } {
  const { headers, body: rawBody } = parseRfc822(raw);
  const contentType = headers.get('content-type') ?? '';
  const cte = headers.get('content-transfer-encoding') ?? '';
  let text = rawBody;
  if (cte.toLowerCase().includes('quoted-printable')) {
    text = decodeQuotedPrintable(rawBody);
  }
  if (contentType.toLowerCase().startsWith('text/html')) {
    return { body: sanitizePreview(text), contentType };
  }
  return { body: sanitizePlainPreview(text), contentType };
}

/** Extract the first email address from a header value (display names allowed). */
export function firstEmailAddress(header: string): string {
  const decoded = decodeRfc2047(header);
  const m = decoded.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (m) return m[1];
  const bare = decoded.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return bare ? bare[1] : '';
}

/** Join all addresses in a header value with ", ". */
export function allEmailAddresses(header: string): string {
  const decoded = decodeRfc2047(header);
  const found = decoded.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  return found ? found.join(', ') : '';
}

/** Parse an RFC1123Z-style Date header; returns a Date or null. */
export function parseMailDate(value: string): Date | null {
  if (value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
