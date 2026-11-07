import { randomUUID, createHash, pbkdf2Sync } from 'node:crypto';
import { SrpClient } from '../srp/client.js';
import { mergeSetCookies } from './http.js';
import type { HmeClient } from './client.js';

/**
 * iCloud SRP login flow — port of internal/hme/auth.go.
 *
 * 11 steps: authStart → authFederate → SRP init → decode salt/B →
 * passKey = PBKDF2-SHA256(SHA256(password), salt, iteration, 32) →
 * ProcessClientChallenge → authComplete (409 → 2FA) → getTrust →
 * authenticateWeb → extractSessionCookies.
 *
 * Transport: wreq-js chrome_146 (the TLS fingerprint). The User-Agent header
 * is Chrome/124, exactly as in Go — the preset and the header are separate.
 */

export const OAUTH_CLIENT_ID =
  'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d';

const UA_CHROME_124 =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type OtpProvider = () => Promise<string>;

interface AuthState {
  username: string;
  password: string;
  frameId: string;
  clientId: string;
  authAttr: string;
  sessionId: string;
  scnt: string;
  authToken: string;
  trustToken: string;
  dsid: string;
}

interface InitResponse {
  iteration: number;
  salt: string;
  protocol: string;
  b: string;
  c: string;
}

/**
 * Run the full login flow against the given client. On success the client's
 * cookie map holds the session cookies (extracted for the icloud.com origin).
 * Throws with Go-identical messages for the mapped cases:
 *  - "账号启用了双重认证,需要提供 OTP" (no OTP provider)
 *  - "2FA 验证失败: HTTP <status>" (wrong OTP)
 *  - "用户名或密码错误" (403)
 *  - "需要先在 appleid.apple.com 同意隐私条款" (412)
 */
export async function loginWithPassword(
  client: HmeClient,
  username: string,
  password: string,
  otpProvider: OtpProvider | null,
): Promise<void> {
  const state: AuthState = {
    username,
    password,
    frameId: randomUUID().toLowerCase(),
    clientId: OAUTH_CLIENT_ID,
    authAttr: '',
    sessionId: '',
    scnt: '',
    authToken: '',
    trustToken: '',
    dsid: '',
  };

  await authStart(client, state);
  await authFederate(client, state);

  const srp = new SrpClient();
  const init = await authInit(client, state, Buffer.from(srp.getABytes()).toString('base64'));
  const bDec = Buffer.from(init.b, 'base64');
  const saltDec = Buffer.from(init.salt, 'base64');

  const passHash = createHash('sha256').update(password, 'utf8').digest();
  const passKey = pbkdf2Sync(passHash, saltDec, init.iteration, 32, 'sha256');

  srp.processChallenge(Buffer.from(username, 'utf8'), passKey, saltDec, bDec);

  await authComplete(
    client,
    state,
    Buffer.from(srp.getM1Bytes()).toString('base64'),
    Buffer.from(srp.getM2Bytes()).toString('base64'),
    otpProvider,
  );
  await getTrust(client, state);
  await authenticateWeb(client, state);

  // Session cookies are already merged into client.cookies by every request.
  // Go extracts them for the icloud.com origin; our map is domain-agnostic
  // and the manual Cookie header sends them to every host, so there is
  // nothing further to copy.
}

function authHeaders(
  state: AuthState,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Referer: 'https://idmsa.apple.com/',
    Origin: 'https://idmsa.apple.com',
    'User-Agent': UA_CHROME_124,
    ...extra,
  };
  if (state.scnt !== '') headers['scnt'] = state.scnt;
  if (state.sessionId !== '') headers['X-Apple-ID-Session-Id'] = state.sessionId;
  return headers;
}

async function authStart(client: HmeClient, state: AuthState): Promise<void> {
  const url =
    `https://idmsa.apple.com/appleauth/auth/authorize/signin` +
    `?frame_id=auth-${state.frameId}&language=en_US&skVersion=7&iframeId=auth-${state.frameId}` +
    `&client_id=${state.clientId}&redirect_uri=https://www.icloud.com` +
    `&response_type=code&response_mode=web_message&state=auth-${state.frameId}&authVersion=latest`;
  const fetchFn = await client.authFetch();
  const resp = await fetchFn(url, {
    method: 'GET',
    headers: { Accept: '*/*', 'User-Agent': UA_CHROME_124 },
    timeoutMs: 15_000,
  });
  mergeAuthCookies(client, resp.setCookies);
  if (resp.status !== 200) throw new Error(`unexpected status: ${resp.status}`);
  state.authAttr = resp.headers['x-apple-auth-attributes'] ?? '';
}

async function authFederate(client: HmeClient, state: AuthState): Promise<void> {
  const fetchFn = await client.authFetch();
  const resp = await fetchFn(
    'https://idmsa.apple.com/appleauth/auth/federate?isRememberMeEnabled=true',
    {
      method: 'POST',
      headers: authHeaders(state),
      body: JSON.stringify({ accountName: state.username, rememberMe: true }),
      timeoutMs: 15_000,
    },
  );
  mergeAuthCookies(client, resp.setCookies);
  if (resp.status !== 200) throw new Error(`unexpected status: ${resp.status}`);
}

