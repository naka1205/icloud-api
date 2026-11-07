/**
 * Stable backend errors and their mapping — port of
 * internal/server/backend.go (BackendError, mapAccountErr,
 * classifyUpstreamErr, classifyLoginErr, isSessionError, asBackendError).
 *
 * The HTTP layer only ever surfaces these: upstream response bodies are
 * never concatenated into user-visible messages.
 */

export class BackendError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export function isSessionError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('401') ||
    m.includes('403') ||
    m.includes('session') ||
    m.includes('cookie') ||
    m.includes('unauthorized') ||
    m.includes('认证') ||
    m.includes('会话校验失败')
  );
}

/** Map account-manager errors to stable errors (mapAccountErr). */
export function mapAccountErr(err: Error): BackendError {
  const msg = err.message;
  if (msg.includes('账号不存在')) {
    return new BackendError(404, 'ACCOUNT_NOT_FOUND', '账号不存在');
  }
  if (msg.includes('Cookie') && msg.includes('未配置')) {
    return new BackendError(400, 'VALIDATION_ERROR', '账号未配置 Cookie');
  }
  return new BackendError(400, 'VALIDATION_ERROR', msg);
}

/** Map upstream (iCloud) errors to a fixed message (classifyUpstreamErr). */
export function classifyUpstreamErr(fixedMsg: string, err: Error): BackendError {
  if (isSessionError(err.message)) {
    return new BackendError(401, 'UPSTREAM_UNAUTHORIZED', 'iCloud 会话失效,请更新 Cookie');
  }
  return new BackendError(502, 'UPSTREAM_FAILURE', fixedMsg);
}

/** Map iCloud login errors (classifyLoginErr). */
export function classifyLoginErr(err: Error): BackendError {
  const msg = err.message;
  if (msg.includes('需要提供 OTP')) {
    return new BackendError(409, 'OTP_REQUIRED', '需要提供 OTP 验证码');
  }
  if (msg.includes('2FA 验证失败')) {
    return new BackendError(401, 'OTP_INVALID', 'OTP 验证码错误');
  }
  if (msg.includes('账号不存在')) {
    return new BackendError(404, 'ACCOUNT_NOT_FOUND', '账号不存在');
  }
  if (isSessionError(msg)) {
    return new BackendError(401, 'UPSTREAM_UNAUTHORIZED', 'iCloud 会话失效,请更新 Cookie');
  }
  return new BackendError(502, 'UPSTREAM_FAILURE', 'iCloud 登录失败,请稍后重试');
}

/** Extract a BackendError; anything else becomes INTERNAL_ERROR. */
export function asBackendError(err: unknown): BackendError {
  if (err instanceof BackendError) return err;
  return new BackendError(500, 'INTERNAL_ERROR', '内部错误');
}

/** Parse inbox integer query params (parseInboxInt): invalid or out of range errors. */
export function parseInboxInt(raw: string, min: number, max: number): number {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error('invalid integer');
  const v = parseInt(trimmed, 10);
  if (v < min || v > max) throw new Error('out of range');
  return v;
}
