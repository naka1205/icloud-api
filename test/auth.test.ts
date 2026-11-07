import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthManager } from '../src/auth/manager.js';
import { LoginLimiter } from '../src/auth/limiter.js';

const PASSWORD = 'admin-pass-2026-strong';

test('AuthManager: wrong password fails, right password creates a session', () => {
  const auth = new AuthManager(PASSWORD, 12 * 3600 * 1000);
  assert.equal(auth.login('wrong-password'), null);
  const result = auth.login(PASSWORD);
  assert.ok(result);
  assert.equal(result.session.csrfToken.length > 20, true);
  assert.ok(result.session.expiresAt.getTime() > Date.now());
  const session = auth.validate(result.sessionId);
  assert.ok(session);
  assert.equal(session.csrfToken, result.session.csrfToken);
});

test('AuthManager: validate rejects unknown and expired sessions', async () => {
  const auth = new AuthManager(PASSWORD, 12 * 3600 * 1000);
  assert.equal(auth.validate('nope'), null);
  const short = new AuthManager(PASSWORD, 5);
  const result = short.login(PASSWORD);
  assert.ok(result);
  // 5ms TTL has elapsed after a 20ms wait.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(short.validate(result.sessionId), null);
});

test('AuthManager: CSRF validation is constant-time and session-bound', () => {
  const auth = new AuthManager(PASSWORD, 12 * 3600 * 1000);
  const a = auth.login(PASSWORD)!;
  const b = auth.login(PASSWORD)!;
  assert.equal(auth.validateCsrf(a.sessionId, a.session.csrfToken), true);
  assert.equal(auth.validateCsrf(a.sessionId, b.session.csrfToken), false);
  assert.equal(auth.validateCsrf(a.sessionId, ''), false);
  assert.equal(auth.validateCsrf('unknown', a.session.csrfToken), false);
});

test('AuthManager: logout invalidates the session', () => {
  const auth = new AuthManager(PASSWORD, 12 * 3600 * 1000);
  const result = auth.login(PASSWORD)!;
  auth.logout(result.sessionId);
  assert.equal(auth.validate(result.sessionId), null);
  assert.equal(auth.validateCsrf(result.sessionId, result.session.csrfToken), false);
});

test('AuthManager: short password refuses to start', () => {
  assert.throws(() => new AuthManager('short', 12 * 3600 * 1000), /8 个字符/);
});

test('LoginLimiter: 5 failures then blocked, success resets', () => {
  const limiter = new LoginLimiter();
  const ip = '203.0.113.7';
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.allow(ip).allowed, true);
  }
  const blocked = limiter.allow(ip);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.ok(blocked.retryAfterMs <= 15 * 60 * 1000);

  limiter.success(ip);
  assert.equal(limiter.allow(ip).allowed, true);

  // Another IP is unaffected.
  assert.equal(limiter.allow('198.51.100.9').allowed, true);
});
