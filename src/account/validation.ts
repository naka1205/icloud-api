import type { Account, AccountSummary } from './types.js';

/**
 * Account validation, cookie parsing and the public Summary projection —
 * port of internal/account/public.go and ParseCookieInput /
 * deriveICloudEmail / isICloudDomain from internal/account/manager.go.
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateName(name: string): string {
  const v = name.trim();
  if (v === '') throw new Error('名称不能为空');
  if ([...v].length > 64) throw new Error('名称不能超过 64 个字符');
  return v;
}

export function validateHost(host: string): string {
  const v = host.trim().toLowerCase();
  if (v === '') return 'icloud.com';
  if (v !== 'icloud.com' && v !== 'icloud.com.cn') {
    throw new Error('主机只能是 icloud.com 或 icloud.com.cn');
  }
  return v;
}

/**
 * Email validation: must be a bare address (no display name) and equal to the
 * trimmed input, mirroring Go net/mail.ParseAddress + address == input.
 */
export function validateEmail(email: string): void {
  const v = email.trim();
  if (v === '') throw new Error('iCloud 邮箱不能为空');
  if (!isBareEmail(v)) throw new Error('邮箱地址格式无效');
}

function isBareEmail(v: string): boolean {
  // No display name, no angle brackets, exactly one @, valid local/domain parts.
  if (/["<>,\s]/.test(v)) return false;
  const parts = v.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local === '' || domain === '') return false;
  if (!domain.includes('.')) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Za-z0-9._%+-]+$/.test(local)) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return false;
  return true;
}

export function validateProxy(proxy: string): string {
  const v = proxy.trim();
  if (v === '') return '';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error('代理地址格式无效');
  }
  if (!u.hostname) throw new Error('代理地址格式无效');
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'socks5:') {
    throw new Error('代理地址格式无效');
  }
  return v;
}

// ---------------------------------------------------------------------------
// Cookie input parsing (ParseCookieInput)
// ---------------------------------------------------------------------------

/**
 * Accepts a JSON object {"k":"v"} (empty-value keys dropped; if nothing
 * remains, falls through to header parsing) or a header string
 * "k=v; k2=v2" (split on ';', first '=' divides key/value, segments without
 * '=' skipped). Empty input or nothing parseable throws.
 */
export function parseCookieInput(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('空白输入 — 请粘贴 Cookie Header String 或 JSON');
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && v !== '') out[k] = v;
        }
        if (Object.keys(out).length > 0) return out;
      }
    } catch {
      // Fall through to header-string parsing, like Go.
    }
  }
  const cookies: Record<string, string> = {};
  for (const part of trimmed.split(';')) {
    const seg = part.trim();
    const idx = seg.indexOf('=');
    if (idx <= 0) continue;
    const name = seg.slice(0, idx).trim();
    const value = seg.slice(idx + 1).trim();
    if (name !== '') cookies[name] = value;
  }
  if (Object.keys(cookies).length === 0) {
    throw new Error('无法解析 Cookie 输入,请提供 Header String 或 JSON 格式');
  }
  return cookies;
}

// ---------------------------------------------------------------------------
// Summary projection — the ONLY shape allowed over HTTP (public.go)
// ---------------------------------------------------------------------------

export function toSummary(a: Account): AccountSummary {
  const s: AccountSummary = {
    id: a.id,
    name: a.name,
    real_email: a.real_email,
    icloud_email: a.icloud_email,
    host: a.host,
    status: a.status,
    alias_total: a.alias_total,
    alias_active: a.alias_active,
    has_cookies: Object.keys(a.cookies ?? {}).length > 0,
    has_app_password: a.app_password !== '',
    has_proxy: a.proxy !== '',
    last_validated: a.last_validated,
    created_at: a.created_at,
  };
  if (a.mailbox) {
    s.mailbox = {
      provider: a.mailbox.provider,
      email: a.mailbox.email,
      imap_host: a.mailbox.imap_host,
      imap_port: a.mailbox.imap_port,
    };
  }
  if (a.status === 'pending') s.status_message = '等待配置或验证凭据';
  else if (a.status === 'error') s.status_message = '凭据验证失败';
  return s;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isICloudDomain(email: string): boolean {
  return (
    email !== '' &&
    (email.includes('@icloud.com') || email.includes('@me.com') || email.includes('@mac.com'))
  );
}

export function deriveICloudEmail(info: { primaryEmail: string; appleId: string }): string {
  const primary = info.primaryEmail.trim();
  const appleId = info.appleId.trim();
  if (isICloudDomain(primary)) return primary;
  if (isICloudDomain(appleId)) return appleId;
  if (appleId.includes('@')) return appleId.split('@', 2)[0] + '@icloud.com';
  return primary !== '' ? primary : appleId;
}

/** Truncate to n bytes (Go's truncate slices bytes, not runes). */
export function truncateBytes(s: string, n: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= n) return s;
  return buf.subarray(0, n).toString('utf8');
}

export function firstNonEmpty(...vals: string[]): string {
  for (const v of vals) {
    if (v !== '') return v;
  }
  return '';
}

export function statusRank(status: string): number {
  if (status === 'active') return 0;
  if (status === 'pending') return 1;
  return 2;
}
