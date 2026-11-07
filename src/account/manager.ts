import { randomUUID } from 'node:crypto';
import type { AccountStore } from './store.js';
import type { Account, AccountSummary, MailboxConfig } from './types.js';
import {
  deriveICloudEmail,
  firstNonEmpty,
  isICloudDomain,
  parseCookieInput,
  statusRank,
  toSummary,
  truncateBytes,
  validateEmail,
  validateHost,
  validateName,
  validateProxy,
} from './validation.js';
import { HmeClient } from '../hme/client.js';
import type { Alias, CreateResult } from '../hme/client.js';
import { loginWithPassword as srpLogin } from '../hme/auth.js';
import type { UpstreamFetch } from '../hme/http.js';
import { MailClient } from '../mail/client.js';
import type { Message, FullMessage } from '../mail/client.js';
import { MailPool } from '../mail/pool.js';
import { BackendError } from '../errors.js';
import { WebMailClient } from '../mail/webClient.js';

/**
 * Account manager — port of internal/account/manager.go.
 *
 * Storage is SQLite (this project's deviation from Go's accounts.json).
 * All reads go through the store on every call, so POST /api/reload is a
 * no-op success.
 *
 * Two cookie-validation paths exist in Go and are kept distinct:
 *  - validateCookies (newAccount): refreshes alias counts on success.
 *  - UpdateCookies (PUT /cookies): prefixed error messages, no alias refresh.
 */

export interface ManagerOptions {
  store: AccountStore;
  pool?: MailPool;
  /** Injected upstream fetches (tests). Production defaults to wreq-js. */
  hmeFetch?: UpstreamFetch;
  authFetch?: UpstreamFetch;
  webFetch?: UpstreamFetch;
  mailClientFactory?: (user: string, pass: string) => MailClient;
}

export interface InboxResult {
  messages: Message[];
  method: 'imap' | 'web_api';
}

function nowIso(): string {
  return new Date().toISOString();
}

export class AccountManager {
  private readonly store: AccountStore;
  private readonly pool: MailPool;
  private readonly hmeFetch?: UpstreamFetch;
  private readonly authFetch?: UpstreamFetch;
  private readonly webFetch?: UpstreamFetch;
  private readonly mailClientFactory: (user: string, pass: string) => MailClient;

