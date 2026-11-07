import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Admin session manager — port of internal/auth/manager.go.
 *
 * Deviation from Go (documented): the password KDF is node:crypto scrypt
 * instead of argon2id. The derived key is ephemeral — computed at boot from
 * the env password with a fresh random salt, never persisted — so nothing
 * observable changes: login still compares a derived key in constant time.
 *
 * Sessions live only in memory (process restart invalidates them). The map is
 * keyed by SHA-256(sessionID); only the SHA-256 of the CSRF token is stored
 * alongside the token itself. Raw session IDs and CSRF tokens are never
 * logged or written to disk.
 */

export interface SessionInfo {
  csrfToken: string;
  expiresAt: Date;
}

const MAX_SESSIONS = 32;

interface SessionRecord {
  csrfHash: Buffer;
  csrfToken: string;
  expiresAt: Date;
}

export class AuthManager {
  private readonly derived: Buffer;
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(password: string, ttlMs: number) {
    if (password.length < 8) {
      throw new Error('管理员密码长度不能少于 8 个字符');
    }
    this.ttlMs = ttlMs > 0 ? ttlMs : 12 * 3600 * 1000;
    const salt = randomBytes(16);
    this.derived = deriveKey(password, salt);
    // Keep the salt so logins derive with the same parameters.
    this.salt = salt;
  }

  private readonly salt: Buffer;

  private verify(password: string): boolean {
    const candidate = deriveKey(password, this.salt);
    if (candidate.length !== this.derived.length) return false;
    return timingSafeEqual(candidate, this.derived);
  }

  /** Validate the password; on success create a session and return its id. */
  login(password: string): { sessionId: string; session: SessionInfo } | null {
    if (!this.verify(password)) return null;
    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const key = sha256Hex(sessionId);
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) {
      this.evictOldest();
    }
    if (this.sessions.has(key)) {
      // Collision probability is negligible; refuse conservatively like Go.
      return null;
    }
    this.sessions.set(key, {
      csrfHash: createHash('sha256').update(csrfToken).digest(),
      csrfToken,
      expiresAt,
    });
    return { sessionId, session: { csrfToken, expiresAt } };
  }

  /** Validate a session id; prunes expired sessions first. */
  validate(sessionId: string): SessionInfo | null {
    const key = sha256Hex(sessionId);
    this.prune();
    const rec = this.sessions.get(key);
    if (!rec) return null;
    return { csrfToken: rec.csrfToken, expiresAt: rec.expiresAt };
  }

  /** Constant-time CSRF check for a session. */
  validateCsrf(sessionId: string, token: string): boolean {
    const key = sha256Hex(sessionId);
    this.prune();
    const rec = this.sessions.get(key);
    if (!rec) return false;
    const want = createHash('sha256').update(token).digest();
    if (want.length !== rec.csrfHash.length) return false;
    return timingSafeEqual(rec.csrfHash, want);
  }

  logout(sessionId: string): void {
    this.sessions.delete(sha256Hex(sessionId));
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, rec] of this.sessions) {
      if (rec.expiresAt.getTime() <= now) this.sessions.delete(key);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, rec] of this.sessions) {
      if (rec.expiresAt.getTime() < oldest) {
        oldest = rec.expiresAt.getTime();
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.sessions.delete(oldestKey);
  }
}

function deriveKey(password: string, salt: Buffer): Buffer {
  // scrypt N=16384, r=8, p=1, 32-byte key — comparable cost to Go's
  // argon2id(time=1, memory=64MiB, threads=4, keyLen=32) for this use.
  return scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
