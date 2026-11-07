import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthManager } from './auth/manager.js';
import { fail } from './response.js';

/** Parse the hme_session cookie from the raw Cookie header. */
export function sessionIdFromCookie(req: FastifyRequest): string {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'hme_session') return rest.join('=').trim();
  }
  return '';
}

export const SESSION_COOKIE = 'hme_session';

export function setSessionCookie(
  reply: FastifyReply,
  sessionId: string,
  expiresAt: Date,
  secure: boolean,
): void {
  const parts = [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=-1`,
  );
}

/** Session preHandler — 401 AUTH_REQUIRED when missing or expired. */
export function requireSession(auth: AuthManager) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sessionId = sessionIdFromCookie(req);
    if (sessionId === '') {
      fail(reply, 401, 'AUTH_REQUIRED', '请先登录');
      return;
    }
    const session = auth.validate(sessionId);
    if (!session) {
      fail(reply, 401, 'AUTH_REQUIRED', '会话已失效,请重新登录');
      return;
    }
    (req as unknown as { sessionId: string }).sessionId = sessionId;
  };
}

/** CSRF preHandler for mutations — 403 CSRF_INVALID. */
export function requireCsrf(auth: AuthManager) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sessionId = sessionIdFromCookie(req);
    if (sessionId === '') {
      fail(reply, 403, 'CSRF_INVALID', '缺少会话');
      return;
    }
    const token = req.headers['x-csrf-token'];
    const tokenStr = Array.isArray(token) ? token[0] : (token ?? '');
    if (tokenStr === '' || !auth.validateCsrf(sessionId, tokenStr)) {
      fail(reply, 403, 'CSRF_INVALID', 'CSRF 校验失败');
      return;
    }
  };
}
