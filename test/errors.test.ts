import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendError,
  classifyLoginErr,
  classifyUpstreamErr,
  mapAccountErr,
  parseInboxInt,
} from '../src/errors.js';
import { parseDurationMs, parseSessionTTL } from '../src/auth/duration.js';

test('mapAccountErr: not found, cookie, passthrough', () => {
  const notFound = mapAccountErr(new Error('账号不存在: acc_1'));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.code, 'ACCOUNT_NOT_FOUND');
  assert.equal(notFound.message, '账号不存在');
  const cookieErr = mapAccountErr(new Error('账号未配置 Cookie，无法读取邮件'));
  assert.equal(cookieErr.status, 400);
  assert.equal(cookieErr.code, 'VALIDATION_ERROR');
  const other = mapAccountErr(new Error('名称不能为空'));
  assert.equal(other.status, 400);
  assert.equal(other.message, '名称不能为空');
});

test('classifyUpstreamErr: session-ish -> 401, else 502 with fixed message', () => {
  const unauth = classifyUpstreamErr('创建邮箱失败', new Error('HTTP 401: bad'));
  assert.equal(unauth.status, 401);
  assert.equal(unauth.code, 'UPSTREAM_UNAUTHORIZED');
  assert.equal(unauth.message, 'iCloud 会话失效,请更新 Cookie');

  const session = classifyUpstreamErr('创建邮箱失败', new Error('session expired'));
  assert.equal(session.status, 401);

  const other = classifyUpstreamErr('创建邮箱失败', new Error('connection reset'));
  assert.equal(other.status, 502);
  assert.equal(other.code, 'UPSTREAM_FAILURE');
  assert.equal(other.message, '创建邮箱失败');
  assert.ok(!other.message.includes('connection reset'));
});

test('classifyLoginErr: OTP / invalid OTP / not found / session / fallback', () => {
  const otp = classifyLoginErr(new Error('账号启用了双重认证,需要提供 OTP'));
  assert.equal(otp.status, 409);
  assert.equal(otp.code, 'OTP_REQUIRED');

  const badOtp = classifyLoginErr(new Error('2FA 验证失败: HTTP 400'));
  assert.equal(badOtp.status, 401);
  assert.equal(badOtp.code, 'OTP_INVALID');

  const notFound = classifyLoginErr(new Error('账号不存在: acc_1'));
  assert.equal(notFound.status, 404);
  assert.equal(notFound.code, 'ACCOUNT_NOT_FOUND');

  const session = classifyLoginErr(new Error('cookie expired'));
  assert.equal(session.status, 401);
  assert.equal(session.code, 'UPSTREAM_UNAUTHORIZED');

  const other = classifyLoginErr(new Error('something odd'));
  assert.equal(other.status, 502);
  assert.equal(other.message, 'iCloud 登录失败,请稍后重试');
});

test('parseInboxInt: valid, invalid, out of range, whitespace', () => {
  assert.equal(parseInboxInt('20', 1, 100), 20);
  assert.equal(parseInboxInt(' 7 ', 1, 90), 7);
  assert.throws(() => parseInboxInt('abc', 1, 100), /invalid integer/);
  assert.throws(() => parseInboxInt('0', 1, 100), /out of range/);
  assert.throws(() => parseInboxInt('101', 1, 100), /out of range/);
  assert.throws(() => parseInboxInt('', 1, 100), /invalid integer/);
  assert.throws(() => parseInboxInt('1.5', 1, 100), /invalid integer/);
});

test('parseDurationMs: Go-style durations', () => {
  assert.equal(parseDurationMs('12h'), 12 * 3600 * 1000);
  assert.equal(parseDurationMs('15m'), 15 * 60 * 1000);
  assert.equal(parseDurationMs('1h30m'), 90 * 60 * 1000);
  assert.equal(parseDurationMs('90m'), 90 * 60 * 1000);
  assert.equal(parseDurationMs('1.5h'), 90 * 60 * 1000);
  assert.equal(parseDurationMs('500ms'), 500);
  assert.equal(parseDurationMs(''), null);
  assert.throws(() => parseDurationMs('abc'), /invalid duration/);
  assert.throws(() => parseDurationMs('12'), /invalid duration/);
});

test('parseSessionTTL: default, range, Go out-of-range bug', () => {
  const d12h = 12 * 3600 * 1000;
  assert.equal(parseSessionTTL(undefined), d12h);
  assert.equal(parseSessionTTL(''), d12h);
  assert.equal(parseSessionTTL('15m'), 15 * 60 * 1000);
  assert.equal(parseSessionTTL('168h'), 168 * 3600 * 1000);
  // Go bug: out-of-range silently falls back to the 12h default.
  assert.equal(parseSessionTTL('10m'), d12h);
  assert.equal(parseSessionTTL('200h'), d12h);
  assert.throws(() => parseSessionTTL('not-a-duration'), /invalid duration/);
});
