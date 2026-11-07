import type { AccountManager, InboxResult } from './account/manager.js';
import type { AccountSummary } from './account/types.js';
import type { Alias, CreateResult } from './hme/client.js';
import type { FullMessage } from './mail/client.js';
import {
  BackendError,
  classifyLoginErr,
  classifyUpstreamErr,
  mapAccountErr,
} from './errors.js';

/**
 * Backend adapter — port of internal/server/backend.go.
 *
 * Translates manager errors into stable BackendErrors with fixed messages.
 * Upstream response bodies are never concatenated into user-visible messages.
 */
export class Backend {
  constructor(private readonly mgr: AccountManager) {}

  listAccounts(): AccountSummary[] {
    return this.mgr.listAccounts();
  }

  async addAccount(input: {
    name: string;
    icloud_email: string;
    cookieInput: string;
    host: string;
    proxy: string;
  }): Promise<AccountSummary> {
    try {
      return await this.mgr.addAccount(input);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw new BackendError(
        400,
        'VALIDATION_ERROR',
        err instanceof Error ? err.message : '参数错误',
      );
    }
  }

  updateAccount(
    id: string,
    input: { name?: string; icloud_email?: string; host?: string },
  ): AccountSummary {
    try {
      return this.mgr.updateAccount(id, input);
    } catch (err) {
      throw mapIfPlain(err);
    }
  }

  updateProxy(id: string, proxy: string): AccountSummary {
    try {
      return this.mgr.setProxy(id, proxy);
    } catch (err) {
      throw mapIfPlain(err);
    }
  }

  async updateCookies(id: string, cookies: string): Promise<AccountSummary> {
    try {
      return await this.mgr.setCookies(id, cookies);
    } catch (err) {
      throw mapIfPlain(err);
    }
  }

  async setAppPassword(
    id: string,
    icloudEmail: string,
    appPassword: string,
  ): Promise<AccountSummary> {
    try {
      return await this.mgr.setAppPassword(id, icloudEmail, appPassword);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('账号不存在')) {
        throw new BackendError(404, 'ACCOUNT_NOT_FOUND', '账号不存在');
      }
      if (msg.includes('不能为空')) {
        throw new BackendError(400, 'VALIDATION_ERROR', msg);
      }
      throw new BackendError(
        502,
        'UPSTREAM_FAILURE',
        'IMAP 验证失败,请检查邮箱与 App 专用密码',
      );
    }
  }

  async setMailbox(
    id: string,
    config: {
      provider: string;
      email: string;
      imap_host: string;
      imap_port: number;
      password: string;
    },
  ): Promise<AccountSummary> {
    try {
      return await this.mgr.setMailbox(id, config);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('账号不存在')) {
        throw new BackendError(404, 'ACCOUNT_NOT_FOUND', '账号不存在');
      }
      throw new BackendError(
        502,
        'UPSTREAM_FAILURE',
        '收件邮箱验证失败,请检查邮箱、授权码和 IMAP 配置',
      );
    }
  }

  async loginAccount(
    id: string,
    password: string,
    otpCode: string,
  ): Promise<AccountSummary> {
    try {
      return await this.mgr.loginWithPassword(id, password, otpCode);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw classifyLoginErr(err instanceof Error ? err : new Error(String(err)));
    }
  }

  removeAccount(id: string): boolean {
    try {
      this.mgr.deleteAccount(id);
      return true;
    } catch {
      return false;
    }
  }

  async createAlias(accountId: string, label: string): Promise<CreateResult> {
    try {
      const result = await this.mgr.createAlias(accountId, label);
      return { email: result.email, label: result.label, created_at: result.created_at };
    } catch (err) {
      if (err instanceof BackendError) throw err;
      if (err instanceof Error && err.message.includes('账号不存在')) {
        throw mapAccountErr(err);
      }
      throw classifyUpstreamErr(
        '创建邮箱失败',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  async listAliases(accountId: string): Promise<Alias[]> {
    try {
      return await this.mgr.listAliases(accountId);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      if (err instanceof Error && err.message.includes('账号不存在')) {
        throw mapAccountErr(err);
      }
      throw classifyUpstreamErr(
        '获取别名列表失败',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  async setAliasActive(
    accountId: string,
    anonymousId: string,
    active: boolean,
  ): Promise<boolean> {
    try {
      return active
        ? await this.mgr.reactivateAlias(accountId, anonymousId)
        : await this.mgr.deactivateAlias(accountId, anonymousId);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      if (err instanceof Error && err.message.includes('账号不存在')) {
        throw mapAccountErr(err);
      }
      throw classifyUpstreamErr(
        active ? '激活失败' : '停用失败',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  async deleteAlias(accountId: string, anonymousId: string): Promise<void> {
    try {
      await this.mgr.deleteAlias(accountId, anonymousId);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      if (err instanceof Error && err.message.includes('账号不存在')) {
        throw mapAccountErr(err);
      }
      throw classifyUpstreamErr(
        '删除失败',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  async listInbox(q: {
    accountId: string;
    alias: string;
    limit: number;
    days: number;
  }): Promise<InboxResult & { account_id: string; alias?: string; count: number }> {
    const result = await this.mgr.listInbox(q.accountId, q.alias, q.limit, q.days);
    return {
      account_id: q.accountId,
      ...(q.alias !== '' ? { alias: q.alias } : {}),
      count: result.messages.length,
      messages: result.messages,
      method: result.method,
    };
  }

  async getMessage(accountId: string, uid: number): Promise<FullMessage> {
    try {
      return await this.mgr.getMessage(accountId, String(uid));
    } catch (err) {
      throw mapIfPlain(err);
    }
  }

  async deleteMessage(accountId: string, uid: number): Promise<void> {
    try {
      await this.mgr.deleteMessage(accountId, String(uid));
    } catch (err) {
      throw mapIfPlain(err);
    }
  }

  /** With SQLite the manager reads the DB on every call; reload is a no-op. */
  reload(): void {
    return;
  }
}

function mapIfPlain(err: unknown): BackendError {
  if (err instanceof BackendError) return err;
  return mapAccountErr(err instanceof Error ? err : new Error(String(err)));
}
