/**
 * Go time.ParseDuration compatible parser.
 *
 * Accepts sequences of <number><unit> where unit is ns, us, µs, ms, s, m, h
 * (e.g. "12h", "15m", "1h30m", "90m", "1.5h"). Returns milliseconds.
 * Throws on invalid input. Empty string returns null (caller applies default).
 */
export function parseDurationMs(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  if (s === '0') return 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
  const multipliers: Record<string, number> = {
    ns: 1 / 1e6,
    us: 1 / 1000,
    'µs': 1 / 1000,
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 3600 * 1000,
  };
  let total = 0;
  let matched = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched += m[0];
    total += parseFloat(m[1]) * multipliers[m[2]];
  }
  if (matched !== s) {
    throw new Error(`invalid duration: ${raw}`);
  }
  return total;
}

/**
 * Parse ICLOUD_API_SESSION_TTL with the same semantics as Go main.go.
 *
 * Default 12h. Documented range 15m–168h, but Go's parseSessionTTL has a bug:
 * out-of-range values return (0, nil), so the caller silently falls back to
 * the 12h default instead of refusing to start. We reproduce that behaviour
 * (documented in README) rather than failing startup on an out-of-range value.
 * A syntactically invalid value still refuses to start.
 */
export function parseSessionTTL(raw: string | undefined): number {
  const DEFAULT_MS = 12 * 3600 * 1000;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MS;
  const ms = parseDurationMs(raw);
  if (ms === null) return DEFAULT_MS;
  if (ms < 15 * 60 * 1000 || ms > 168 * 3600 * 1000) {
    // Go bug compatibility: out of range silently falls back to default.
    return DEFAULT_MS;
  }
  return ms;
}