async function authInit(
  client: HmeClient,
  state: AuthState,
  aBase64: string,
): Promise<InitResponse> {
  const fetchFn = await client.authFetch();
  const resp = await fetchFn('https://idmsa.apple.com/appleauth/auth/signin/init', {
    method: 'POST',
    headers: authHeaders(state),
    body: JSON.stringify({
      a: aBase64,
      accountName: state.username,
      protocols: ['s2k', 's2k_fo'],
    }),
    timeoutMs: 15_000,
  });
  mergeAuthCookies(client, resp.setCookies);
  let parsed: InitResponse;
  try {
    parsed = JSON.parse(resp.body) as InitResponse;
  } catch {
    throw new Error('decode response: invalid JSON');
  }
  return parsed;
}

async function authComplete(
  client: HmeClient,
  state: AuthState,
  m1: string,
  m2: string,
  otpProvider: OtpProvider | null,
): Promise<void> {
  const fetchFn = await client.authFetch();
  const resp = await fetchFn(
    'https://idmsa.apple.com/appleauth/auth/signin/complete?isRememberMeEnabled=true',
    {
      method: 'POST',
      headers: authHeaders(state),
      body: JSON.stringify({
        accountName: state.username,
        rememberMe: true,
        trustTokens: [],
        m1,
        c: state.clientId,
        m2,
      }),
      timeoutMs: 15_000,
    },
  );
  mergeAuthCookies(client, resp.setCookies);
  switch (resp.status) {
    case 200:
      return;
    case 409:
      await handleTwoFactor(client, state, resp.headers, otpProvider);
      return;
    case 403:
      throw new Error('用户名或密码错误');
    case 412:
      throw new Error('需要先在 appleid.apple.com 同意隐私条款');
    default:
      throw new Error(`auth complete 失败: HTTP ${resp.status}`);
  }
}

async function handleTwoFactor(
  client: HmeClient,
  state: AuthState,
  completeHeaders: Record<string, string>,
  otpProvider: OtpProvider | null,
): Promise<void> {
  state.sessionId = completeHeaders['x-apple-id-session-id'] ?? '';
  state.scnt = completeHeaders['scnt'] ?? '';
  if (otpProvider === null) {
    throw new Error('账号启用了双重认证,需要提供 OTP');
  }
  let otp: string;
  try {
    otp = await otpProvider();
  } catch (err) {
    throw new Error(`获取 2FA 验证码失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fetchFn = await client.authFetch();
  const resp = await fetchFn(
    'https://idmsa.apple.com/appleauth/auth/verify/trusteddevice/securitycode',
    {
      method: 'POST',
      headers: authHeaders(state),
      body: JSON.stringify({ securityCode: { code: otp } }),
      timeoutMs: 15_000,
    },
  );
  mergeAuthCookies(client, resp.setCookies);
  if (resp.status !== 204) {
    throw new Error(`2FA 验证失败: HTTP ${resp.status}`);
  }
  if (resp.headers['scnt']) state.scnt = resp.headers['scnt'];
}

async function getTrust(client: HmeClient, state: AuthState): Promise<void> {
  const fetchFn = await client.authFetch();
  const resp = await fetchFn('https://idmsa.apple.com/appleauth/auth/2sv/trust', {
    method: 'GET',
    headers: authHeaders(state),
    timeoutMs: 15_000,
  });
  mergeAuthCookies(client, resp.setCookies);
  if (resp.status !== 204) throw new Error(`trust 失败: HTTP ${resp.status}`);
  state.authToken = resp.headers['x-apple-session-token'] ?? '';
  state.trustToken = resp.headers['x-apple-twosv-trust-token'] ?? '';
}

async function authenticateWeb(client: HmeClient, state: AuthState): Promise<void> {
  const fetchFn = await client.authFetch();
  const resp = await fetchFn('https://setup.icloud.com/setup/ws/1/accountLogin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: client.origin(),
      Accept: '*/*',
    },
    body: JSON.stringify({
      dsWebAuthToken: state.authToken,
      accountCountryCode: 'USA',
      extended_login: true,
      trustToken: state.trustToken,
    }),
    timeoutMs: 15_000,
  });
  mergeAuthCookies(client, resp.setCookies);
  if (resp.status !== 200) throw new Error(`auth web 失败: HTTP ${resp.status}`);
  try {
    const parsed = JSON.parse(resp.body) as { dsInfo?: { dsid?: string } };
    state.dsid = parsed.dsInfo?.dsid ?? '';
  } catch {
    // dsid is optional
  }
}

function mergeAuthCookies(client: HmeClient, setCookies: string[]): void {
  // Same merge rule as the HME client: Set-Cookie values refresh the map.
  mergeSetCookies(client.cookies, setCookies);
}
