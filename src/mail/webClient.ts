import { randomUUID } from 'node:crypto';
import { createWreqFetch, mergeSetCookies } from '../hme/http.js';
import type { UpstreamFetch, WreqHandle } from '../hme/http.js';
import { CLIENT_BUILD_NUMBER, CLIENT_MASTERING_NUMBER } from '../hme/client.js';
import { sanitizePreview } from './preview.js';
import type { Message } from './client.js';

/**
 * Web mail client — port of internal/mail/web_client.go.
 *
 * Plain wreq-js (chrome_146, NO proxy — unlike the HME client), 30s timeout.
 * Discovers the mccgateway endpoint via /validate, then searches threads
 * with the mailws2 API. Message.to is always empty (the API does not return
 * recipients).
 */

export interface WebMailClientOptions {
  cookies: Record<string, string>;
  host?: string;
  /** dsid parsed from the X-APPLE-WEBAUTH-USER cookie ("v=1:s=1:d=<dsid>"). */
  dsid?: string;
  fetchFn?: UpstreamFetch;
}

export class WebMailClient {
  private readonly cookies: Record<string, string>;
  private readonly host: string;
  private readonly clientId: string;
  private readonly dsid: string;
  private readonly injectedFetch?: UpstreamFetch;
  private wreqHandle: WreqHandle | null = null;
  private fetchPromise: Promise<UpstreamFetch> | null = null;

  constructor(opts: WebMailClientOptions) {
    this.cookies = { ...opts.cookies };
    this.host = opts.host ?? 'icloud.com';
    this.clientId = randomUUID();
    this.dsid = opts.dsid ?? '';
    this.injectedFetch = opts.fetchFn;
  }

  private async webFetch(): Promise<UpstreamFetch> {
    if (this.injectedFetch) return this.injectedFetch;
    if (!this.fetchPromise) {
      this.fetchPromise = createWreqFetch('chrome_146').then((h) => {
        this.wreqHandle = h;
        return h.fetch;
      });
    }
    return this.fetchPromise;
  }

  async close(): Promise<void> {
    await this.wreqHandle?.close().catch(() => undefined);
  }

  private withParams(rawUrl: string): string {
    const url = new URL(rawUrl);
    url.searchParams.set('clientBuildNumber', CLIENT_BUILD_NUMBER);
    url.searchParams.set('clientMasteringNumber', CLIENT_MASTERING_NUMBER);
    if (this.clientId !== '') url.searchParams.set('clientId', this.clientId);
    if (this.dsid !== '') url.searchParams.set('dsid', this.dsid);
    return url.toString();
  }

  private async request(url: string, body: string | null): Promise<string> {
    const fetchFn = await this.webFetch();
    const cookieHeader = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const resp = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        Origin: 'https://www.icloud.com',
        Referer: 'https://www.icloud.com/',
        ...(cookieHeader !== '' ? { Cookie: cookieHeader } : {}),
      },
      body: body ?? undefined,
      timeoutMs: 30_000,
    });
    mergeSetCookies(this.cookies, resp.setCookies);
    if (resp.status !== 200) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return resp.body;
  }

  /** POST /validate, take webservices.mccgateway.url (strip :443). */
  async resolveMccGateway(): Promise<string> {
    const url = this.withParams(`https://setup.${this.host}/setup/ws/1/validate`);
    const body = await this.request(url, null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('resolveMccGateway: invalid JSON');
    }
    const mcc = (parsed as Record<string, unknown>)?.['webservices'];
    const rawUrl =
      (mcc as Record<string, unknown>)?.['mccgateway'] &&
      ((mcc as Record<string, unknown>)['mccgateway'] as Record<string, unknown>)['url'];
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      throw new Error('mccgateway 未配置');
    }
    try {
      const u = new URL(rawUrl);
      return `${u.protocol}//${u.hostname}`;
    } catch {
      return rawUrl;
    }
  }

  async search(gateway: string, maxResults: number): Promise<Message[]> {
    const url = this.withParams(`${gateway}/mailws2/v1/thread/search`);
    const body = await this.request(
      url,
      JSON.stringify({
        responseType: 'THREAD_DIGEST',
        includeFolderStatus: true,
        maxResults,
        sessionHeaders: {
          folder: 'INBOX',
          modseq: null,
          threadmodseq: null,
          condstore: 1,
          qresync: 1,
          threadmode: 1,
        },
      }),
    );
    if (body.includes('"success":false')) {
      throw new Error('搜索邮件失败');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('搜索邮件失败: invalid JSON');
    }
    const list = (parsed as Record<string, unknown>)?.['threadList'];
    if (!Array.isArray(list)) return [];
    const out: Message[] = [];
    for (const t of list) {
      if (t === null || typeof t !== 'object') continue;
      const rec = t as Record<string, unknown>;
      const senders = Array.isArray(rec['senders']) ? rec['senders'] : [];
      const from = senders.length > 0 ? String(senders[0]) : '';
      const ts = typeof rec['timestamp'] === 'number' ? rec['timestamp'] : 0;
      out.push({
        id: String(rec['threadId'] ?? ''),
        from,
        to: '',
        subject: String(rec['subject'] ?? ''),
        preview: sanitizePreview(String(rec['preview'] ?? '')),
        date: ts > 0 ? new Date(ts).toISOString() : '',
      });
    }
    return out;
  }

  async findByAlias(gateway: string, alias: string, limit: number): Promise<Message[]> {
    const all = await this.search(gateway, Math.max(50, limit * 2));
    const lower = alias.toLowerCase();
    return all
      .filter(
        (m) =>
          m.subject.toLowerCase().includes(lower) ||
          m.from.toLowerCase().includes(lower) ||
          m.to.toLowerCase().includes(lower),
      )
      .slice(0, limit);
  }
}
