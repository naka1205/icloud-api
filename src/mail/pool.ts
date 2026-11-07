import { MailClient } from './client.js';

/**
 * Per-account IMAP connection pool — port of internal/mail/pool.go.
 *
 * Keyed by Apple ID email. A connection is discarded after 10 minutes of
 * idleness (the client is rebuilt on next use). Before use, a NOOP ping is
 * sent; if it fails (or the client is flagged dead), a fresh connection is
 * created. A password change creates a new connection.
 */

const MAX_IDLE_MS = 10 * 60 * 1000;

const CONNECTION_ERROR_KEYWORDS = [
  'connection reset',
  'broken pipe',
  'EOF',
  'i/o timeout',
  'use of closed',
  'not connected',
  'connection refused',
  'IMAP 连接',
  'wsarecv',
  'wsasend',
];

export function isConnectionError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return CONNECTION_ERROR_KEYWORDS.some((k) => msg.includes(k.toLowerCase()));
}

interface Pooled {
  client: MailClient;
  lastUsed: number;
  dead: boolean;
}

export class MailPool {
  private readonly pool = new Map<string, Pooled>();

  async get(user: string, pass: string): Promise<MailClient> {
    const existing = this.pool.get(user);
    if (existing && !existing.dead && Date.now() - existing.lastUsed <= MAX_IDLE_MS) {
      try {
        await existing.client.noop();
        existing.lastUsed = Date.now();
        return existing.client;
      } catch (err) {
        this.discard(user);
      }
    }
    if (existing) this.discard(user);
    const client = new MailClient(user, pass);
    await client.connect();
    this.pool.set(user, { client, lastUsed: Date.now(), dead: false });
    return client;
  }

  markDead(user: string): void {
    const entry = this.pool.get(user);
    if (entry) entry.dead = true;
  }

  discard(user: string): void {
    const entry = this.pool.get(user);
    if (!entry) return;
    this.pool.delete(user);
    void entry.client.close().catch(() => undefined);
  }
}
