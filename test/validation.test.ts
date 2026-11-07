import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCookieInput,
  validateName,
  validateEmail,
  validateHost,
  validateProxy,
  toSummary,
  deriveICloudEmail,
} from '../src/account/validation.js';
import type { Account } from '../src/account/types.js';

test('parseCookieInput: header string', () => {
  const out = parseCookieInput('a=1; b=hello world; c="quoted"');
  assert.equal(out['a'], '1');
  assert.equal(out['b'], 'hello world');
  assert.equal(out['c'], '"quoted"');
});

test('parseCookieInput: header string skips segments without =', () => {
  const out = parseCookieInput('a=1; junk; b=2');
  assert.deepEqual(out, { a: '1', b: '2' });
});

test('parseCookieInput: JSON object, empty values dropped', () => {
  const out = parseCookieInput('{"a":"1","b":"","c":"x"}');
  assert.deepEqual(out, { a: '1', c: 'x' });
});

test('parseCookieInput: empty input throws', () => {
  assert.throws(() => parseCookieInput('   '), /空白输入/);
});

test('parseCookieInput: unparseable input throws', () => {
  assert.throws(() => parseCookieInput('just some words'), /无法解析 Cookie 输入/);
});

test('parseCookieInput: empty JSON falls through to header parse and throws', () => {
  assert.throws(() => parseCookieInput('{}'), /无法解析 Cookie 输入/);
});

test('validateName: empty and too long', () => {
  assert.throws(() => validateName('   '), /名称不能为空/);
  assert.throws(() => validateName('x'.repeat(65)), /名称不能超过 64 个字符/);
  assert.equal(validateName('  星桥  '), '星桥');
});

test('validateEmail: bare address only', () => {
  assert.throws(() => validateEmail(''), /iCloud 邮箱不能为空/);
  assert.throws(() => validateEmail('not-an-email'), /邮箱地址格式无效/);
  assert.throws(() => validateEmail('Name <a@icloud.com>'), /邮箱地址格式无效/);
  assert.throws(() => validateEmail('a@b'), /邮箱地址格式无效/);
  validateEmail('user@icloud.com');
  validateEmail('user+tag@me.com');
});

test('validateHost: defaults and rejects others', () => {
  assert.equal(validateHost(''), 'icloud.com');
  assert.equal(validateHost('ICLOUD.COM.CN'), 'icloud.com.cn');
  assert.throws(() => validateHost('example.com'), /主机只能是 icloud.com 或 icloud.com.cn/);
});

test('validateProxy: schemes and invalid values', () => {
  assert.equal(validateProxy(''), '');
  assert.equal(validateProxy('http://user:pass@proxy.example.com:8080'), 'http://user:pass@proxy.example.com:8080');
  assert.equal(validateProxy('socks5://127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.throws(() => validateProxy('ftp://x'), /代理地址格式无效/);
  assert.throws(() => validateProxy('not a url'), /代理地址格式无效/);
  assert.throws(() => validateProxy('http://'), /代理地址格式无效/);
});

function sampleAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc_12345678',
    name: '测试账号',
    real_email: 'real@example.com',
    icloud_email: 'user@icloud.com',
    cookies: { SECRET_COOKIE_MARKER: 'cookie-secret-value' },
    host: 'icloud.com',
    proxy: 'http://proxy-secret:8080',
    app_password: 'app-password-secret',
    mailbox: { provider: 'x', email: 'm@example.com', imap_host: 'imap.example.com', imap_port: 993, password: 'mailbox-secret' },
    status: 'active',
    alias_total: 3,
    alias_active: 2,
    last_validated: '2026-11-08T00:00:00.000Z',
    last_error: 'last-error-secret',
    created_at: '2026-11-08T00:00:00.000Z',
    updated_at: '2026-11-08T00:00:00.000Z',
    ...overrides,
  };
}

test('toSummary: leak guard — no secrets in serialized summary', () => {
  const json = JSON.stringify(toSummary(sampleAccount()));
  for (const marker of [
    'cookie-secret-value',
    'app-password-secret',
    'proxy-secret',
    'mailbox-secret',
    'last-error-secret',
    'SECRET_COOKIE_MARKER',
  ]) {
    assert.ok(!json.includes(marker), `summary leaks ${marker}`);
  }
  for (const key of ['"cookies"', '"app_password"', '"proxy"', '"last_error"']) {
    assert.ok(!json.includes(key), `summary contains key ${key}`);
  }
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed['has_cookies'], true);
  assert.equal(parsed['has_app_password'], true);
  assert.equal(parsed['has_proxy'], true);
  assert.deepEqual(parsed['mailbox'], {
    provider: 'x',
    email: 'm@example.com',
    imap_host: 'imap.example.com',
    imap_port: 993,
  });
});

test('toSummary: status_message mapping', () => {
  assert.equal(toSummary(sampleAccount({ status: 'pending' })).status_message, '等待配置或验证凭据');
  assert.equal(toSummary(sampleAccount({ status: 'error' })).status_message, '凭据验证失败');
  assert.equal(toSummary(sampleAccount({ status: 'active' })).status_message, undefined);
});

test('deriveICloudEmail: domain preference rules', () => {
  assert.equal(
    deriveICloudEmail({ primaryEmail: 'a@icloud.com', appleId: 'b@qq.com' }),
    'a@icloud.com',
  );
  assert.equal(
    deriveICloudEmail({ primaryEmail: 'a@qq.com', appleId: 'b@me.com' }),
    'b@me.com',
  );
  assert.equal(
    deriveICloudEmail({ primaryEmail: 'a@qq.com', appleId: 'b@qq.com' }),
    'b@icloud.com',
  );
  assert.equal(deriveICloudEmail({ primaryEmail: '', appleId: '' }), '');
});
