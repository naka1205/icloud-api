import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthManager } from './auth/manager.js';
import type { LoginLimiter } from './auth/limiter.js';
import { Backend } from './backend.js';
import { parseInboxInt } from './errors.js';
import { backendFail, fail, ok } from './response.js';
import {
  clearSessionCookie,
  requireCsrf,
  requireSession,
  setSessionCookie,
} from './middleware.js';

export interface RouteContext {
  auth: AuthManager;
  limiter: LoginLimiter;
  backend: Backend;
  secureCookie: boolean;
}

type Body = Record<string, unknown>;

function bodyOf(req: FastifyRequest): Body {
  const b = req.body;
  if (b === null || b === undefined) return {};
  if (typeof b === 'object' && !Array.isArray(b)) return b as Body;
  return {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function queryOf(req: FastifyRequest): Record<string, string> {
  const q = req.query as Record<string, unknown> | undefined;
  const out: Record<string, string> = {};
  if (q) {
    for (const [k, v] of Object.entries(q)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

function paramOf(req: FastifyRequest, name: string): string {
  const p = req.params as Record<string, unknown> | undefined;
  const v = p?.[name];
  return typeof v === 'string' ? v : '';
}

export function registerRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  ctx: RouteContext,
): void {
  const { auth, limiter, backend } = ctx;
  const session = requireSession(auth);
  const csrf = requireCsrf(auth);

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  app.post('/api/auth/login', async (req, reply) => {
    const password = str(bodyOf(req)['password']);
    if (password === '') {
      fail(reply, 400, 'VALIDATION_ERROR', '参数错误');
      return;
    }
    const ip = req.ip;
    const { allowed, retryAfterMs } = limiter.allow(ip);
    if (!allowed) {
      const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
      void reply.header('Retry-After', String(secs));
      fail(reply, 429, 'RATE_LIMITED', '登录尝试过于频繁,请稍后再试');
      return;
    }
    const result = auth.login(password);
    if (!result) {
      fail(reply, 401, 'INVALID_CREDENTIALS', '管理员密码错误');
      return;
    }
    limiter.success(ip);
    setSessionCookie(reply, result.sessionId, result.session.expiresAt, ctx.secureCookie);
    ok(reply, {
      csrf_token: result.session.csrfToken,
      expires_at: result.session.expiresAt.toISOString(),
    });
  });

  app.get(
    '/api/auth/session',
    { preHandler: [session] },
    async (req, reply) => {
      const sessionId = (req as unknown as { sessionId?: string }).sessionId;
      if (!sessionId) {
        fail(reply, 401, 'AUTH_REQUIRED', '请先登录');
        return;
      }
      const session = auth.validate(sessionId);
      if (!session) {
        fail(reply, 401, 'AUTH_REQUIRED', '会话已失效,请重新登录');
        return;
      }
      ok(reply, {
        csrf_token: session.csrfToken,
        expires_at: session.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/api/auth/logout',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const sessionId = (req as unknown as { sessionId?: string }).sessionId;
      if (sessionId) auth.logout(sessionId);
      clearSessionCookie(reply);
      ok(reply, { logged_out: true });
    },
  );

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  app.get('/api/accounts', { preHandler: [session] }, async (_req, reply) => {
    ok(reply, backend.listAccounts());
  });

  app.post(
    '/api/accounts',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const b = bodyOf(req);
      const cookiesRaw = b['cookies'];
      let cookieInput = '';
      if (typeof cookiesRaw === 'string') cookieInput = cookiesRaw;
      else if (cookiesRaw !== null && typeof cookiesRaw === 'object') {
        cookieInput = JSON.stringify(cookiesRaw);
      }
      try {
        const sum = await backend.addAccount({
          name: str(b['name']),
          icloud_email: str(b['icloud_email']),
          cookieInput,
          host: str(b['host']),
          proxy: str(b['proxy']),
        });
        ok(reply, sum, 201);
      } catch (err) {
        backendFail(reply, err);
      }
    },
  );

  app.patch(
    '/api/accounts/:id',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const b = bodyOf(req);
      const input: { name?: string; icloud_email?: string; host?: string } = {};
      if (typeof b['name'] === 'string') input.name = b['name'];
      if (typeof b['icloud_email'] === 'string') input.icloud_email = b['icloud_email'];
      if (typeof b['host'] === 'string') input.host = b['host'];
      try {
        ok(reply, backend.updateAccount(paramOf(req, 'id'), input));
      } catch (err) {
        backendFail(reply, err);
      }
    },
  );

  app.put(
    '/api/accounts/:id/proxy',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const b = bodyOf(req);
      if (typeof b['proxy'] !== 'string') {
        fail(reply, 400, 'VALIDATION_ERROR', '参数错误');
        return;
      }
      try {
        ok(reply, backend.updateProxy(paramOf(req, 'id'), b['proxy']));
      } catch (err) {
        backendFail(reply, err);
      }
    },
  );

  app.put(
    '/api/accounts/:id/cookies',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const b = bodyOf(req);
      const cookiesRaw = b['cookies'];
      if (cookiesRaw === undefined || cookiesRaw === null) {
        fail(reply, 400, 'VALIDATION_ERROR', '参数错误: cookies 必填');
        return;
      }
      let raw: string;
      if (typeof cookiesRaw === 'string') {
        raw = cookiesRaw;
      } else if (typeof cookiesRaw === 'object') {
        raw = JSON.stringify(cookiesRaw);
      } else {
        fail(reply, 400, 'VALIDATION_ERROR', '参数错误: cookies 格式无效');
        return;
      }
      try {
        ok(reply, await backend.updateCookies(paramOf(req, 'id'), raw));
      } catch (err) {
        backendFail(reply, err);
      }
    },
  );

  app.post(
    '/api/accounts/:id/password',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const b = bodyOf(req);
      const email = str(b['icloud_email']);
      const appPassword = str(b['app_password']);
      if (email === '' || appPassword === '') {
        fail(reply, 400, 'VALIDATION_ERROR', '参数错误: icloud_email, app_password 必填');
        return;
      }
      try {
        ok(reply, await backend.setAppPassword(paramOf(req, 'id'), email, appPassword));
      } catch (err) {
        backendFail(reply, err);
      }
    },
  );

  app.put(
    '/api/accounts/:id/mailbox',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const b = bodyOf(req);
      const email = str(b['email']);
      const imapHost = str(b['imap_host']);
      const imapPort = b['imap_port'];
      const authCode = str(b['authorization_code']);
      if (
        email === '' ||
        imapHost === '' ||
        typeof imapPort !== 'number' ||
        imapPort < 1 ||
        authCode === ''
      ) {
        fail(
          reply,
          400,
          'VALIDATION_ERROR',
          '参数错误: 收件邮箱、IMAP 服务器、端口和授权码必填',
        );
        return;
      }
      try {
        ok(
          reply,
          await backend.setMailbox(paramOf(req, 'id'), {
            provider: str(b['provider']),
            email,
            imap_host: imapHost,
            imap_port: imapPort,
            password: authCode,
          }),
        );
      } catch (err) {
        backendFail(reply, err);
      }
    },
  );

  app.post(
    '/api/accounts/:id/login',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const b = bodyOf(req);
      const password = str(b['password']);
      if (password === '') {
        fail(reply, 400, 'VALIDATION_ERROR', '参数错误: password 必填');
        return;
      }
      try {
        ok(
          reply,
          await backend.loginAccount(paramOf(req, 'id'), password, str(b['otp_code'])),
        );
      } catch (err) {
        backendFail(reply, err);
      }
    },
  );

  app.delete(
    '/api/accounts/:id',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const id = paramOf(req, 'id');
      if (!backend.removeAccount(id)) {
        fail(reply, 404, 'ACCOUNT_NOT_FOUND', '账号不存在');
        return;
      }
      ok(reply, { id });
    },
  );

  // -------------------------------------------------------------------------
  // Business: create alias
  // -------------------------------------------------------------------------

  app.post('/api/create', { preHandler: [session, csrf] }, async (req, reply) => {
    const b = bodyOf(req);
    const accountId = str(b['account_id']);
    if (accountId === '') {
      fail(reply, 400, 'VALIDATION_ERROR', '参数错误: account_id 必填');
      return;
    }
    const label = str(b['label']);
    if ([...label].length > 200) {
      fail(reply, 400, 'VALIDATION_ERROR', '参数错误: label 最长 200 字符');
      return;
    }
    try {
      const result = await backend.createAlias(accountId, label);
      ok(reply, {
        email: result.email,
        label: result.label,
        created_at: result.created_at,
        account_id: accountId,
      });
    } catch (err) {
      backendFail(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // Business: inbox
  // -------------------------------------------------------------------------

  app.get('/api/inbox', { preHandler: [session] }, async (req, reply) => {
    const q = queryOf(req);
    const accountId = q['account_id'] ?? '';
    if (accountId === '') {
      fail(reply, 400, 'VALIDATION_ERROR', '参数缺失: account_id');
      return;
    }
    const alias = (q['alias'] ?? '').trim();
    let limit: number;
    let days: number;
    try {
      limit = parseInboxInt(q['limit'] ?? '20', 1, 100);
    } catch {
      fail(reply, 400, 'VALIDATION_ERROR', '参数错误: limit 需为 1-100 的整数');
      return;
    }
    try {
      days = parseInboxInt(q['days'] ?? '7', 1, 90);
    } catch {
      fail(reply, 400, 'VALIDATION_ERROR', '参数错误: days 需为 1-90 的整数');
      return;
    }
    try {
      ok(reply, await backend.listInbox({ accountId, alias, limit, days }));
    } catch (err) {
      backendFail(reply, err);
    }
  });

  app.get('/api/inbox/:message_id', { preHandler: [session] }, async (req, reply) => {
    const q = queryOf(req);
    const accountId = q['account_id'] ?? '';
    const uid = parseUid(paramOf(req, 'message_id'));
    if (accountId === '' || uid === null) {
      fail(reply, 400, 'VALIDATION_ERROR', 'account_id 或邮件 ID 无效');
      return;
    }
    try {
      ok(reply, await backend.getMessage(accountId, uid));
    } catch (err) {
      backendFail(reply, err);
    }
  });

  app.delete(
    '/api/inbox/:message_id',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const q = queryOf(req);
      const accountId = q['account_id'] ?? '';
      const messageId = paramOf(req, 'message_id');
      const uid = parseUid(messageId);
      if (accountId === '' || uid === null) {
        fail(reply, 400, 'VALIDATION_ERROR', 'account_id 或邮件 ID 无效');
        return;
      }
      try {
        await backend.deleteMessage(accountId, uid);
        ok(reply, { id: messageId });
      } catch (err) {
        backendFail(reply, err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Aliases
  // -------------------------------------------------------------------------

  app.get('/api/aliases', { preHandler: [session] }, async (req, reply) => {
    const q = queryOf(req);
    const accountId = q['account_id'] ?? '';
    if (accountId === '') {
      fail(reply, 400, 'VALIDATION_ERROR', '参数缺失: account_id');
      return;
    }
    try {
      const aliases = await backend.listAliases(accountId);
      ok(reply, { account_id: accountId, count: aliases.length, aliases });
    } catch (err) {
      backendFail(reply, err);
    }
  });

  const aliasAction = (
    active: boolean,
  ): ((req: FastifyRequest, reply: FastifyReply) => Promise<void>) => {
    return async (req, reply) => {
      const anonymousId = paramOf(req, 'id');
      const accountId = str(bodyOf(req)['account_id']);
      if (accountId === '') {
        fail(reply, 400, 'VALIDATION_ERROR', '参数错误: account_id 必填');
        return;
      }
      if (anonymousId === '' || anonymousId.length > 256) {
        fail(reply, 400, 'VALIDATION_ERROR', '参数错误: anonymous id 无效');
        return;
      }
      try {
        const success = await backend.setAliasActive(accountId, anonymousId, active);
        ok(reply, { anonymous_id: anonymousId, success });
      } catch (err) {
        backendFail(reply, err);
      }
    };
  };

  app.post(
    '/api/aliases/:id/deactivate',
    { preHandler: [session, csrf] },
    aliasAction(false),
  );
  app.post(
    '/api/aliases/:id/reactivate',
    { preHandler: [session, csrf] },
    aliasAction(true),
  );

  app.delete(
    '/api/aliases/:id',
    { preHandler: [session, csrf] },
    async (req, reply) => {
      const anonymousId = paramOf(req, 'id');
      const accountId = str(bodyOf(req)['account_id']);
      if (accountId === '') {
        fail(reply, 400, 'VALIDATION_ERROR', '参数错误: account_id 必填');
        return;
      }
      if (anonymousId === '' || anonymousId.length > 256) {
        fail(reply, 400, 'VALIDATION_ERROR', '参数错误: anonymous id 无效');
        return;
      }
      try {
        await backend.deleteAlias(accountId, anonymousId);
        ok(reply, { anonymous_id: anonymousId });
      } catch (err) {
        backendFail(reply, err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  app.post('/api/reload', { preHandler: [session, csrf] }, async (_req, reply) => {
    backend.reload();
    ok(reply, { message: '配置已重新加载' });
  });
}

function parseUid(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const v = parseInt(raw, 10);
  if (v < 0 || v > 4294967295) return null;
  return v;
}
