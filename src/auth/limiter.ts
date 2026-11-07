/**
 * Fixed-window login rate limiter — port of internal/auth/limiter.go.
 *
 * Every call to allow() counts as one failure for the key (a successful login
 * must call success() to clear the count). The 6th failure inside a 15-minute
 * window is rejected with a Retry-After duration.
 */
export class LoginLimiter {
  private readonly entries = new Map<string, { firstFailure: number; failures: number }>();

  constructor(
    private readonly windowMs: number = 15 * 60 * 1000,
    private readonly maxFailures: number = 5,
    private readonly maxKeys: number = 10000,
  ) {}

  allow(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || now - entry.firstFailure >= this.windowMs) {
      this.entries.set(key, { firstFailure: now, failures: 1 });
      this.gc(now);
      return { allowed: true, retryAfterMs: 0 };
    }
    entry.failures += 1;
    if (entry.failures > this.maxFailures) {
      this.entries.set(key, entry);
      const retryAfterMs = Math.max(0, this.windowMs - (now - entry.firstFailure));
      return { allowed: false, retryAfterMs };
    }
    this.entries.set(key, entry);
    return { allowed: true, retryAfterMs: 0 };
  }

  success(key: string): void {
    this.entries.delete(key);
  }

  private gc(now: number): void {
    for (const [k, e] of this.entries) {
      if (now - e.firstFailure >= this.windowMs) this.entries.delete(k);
    }
    if (this.entries.size > this.maxKeys) {
      let oldestKey = '';
      let oldest = Infinity;
      for (const [k, e] of this.entries) {
        if (e.firstFailure < oldest) {
          oldest = e.firstFailure;
          oldestKey = k;
        }
      }
      if (oldestKey !== '') this.entries.delete(oldestKey);
    }
  }
}
