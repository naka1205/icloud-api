import { randomUUID } from 'node:crypto';
import {
  buildCookieHeader,
  createWreqFetch,
  mergeSetCookies,
} from './http.js';
import type { UpstreamFetch, WreqHandle } from './http.js';
import { firstNonEmpty } from '../account/validation.js';

/**
 * iCloud Hide My Email client — port of internal/hme/client.go.
 *
 * One client per iCloud account. Cookies are kept in a plain map and sent
 * via a manually built Cookie header on every request (no shared jar).
 * The first business call triggers ValidateSession to discover the HME
 * service endpoint (requires an iCloud+ subscription).
 *
 * Transport: wreq-js chrome_147 for HME API calls (the TLS fingerprint; the
 * User-Agent header still says Chrome/147, as in Go). Retries, timeouts and
 * header selection mirror Go exactly.
 */

export const CLIENT_BUILD_NUMBER = '2624Build22';
export const CLIENT_MASTERING_NUMBER = '2624Build22';
export const DEFAULT_BUILD_NUMBER = '2624Build13';
export const REQUEST_TIMEOUT_MS = 15_000;
export const VALIDATE_TIMEOUT_MS = 20_000;
export const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2500, 5000];

export const UA_CHROME_147 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

export interface AccountInfo {
  dsid: string;
  appleId: string;
  primaryEmail: string;
  fullName: string;
  isManagedAppleId: boolean;
}

export interface Alias {
  email: string;
  anonymousId: string;
  label: string;
  active: boolean;
  createdAt?: string;
}

export interface CreateResult {
  email: string;
  label: string;
  created_at: string;
}

export interface HmeClientOptions {
  cookies: Record<string, string>;
  host?: string;
  proxy?: string;
  /** Injected fetch for the HME preset (tests). Defaults to wreq-js chrome_147. */
  fetchFn?: UpstreamFetch;
  /** Injected fetch for the SRP preset (tests). Defaults to wreq-js chrome_146. */
  authFetchFn?: UpstreamFetch;
  verbose?: boolean;
}

export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  try {
    const u = new URL(h.includes('://') ? h : 'https://' + h);
    if (u.hostname !== '') h = u.hostname;
  } catch {
    // keep as-is
  }
  if (h.endsWith('.icloud.com.cn') || h === 'icloud.com.cn') return 'icloud.com.cn';
  return 'icloud.com';
}

/** Origin follows the *target* URL domain, not the account config. */
export function requestOrigin(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'icloud.com.cn' || host.endsWith('.icloud.com.cn')) {
      return 'https://www.icloud.com.cn';
    }
    if (host === 'icloud.com' || host.endsWith('.icloud.com')) {
      return 'https://www.icloud.com';
    }
  } catch {
    // fall through
  }
  return 'https://www.icloud.com';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gstr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

export class HmeClient {
  cookies: Record<string, string>;
  readonly host: string;
  readonly proxy: string;
  readonly verbose: boolean;
  private setupUrl = '';
  private serviceUrl = '';
  private dsid = '';
  private readonly clientId: string;
  private accountInfo: AccountInfo | null = null;
  private readonly injectedFetch?: UpstreamFetch;
  private readonly injectedAuthFetch?: UpstreamFetch;
  private wreqHandles: WreqHandle[] = [];
  private hmeFetchPromise: Promise<UpstreamFetch> | null = null;
  private authFetchPromise: Promise<UpstreamFetch> | null = null;

  constructor(opts: HmeClientOptions) {
    this.cookies = { ...opts.cookies };
    this.host = normalizeHost(opts.host ?? '');
    this.proxy = opts.proxy ?? '';
    this.verbose = opts.verbose ?? false;
    this.clientId = randomUUID();
    this.injectedFetch = opts.fetchFn;
    this.injectedAuthFetch = opts.authFetchFn;
  }

  /** Fetch bound to the HME transport (chrome_147, per-account proxy). */
  async hmeFetch(): Promise<UpstreamFetch> {
    if (this.injectedFetch) return this.injectedFetch;
    if (!this.hmeFetchPromise) {
      this.hmeFetchPromise = createWreqFetch('chrome_147', this.proxy || undefined).then(
        (h) => {
          this.wreqHandles.push(h);
          return h.fetch;
        },
      );
    }
    return this.hmeFetchPromise;
  }

  /** Fetch bound to the SRP transport (chrome_146, same proxy). */
  async authFetch(): Promise<UpstreamFetch> {
    if (this.injectedAuthFetch) return this.injectedAuthFetch;
    if (!this.authFetchPromise) {
      this.authFetchPromise = createWreqFetch('chrome_146', this.proxy || undefined).then(
        (h) => {
          this.wreqHandles.push(h);
          return h.fetch;
        },
      );
    }
    return this.authFetchPromise;
  }

