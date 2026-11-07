import { fetch as wreqFetch, createTransport } from 'wreq-js';
import type { Transport } from 'wreq-js';

/**
 * Upstream HTTP layer — wreq-js, the TypeScript equivalent of Go's tls-client.
 *
 * Go uses tls-client with a Chrome 146 TLS fingerprint for ALL upstream
 * calls; plain Node fetch sends Node's JA3/JA4, which iCloud can flag.
 * wreq-js (Rust/BoringSSL, prebuilt binaries) impersonates browser TLS +
 * HTTP/2 fingerprints. Preset mapping (per brief):
 *   HME client  -> chrome_147 (UA header still says Chrome/147)
 *   SRP auth    -> chrome_146 (UA header still says Chrome/124, as in Go)
 *   Web mail    -> chrome_146
 * The User-Agent *header* is set manually per Go; the preset only controls
 * the TLS fingerprint.
 *
 * Cookies: NO shared cookie jar (createSession is not used). One transport
 * per account (pooled connections, per-account proxy) + a standalone
 * fetch(url, { transport, headers }) with the manual Cookie header, exactly
 * like Go. Set-Cookie values are merged back into the caller's cookie map.
 *
 * Testability: HME/SRP/web-mail modules take an injected UpstreamFetch, so
 * unit tests never load the native binding or touch the network.
 */

export interface UpstreamResponse {
  status: number;
  body: string;
  /** Raw Set-Cookie header values. */
  setCookies: string[];
  /** Response headers, keys lower-cased. */
  headers: Record<string, string>;
}

export interface UpstreamFetchOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export type UpstreamFetch = (
  url: string,
  opts: UpstreamFetchOptions,
) => Promise<UpstreamResponse>;

export type BrowserPreset = 'chrome_147' | 'chrome_146';

export interface WreqHandle {
  fetch: UpstreamFetch;
  close(): Promise<void>;
}

/** Create a wreq-js backed fetch bound to one transport (browser + proxy). */
export async function createWreqFetch(
  preset: BrowserPreset,
  proxy?: string,
): Promise<WreqHandle> {
  let transportPromise: Promise<Transport> | null = null;
  const ensureTransport = (): Promise<Transport> => {
    if (!transportPromise) {
      transportPromise = createTransport({
        browser: preset,
        ...(proxy ? { proxy } : {}),
      });
    }
    return transportPromise;
  };
  const fetchFn: UpstreamFetch = async (url, opts) => {
    const transport = await ensureTransport();
    const resp = await wreqFetch(url, {
      transport,
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      timeout: opts.timeoutMs,
    });
    const body = await resp.text();
    const headers: Record<string, string> = {};
    for (const [name, value] of resp.headers) {
      headers[name.toLowerCase()] = value;
    }
    return { status: resp.status, body, setCookies: resp.headers.getSetCookie(), headers };
  };
  return {
    fetch: fetchFn,
    close: async () => {
      if (transportPromise) {
        const t = await transportPromise.catch(() => null);
        if (t) await t.close().catch(() => undefined);
      }
    },
  };
}

/** Build the Cookie header exactly like Go: values without a leading double
 *  quote get wrapped in double quotes ("browsers send Cookie values quoted,
 *  iCloud strictly matches"). */
export function buildCookieHeader(cookies: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(cookies)) {
    if (v.startsWith('"')) parts.push(`${k}=${v}`);
    else parts.push(`${k}="${v}"`);
  }
  return parts.join('; ');
}

/** Parse raw Set-Cookie values into name/value pairs (skip empty names/values). */
export function parseSetCookies(setCookies: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of setCookies) {
    const semi = raw.indexOf(';');
    const pair = semi >= 0 ? raw.slice(0, semi) : raw;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name !== '' && value !== '') out[name] = value;
  }
  return out;
}

/** Merge Set-Cookie values into a cookie map (in place). */
export function mergeSetCookies(
  cookies: Record<string, string>,
  setCookies: string[],
): void {
  Object.assign(cookies, parseSetCookies(setCookies));
}