  constructor(opts: ManagerOptions) {
    this.store = opts.store;
    this.pool = opts.pool ?? new MailPool();
    this.hmeFetch = opts.hmeFetch;
    this.authFetch = opts.authFetch;
    this.webFetch = opts.webFetch;
    this.mailClientFactory =
      opts.mailClientFactory ?? ((u, p) => new MailClient(u, p));
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  listAccounts(): AccountSummary[] {
    const accounts = this.store.list();
    accounts.sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      if (r !== 0) return r;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return accounts.map(toSummary);
  }

  getAccount(id: string): Account {
    const a = this.store.get(id);
    if (!a) throw new Error('账号不存在');
    return a;
  }

  async addAccount(input: {
    name: string;
    icloud_email: string;
    cookieInput: string;
    host: string;
    proxy: string;
  }): Promise<AccountSummary> {
    const name = validateName(input.name);
    validateEmail(input.icloud_email);
    const host = validateHost(input.host);
    const proxy = validateProxy(input.proxy);
    let cookies: Record<string, string> = {};
    if (input.cookieInput !== '') {
      cookies = parseCookieInput(input.cookieInput);
    }
    const now = nowIso();
    const account: Account = {
      id: 'acc_' + randomUUID().replace(/-/g, '').slice(0, 8),
      name,
      real_email: input.icloud_email.trim(),
      icloud_email: input.icloud_email.trim(),
      cookies,
      host,
      proxy,
      app_password: '',
      mailbox: null,
      status: 'pending',
      alias_total: 0,
      alias_active: 0,
      last_validated: '',
      last_error: '',
      created_at: now,
      updated_at: now,
    };
    this.store.insert(account);
    if (Object.keys(cookies).length > 0) {
      await this.validateCookies(account);
    }
    return toSummary(this.store.get(account.id) ?? account);
  }

  updateAccount(
    id: string,
    input: { name?: string; icloud_email?: string; host?: string },
  ): AccountSummary {
    // Go validates fields before checking account existence.
    if (
      input.name === undefined &&
      input.icloud_email === undefined &&
      input.host === undefined
    ) {
      throw new Error('至少需要提供一个可编辑字段');
    }
    const name = input.name !== undefined ? validateName(input.name) : undefined;
    if (input.icloud_email !== undefined) validateEmail(input.icloud_email);
    const host = input.host !== undefined ? validateHost(input.host) : undefined;
    const account = this.getAccount(id);
    if (name !== undefined) account.name = name;
    if (input.icloud_email !== undefined) {
      account.icloud_email = input.icloud_email.trim();
    }
    if (host !== undefined) account.host = host;
    account.updated_at = nowIso();
    this.store.update(account);
    return toSummary(account);
  }

  setProxy(id: string, proxy: string): AccountSummary {
    // Go validates the proxy before checking account existence.
    const validated = validateProxy(proxy);
    const account = this.getAccount(id);
    account.proxy = validated;
    account.updated_at = nowIso();
    this.store.update(account);
    return toSummary(account);
  }

  /**
   * UpdateCookies (PUT /cookies): prefixed error messages, no alias refresh.
   * A validation failure still returns the summary with status=error (Go
   * quirk: only client-construction errors throw — and in this port the
   * wreq-js transport is created lazily, so construction never throws here).
   */
  async setCookies(id: string, cookieInput: string): Promise<AccountSummary> {
    const account = this.getAccount(id);
    const cookies = parseCookieInput(cookieInput);
    account.cookies = cookies;
    const client = this.newHmeClient(account);
    try {
      await client.validateSession();
      const info = client.getAccountInfo();
      account.cookies = { ...client.cookies };
      account.status = 'active';
      account.last_validated = nowIso();
      account.last_error = '';
      if (info) {
        account.real_email = firstNonEmpty(info.appleId, info.primaryEmail);
        if (account.icloud_email === '') {
          account.icloud_email = deriveICloudEmail(info);
        }
      }
    } catch (err) {
      account.cookies = { ...client.cookies };
      account.status = 'error';
      account.last_error = truncateBytes(
        'Cookie 校验失败: ' + (err instanceof Error ? err.message : String(err)),
        300,
      );
    } finally {
      await client.close().catch(() => undefined);
    }
    account.updated_at = nowIso();
    this.store.update(account);
    return toSummary(account);
  }

  async setAppPassword(
    id: string,
    icloudEmail: string,
    appPassword: string,
  ): Promise<AccountSummary> {
    if (icloudEmail.trim() === '') throw new Error('iCloud 邮箱不能为空');
    if (appPassword.trim() === '') throw new Error('App 专用密码不能为空');
    const account = this.getAccount(id);
    const email = icloudEmail.trim();
    const client = this.mailClientFactory(email, appPassword.trim());
    try {
      await client.connect();
      await client.inboxCount();
    } finally {
      await client.close().catch(() => undefined);
    }
    account.icloud_email = email;
    account.app_password = appPassword.trim();
    account.updated_at = nowIso();
    this.store.update(account);
    return toSummary(account);
  }

  async setMailbox(id: string, mailbox: MailboxConfig): Promise<AccountSummary> {
    // Field validation first, then account existence, then live IMAP test.
    const email = mailbox.email.trim();
    const imapHost = mailbox.imap_host.trim();
    const password = mailbox.password ?? '';
    if (email === '' || imapHost === '' || password === '') {
      throw new Error('收件邮箱、IMAP 服务器和授权码不能为空');
    }
    if (
      imapHost.includes('://') ||
      mailbox.imap_port < 1 ||
      mailbox.imap_port > 65535
    ) {
      throw new Error('IMAP 服务器或端口无效');
    }
    const account = this.getAccount(id);
    const direct = new MailClient(email, password, imapHost, mailbox.imap_port);
    try {
      await direct.connect();
      await direct.inboxCount();
    } finally {
      await direct.close().catch(() => undefined);
    }
    account.mailbox = {
      provider: mailbox.provider.trim(),
      email,
      imap_host: imapHost,
      imap_port: mailbox.imap_port,
      password,
    };
    account.updated_at = nowIso();
    this.store.update(account);
    return toSummary(account);
  }

  deleteAccount(id: string): void {
    this.getAccount(id);
    this.store.delete(id);
  }

  // -------------------------------------------------------------------------
  // Cookie validation (newAccount path — refreshes alias counts)
  // -------------------------------------------------------------------------

  private newHmeClient(account: Account): HmeClient {
    return new HmeClient({
      cookies: account.cookies,
      host: account.host,
      proxy: account.proxy,
      fetchFn: this.hmeFetch,
      authFetchFn: this.authFetch,
    });
  }

  async validateCookies(account: Account): Promise<void> {
    const client = this.newHmeClient(account);
    try {
      await client.validateSession();
      const info = client.getAccountInfo();
      account.cookies = { ...client.cookies };
      account.status = 'active';
      if (info) {
        account.real_email = firstNonEmpty(info.appleId, info.primaryEmail);
        if (account.icloud_email === '') {
          account.icloud_email = deriveICloudEmail(info);
        }
      }
      // Alias refresh: a ListAliases failure does NOT fail validation (Go).
      // Deviation: AliasActive is reset before counting (Go only increments,
      // so repeated validations accumulate stale actives).
      try {
        const aliases = await client.listAliases();
        account.alias_total = aliases.length;
        account.alias_active = 0;
        for (const a of aliases) {
          if (a.active) account.alias_active++;
        }
      } catch {
        // keep previous counts
      }
      account.last_validated = nowIso();
      account.updated_at = nowIso();
      this.store.update(account);
    } catch (err) {
      account.cookies = { ...client.cookies };
      account.status = 'error';
      account.last_error = truncateBytes(
        err instanceof Error ? err.message : String(err),
        300,
      );
      account.updated_at = nowIso();
      this.store.update(account);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // iCloud password login (HMEClientWithPassword)
  // -------------------------------------------------------------------------

  /**
   * SRP login, then SaveCookies → ValidateSession (on failure, save cookies
   * again and return the error) → save cookies + status=active +
   * LastValidated + clear LastError + backfill identity.
   */
  async loginWithPassword(
    id: string,
    password: string,
    otpCode: string,
  ): Promise<AccountSummary> {
    const account = this.getAccount(id);
    let email = account.icloud_email;
    if (email === '') email = account.real_email;
    if (email === '') throw new Error('账号未设置邮箱地址');
    const client = new HmeClient({
      cookies: {},
      host: account.host,
      proxy: account.proxy,
      fetchFn: this.hmeFetch,
      authFetchFn: this.authFetch,
    });
    try {
      await srpLogin(
        client,
        email,
        password,
        otpCode !== '' ? async () => otpCode : null,
      );
      account.cookies = { ...client.cookies };
      this.store.update(account);
      try {
        await client.validateSession();
      } catch (err) {
        account.cookies = { ...client.cookies };
        this.store.update(account);
        throw err;
      }
      const info = client.getAccountInfo();
      account.cookies = { ...client.cookies };
      account.status = 'active';
      account.last_validated = nowIso();
      account.last_error = '';
      if (info) {
        account.real_email = firstNonEmpty(info.appleId, info.primaryEmail);
        if (account.icloud_email === '') {
          account.icloud_email = deriveICloudEmail(info);
        }
      }
      account.updated_at = nowIso();
      this.store.update(account);
      return toSummary(account);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Mail
  // -------------------------------------------------------------------------

  private imapCreds(account: Account): { email: string; password: string } {
    let email = account.icloud_email;
    if (email === '') email = account.real_email;
    if (!isICloudDomain(email)) {
      throw new Error(`账号未设置 iCloud 邮箱 (当前: ${email})`);
    }
    if (account.app_password === '') {
      throw new Error('账号未设置 App 专用密码');
    }
    return { email, password: account.app_password };
  }

  /** Fresh IMAP client (never pooled) — MailClient in Go. */
  private freshMailClient(account: Account): MailClient {
    if (account.mailbox && account.mailbox.email !== '' && account.mailbox.password) {
      return new MailClient(
        account.mailbox.email,
        account.mailbox.password,
        account.mailbox.imap_host,
        account.mailbox.imap_port,
      );
    }
    const { email, password } = this.imapCreds(account);
    return this.mailClientFactory(email, password);
  }

  /** WithMailClient: external mailbox → fresh client each time; else pooled. */
  private async withMailClient<T>(
    account: Account,
    fn: (client: MailClient) => Promise<T>,
  ): Promise<T> {
    if (account.mailbox && account.mailbox.email !== '' && account.mailbox.password) {
      const mc = new MailClient(
        account.mailbox.email,
        account.mailbox.password,
        account.mailbox.imap_host,
        account.mailbox.imap_port,
      );
      try {
        await mc.connect();
        return await fn(mc);
      } finally {
        await mc.close().catch(() => undefined);
      }
    }
    const { email, password } = this.imapCreds(account);
    const mc = await this.pool.get(email, password);
    return fn(mc);
  }

  private newWebMailClient(account: Account): WebMailClient {
    if (Object.keys(account.cookies).length === 0) {
      throw new Error('账号未配置 Cookie，无法读取邮件');
    }
    let dsid = '';
    const userCookie = account.cookies['X-APPLE-WEBAUTH-USER'];
    if (userCookie) {
      const parts = userCookie.split(':d=');
      if (parts.length === 2) dsid = parts[1];
    }
    return new WebMailClient({
      cookies: account.cookies,
      host: account.host,
      dsid,
      fetchFn: this.webFetch,
    });
  }

  /**
   * ListInbox strategy: IMAP first via pool — success returns method="imap"
   * even if empty. On IMAP error → Web API; web client creation failure →
   * 400 "无可用邮件客户端: 需要 App Password 或 Cookie"; web list failure →
   * 502 "读取邮件失败".
   */
  async listInbox(
    accountId: string,
    alias: string,
    limit: number,
    days: number,
  ): Promise<InboxResult> {
    const account = this.getAccount(accountId);
    try {
      const messages = await this.withMailClient(account, (mc) =>
        alias !== ''
          ? mc.findByRecipient(alias, limit, days)
          : mc.listInbox(limit, days),
      );
      return { messages, method: 'imap' };
    } catch (imapErr) {
      let web: WebMailClient;
      try {
        web = this.newWebMailClient(account);
      } catch {
        throw new BackendError(
          400,
          'VALIDATION_ERROR',
          '无可用邮件客户端: 需要 App Password 或 Cookie',
        );
      }
      try {
        const gateway = await web.resolveMccGateway();
        const messages =
          alias !== ''
            ? await web.findByAlias(gateway, alias, limit)
            : await web.search(gateway, limit);
        return { messages, method: 'web_api' };
      } catch {
        throw new BackendError(502, 'UPSTREAM_FAILURE', '读取邮件失败');
      } finally {
        await web.close().catch(() => undefined);
      }
    }
  }

  /** GetMessage / DeleteMessage are IMAP-only (no web fallback). */
  async getMessage(accountId: string, messageId: string): Promise<FullMessage> {
    const account = this.getAccount(accountId);
    const uid = parseMessageId(messageId);
    const client = this.freshMailClient(account);
    try {
      try {
        await client.connect();
      } catch {
        throw new BackendError(502, 'UPSTREAM_FAILURE', '读取邮件失败');
      }
      try {
        return await client.getFull(uid);
      } catch {
        throw new BackendError(502, 'UPSTREAM_FAILURE', '读取邮件详情失败');
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async deleteMessage(accountId: string, messageId: string): Promise<void> {
    const account = this.getAccount(accountId);
    const uid = parseMessageId(messageId);
    const client = this.freshMailClient(account);
    try {
      try {
        await client.connect();
      } catch {
        throw new BackendError(502, 'UPSTREAM_FAILURE', '删除邮件失败');
      }
      try {
        await client.deleteMessage(uid);
      } catch {
        throw new BackendError(502, 'UPSTREAM_FAILURE', '删除邮件失败');
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Aliases
  // -------------------------------------------------------------------------

  /** Persist Set-Cookie refreshes after an HME operation (SaveCookies). */
  private saveCookies(id: string, cookies: Record<string, string>): void {
    const a = this.store.get(id);
    if (!a) return;
    a.cookies = { ...cookies };
    a.updated_at = nowIso();
    this.store.update(a);
  }

  async listAliases(accountId: string): Promise<Alias[]> {
    const account = this.getAccount(accountId);
    const client = this.newHmeClient(account);
    try {
      return await client.listAliases();
    } finally {
      this.saveCookies(accountId, client.cookies);
      await client.close().catch(() => undefined);
    }
  }

  async createAlias(accountId: string, label: string): Promise<CreateResult & { account_id: string }> {
    const account = this.getAccount(accountId);
    const client = this.newHmeClient(account);
    try {
      const result = await client.createAlias(label);
      return { ...result, account_id: accountId };
    } finally {
      this.saveCookies(accountId, client.cookies);
      await client.close().catch(() => undefined);
    }
  }

  async deactivateAlias(accountId: string, anonymousId: string): Promise<boolean> {
    const account = this.getAccount(accountId);
    const client = this.newHmeClient(account);
    try {
      return await client.deactivateHme(anonymousId);
    } finally {
      this.saveCookies(accountId, client.cookies);
      await client.close().catch(() => undefined);
    }
  }

  async reactivateAlias(accountId: string, anonymousId: string): Promise<boolean> {
    const account = this.getAccount(accountId);
    const client = this.newHmeClient(account);
    try {
      return await client.reactivateHme(anonymousId);
    } finally {
      this.saveCookies(accountId, client.cookies);
      await client.close().catch(() => undefined);
    }
  }

  async deleteAlias(accountId: string, anonymousId: string): Promise<void> {
    const account = this.getAccount(accountId);
    const client = this.newHmeClient(account);
    try {
      await client.deleteAlias(anonymousId);
    } finally {
      this.saveCookies(accountId, client.cookies);
      await client.close().catch(() => undefined);
    }
  }
}

function parseMessageId(messageId: string): number {
  if (!/^\d+$/.test(messageId.trim())) {
    throw new Error('邮件 ID 无效');
  }
  const uid = parseInt(messageId, 10);
  if (uid < 1 || uid > 4294967295) throw new Error('邮件 ID 无效');
  return uid;
}