  async close(): Promise<void> {
    await Promise.all(this.wreqHandles.map((h) => h.close().catch(() => undefined)));
    this.wreqHandles = [];
  }

  setupURL(): string {
    if (this.setupUrl === '') {
      const suffix = this.host === 'icloud.com.cn' ? 'setup.icloud.com.cn' : 'setup.icloud.com';
      this.setupUrl = 'https://' + suffix + '/setup/ws/1';
    }
    return this.setupUrl;
  }

  origin(): string {
    return 'https://www.' + this.host;
  }

  getServiceUrl(): string {
    return this.serviceUrl;
  }

  getAccountInfo(): AccountInfo | null {
    return this.accountInfo;
  }

  private log(fmt: string, ...args: unknown[]): void {
    if (this.verbose) {
      // eslint-disable-next-line no-console
      console.log(`  [iCloud] ${fmt}`, ...args);
    }
  }

  /** Append clientBuildNumber / clientMasteringNumber / clientId / dsid. */
  buildURL(rawUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return rawUrl;
    }
    const host = parsed.hostname;
    if (host.includes('maildomainws')) {
      parsed.searchParams.set('clientBuildNumber', CLIENT_BUILD_NUMBER);
      parsed.searchParams.set('clientMasteringNumber', CLIENT_MASTERING_NUMBER);
    } else {
      parsed.searchParams.set('clientBuildNumber', DEFAULT_BUILD_NUMBER);
      parsed.searchParams.set('clientMasteringNumber', DEFAULT_BUILD_NUMBER);
    }
    if (this.clientId !== '') parsed.searchParams.set('clientId', this.clientId);
    if (this.dsid !== '') parsed.searchParams.set('dsid', this.dsid);
    return parsed.toString();
  }

  /**
   * Retrying request. Returns the response body on 2xx. Throws
   * `HTTP <status>: <first 200 chars>` on non-2xx (401/403 never retried)
   * or `连接失败: ...` on transport errors.
   */
  async request(
    method: string,
    rawUrl: string,
    body: unknown,
    timeoutMs: number,
    maxAttempts: number,
  ): Promise<string> {
    const timeout = timeoutMs === 0 ? REQUEST_TIMEOUT_MS : timeoutMs;
    const attempts = maxAttempts === 0 ? MAX_RETRIES : maxAttempts;
    const fullUrl = this.buildURL(rawUrl);
    let hostName = '';
    try {
      hostName = new URL(rawUrl).hostname;
    } catch {
      // keep empty
    }
    const isMailDomainWs = hostName.includes('maildomainws');
    const contentType = isMailDomainWs ? 'text/plain' : 'application/json';
    const accept = isMailDomainWs ? '*/*' : 'application/json, text/plain, */*';
    const bodyText = body === null || body === undefined ? undefined : JSON.stringify(body);
    const fetchFn = await this.hmeFetch();

    let lastErr: Error = new Error('未知错误');
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const origin = requestOrigin(rawUrl);
      const headers: Record<string, string> = {
        Origin: origin,
        Referer: origin + '/',
        Accept: accept,
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
        Connection: 'keep-alive',
        'Content-Type': contentType,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
        'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'User-Agent': UA_CHROME_147,
      };
      if (Object.keys(this.cookies).length > 0) {
        headers['Cookie'] = buildCookieHeader(this.cookies);
      }
      let resp;
      try {
        resp = await fetchFn(fullUrl, { method, headers, body: bodyText, timeoutMs: timeout });
      } catch (err) {
        lastErr = new Error(`连接失败: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt < attempts) {
          await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
          continue;
        }
        throw lastErr;
      }
      mergeSetCookies(this.cookies, resp.setCookies);
      if (resp.status < 200 || resp.status >= 300) {
        const snippet = resp.body.length > 200 ? resp.body.slice(0, 200) : resp.body;
        lastErr = new Error(`HTTP ${resp.status}: ${snippet}`);
        if (resp.status === 401 || resp.status === 403) throw lastErr;
        if (attempt < attempts) {
          await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
          continue;
        }
        throw lastErr;
      }
      return resp.body;
    }
    throw lastErr;
  }

  validationURLs(): string[] {
    const primary = this.setupURL() + '/validate';
    if (this.host !== 'icloud.com.cn') return [primary];
    const global = 'https://setup.icloud.com/setup/ws/1/validate';
    if (primary === global) return [primary];
    return [primary, global];
  }

  /**
   * Validate the session and discover the HME service endpoint. Requires an
   * iCloud+ subscription (webservices.premiummailsettings.url must be present).
   */
  async validateSession(): Promise<void> {
    this.log('校验 iCloud 会话...');
    let body = '';
    let lastErr: Error | null = null;
    const urls = this.validationURLs();
    for (let i = 0; i < urls.length; i++) {
      let candidate = '';
      let err: Error | null = null;
      try {
        candidate = await this.request('POST', urls[i], null, VALIDATE_TIMEOUT_MS, MAX_RETRIES);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          parsed = null;
        }
        if (parsed === null || typeof parsed !== 'object') {
          err = new Error('invalid JSON response');
        } else if (gstr(getPath(parsed, ['webservices', 'premiummailsettings', 'url'])) === '') {
          err = new Error('validate 响应缺少 Hide My Email 服务端点');
        }
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
      if (err === null) {
        body = candidate;
        lastErr = null;
        break;
      }
      lastErr = err;
      if (i < urls.length - 1) this.log('区域 validate 失败，改用全球端点: %s', err.message);
    }
    if (lastErr !== null) {
      this.log('校验失败: %s', lastErr.message);
      throw lastErr;
    }
    const data = JSON.parse(body) as Record<string, unknown>;
    let serviceUrl = gstr(getPath(data, ['webservices', 'premiummailsettings', 'url']));
    serviceUrl = serviceUrl.replace(/\/+$/, '');
    if (serviceUrl.endsWith(':443')) serviceUrl = serviceUrl.slice(0, -4);
    this.serviceUrl = serviceUrl;

    const dsInfo = getPath(data, ['dsInfo']);
    const dsObj = isRecord(dsInfo) ? dsInfo : {};
    this.dsid = gstr(dsObj['dsid']);
    const info: AccountInfo = {
      dsid: this.dsid,
      appleId: firstNonEmpty(
        gstr(dsObj['appleId']),
        gstr(dsObj['primaryEmail']),
        gstr(dsObj['appleIdEmail']),
      ),
      primaryEmail: firstNonEmpty(gstr(dsObj['primaryEmail']), gstr(dsObj['appleId'])),
      fullName: firstNonEmpty(gstr(dsObj['fullName']), gstr(dsObj['name'])),
      isManagedAppleId: dsObj['isManagedAppleId'] === true,
    };
    if (info.appleId === '') {
      for (const name of ['aosappleid', 'appleId', 'dsid']) {
        if (this.cookies[name]) {
          info.appleId = this.cookies[name];
          break;
        }
      }
    }
    this.accountInfo = info;
    this.log('会话有效 → %s', info.appleId !== '' ? info.appleId : '未知账号');
  }

  private async resolveService(): Promise<void> {
    if (this.serviceUrl === '') await this.validateSession();
  }

  async listAliases(): Promise<Alias[]> {
    await this.resolveService();
    const body = await this.request('GET', this.serviceUrl + '/v2/hme/list', null, 0, MAX_RETRIES);
    const aliases = parseAliasList(body);
    this.log('共 %d 个别名', aliases.length);
    return aliases;
  }

  async generate(): Promise<string> {
    await this.resolveService();
    const body = await this.request(
      'POST',
      this.serviceUrl + '/v1/hme/generate',
      { langCode: 'en-us' },
      0,
      2,
    );
    const parsed = safeJson(body);
    if (!parsed || parsed['success'] !== true) {
      const errMsg = gstr(getPath(parsed, ['error', 'errorMessage']));
      throw new Error(`生成失败: ${errMsg !== '' ? errMsg : 'unknown'}`);
    }
    let hme = gstr(getPath(parsed, ['result', 'hme']));
    if (hme === '') hme = gstr(getPath(parsed, ['result', 'hme', 'hme']));
    if (hme === '') hme = gstr(getPath(parsed, ['result', 'hme', 'email']));
    return hme;
  }

  async reserve(hme: string, label: string): Promise<string> {
    await this.resolveService();
    if (label === '') {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      label = `Created ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    const body = await this.request(
      'POST',
      this.serviceUrl + '/v1/hme/reserve',
      { hme, label, note: 'Created by icloud_hme tool' },
      0,
      2,
    );
    const parsed = safeJson(body);
    if (!parsed || parsed['success'] !== true) {
      const errMsg = gstr(getPath(parsed, ['error', 'errorMessage']));
      throw new Error(`保留失败: ${errMsg !== '' ? errMsg : 'unknown'}`);
    }
    let alias = hme;
    const resultHme = getPath(parsed, ['result', 'hme']);
    if (isRecord(resultHme)) {
      const v = gstr(resultHme['hme']);
      if (v !== '') alias = v;
    }
    return alias;
  }

  /**
   * Generate + Reserve, up to 5 rounds; each retry resets service/setup URLs
   * to force re-validation, with a 1s gap.
   */
  async createAlias(label: string, maxRetries = 5): Promise<CreateResult> {
    if (maxRetries <= 0) maxRetries = 5;
    let lastErr = '';
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        this.serviceUrl = '';
        this.setupUrl = '';
      }
      let hme: string;
      try {
        hme = await this.generate();
      } catch (err) {
        lastErr = 'generate 失败: ' + (err instanceof Error ? err.message : String(err));
        if (attempt < maxRetries - 1) {
          await sleep(1000);
          continue;
        }
        break;
      }
      let email: string;
      try {
        email = await this.reserve(hme, label);
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries - 1) {
          await sleep(1000);
          continue;
        }
        break;
      }
      return { email, label, created_at: new Date().toISOString() };
    }
    if (lastErr !== '') throw new Error(`创建别名失败: ${lastErr}`);
    throw new Error(`创建别名失败,已重试 ${maxRetries} 次`);
  }

  async deactivateHme(anonymousId: string): Promise<boolean> {
    await this.resolveService();
    const body = await this.request(
      'POST',
      this.serviceUrl + '/v1/hme/deactivate',
      { anonymousId },
      0,
      2,
    );
    const parsed = safeJson(body);
    return parsed?.['success'] === true;
  }

  async reactivateHme(anonymousId: string): Promise<boolean> {
    await this.resolveService();
    const body = await this.request(
      'POST',
      this.serviceUrl + '/v1/hme/reactivate',
      { anonymousId },
      0,
      2,
    );
    const parsed = safeJson(body);
    return parsed?.['success'] === true;
  }

  /**
   * Delete an alias. If the direct delete fails (request error or
   * success=false), deactivate first and delete again; the second failure
   * surfaces the upstream error.errorMessage (possibly empty).
   */
  async deleteAlias(anonymousId: string): Promise<void> {
    await this.resolveService();
    const payload = { anonymousId };
    const doDelete = () =>
      this.request('POST', this.serviceUrl + '/v1/hme/delete', payload, 0, 2);
    let body: string | null = null;
    let err: Error | null = null;
    try {
      body = await doDelete();
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    const ok = body !== null && safeJson(body)?.['success'] === true;
    if (err !== null || !ok) {
      await this.request('POST', this.serviceUrl + '/v1/hme/deactivate', payload, 0, 2).catch(
        () => undefined,
      );
      body = await doDelete();
      if (safeJson(body)?.['success'] !== true) {
        throw new Error(gstr(getPath(safeJson(body), ['error', 'errorMessage'])));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Alias list parsing (parseAliasList / findFirstDictArray)
// ---------------------------------------------------------------------------

export function parseAliasList(body: string): Alias[] {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return [];
  }
  let arr: unknown = getPath(root, ['result', 'hmeEmails']);
  if (!Array.isArray(arr)) arr = findFirstDictArray(root);
  if (!Array.isArray(arr)) return [];

  const aliases: Alias[] = [];
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const meta = isRecord(item['metaData']) ? (item['metaData'] as Record<string, unknown>) : {};
    const email = firstNonEmpty(
      gstr(item['hme']),
      gstr(item['email']),
      gstr(item['alias']),
      gstr(item['address']),
      gstr(meta['hme']),
    )
      .trim()
      .toLowerCase();
    if (email === '' || !email.includes('@')) continue;
    const state = firstNonEmpty(gstr(item['state']), gstr(item['status'])).toLowerCase();
    let active = state !== 'inactive' && state !== 'deleted';
    if ('active' in item) active = toBool(item['active']) && active;
    if ('isActive' in item) active = toBool(item['isActive']) && active;
    aliases.push({
      email,
      anonymousId: firstNonEmpty(gstr(item['anonymousId']), gstr(item['id'])),
      label: firstNonEmpty(gstr(item['label']), gstr(meta['label'])),
      active,
      createdAt: firstNonEmpty(gstr(item['createTimestamp']), gstr(item['createdAt'])),
    });
  }
  aliases.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });
  return aliases;
}

function findFirstDictArray(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (v.length > 0 && isRecord(v[0])) return v;
    return undefined;
  }
  if (isRecord(v)) {
    for (const val of Object.values(v)) {
      const found = findFirstDictArray(val);
      if (Array.isArray(found) && found.length > 0) return found;
    }
  }
  return undefined;
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  if (typeof v === 'number') return v !== 0;
  return false;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function getPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function safeJson(body: string | null | undefined): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
