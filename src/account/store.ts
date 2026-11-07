import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { Account, MailboxConfig } from './types.js';

/**
 * SQLite account store — single file data/icloud.db, WAL mode, one
 * synchronous DatabaseSync connection. Replaces Go's accounts.json; the JSON
 * file is NOT read (fresh start, see README).
 *
 * Secrets (cookies, app_password, proxy, mailbox password) are stored
 * plaintext, exactly like the Go original — protection relies on the database
 * file permissions (0600) and deployment isolation.
 */

interface AccountRow {
  id: string;
  name: string;
  real_email: string;
  icloud_email: string;
  cookies: string;
  host: string;
  proxy: string;
  app_password: string;
  mailbox: string | null;
  status: string;
  alias_total: number;
  alias_active: number;
  last_validated: string;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export class AccountStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o755 });
    const file = join(dataDir, 'icloud.db');
    const existed = existsSync(file);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        real_email TEXT NOT NULL DEFAULT '',
        icloud_email TEXT NOT NULL DEFAULT '',
        cookies TEXT NOT NULL DEFAULT '{}',
        host TEXT NOT NULL DEFAULT 'icloud.com',
        proxy TEXT NOT NULL DEFAULT '',
        app_password TEXT NOT NULL DEFAULT '',
        mailbox TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        alias_total INTEGER NOT NULL DEFAULT 0,
        alias_active INTEGER NOT NULL DEFAULT 0,
        last_validated TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
      )
    `);
    if (!existed) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best effort; deployment isolation is the real protection.
      }
    }
  }

  list(): Account[] {
    return this.db
      .prepare('SELECT * FROM accounts ORDER BY id')
      .all()
      .map((row) => rowToAccount(row as unknown as AccountRow));
  }

  get(id: string): Account | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | unknown
      | undefined;
    const typed = row as AccountRow | undefined;
    return typed ? rowToAccount(typed) : null;
  }

  insert(a: Account): void {
    this.db
      .prepare(
        `INSERT INTO accounts
         (id, name, real_email, icloud_email, cookies, host, proxy, app_password,
          mailbox, status, alias_total, alias_active, last_validated, last_error,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.name,
        a.real_email,
        a.icloud_email,
        JSON.stringify(a.cookies ?? {}),
        a.host,
        a.proxy,
        a.app_password,
        a.mailbox ? JSON.stringify(a.mailbox) : null,
        a.status,
        a.alias_total,
        a.alias_active,
        a.last_validated,
        a.last_error,
        a.created_at,
        a.updated_at,
      );
  }

  update(a: Account): void {
    this.db
      .prepare(
        `UPDATE accounts SET
           name = ?, real_email = ?, icloud_email = ?, cookies = ?, host = ?,
           proxy = ?, app_password = ?, mailbox = ?, status = ?,
           alias_total = ?, alias_active = ?, last_validated = ?,
           last_error = ?, created_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        a.name,
        a.real_email,
        a.icloud_email,
        JSON.stringify(a.cookies ?? {}),
        a.host,
        a.proxy,
        a.app_password,
        a.mailbox ? JSON.stringify(a.mailbox) : null,
        a.status,
        a.alias_total,
        a.alias_active,
        a.last_validated,
        a.last_error,
        a.created_at,
        a.updated_at,
        a.id,
      );
  }

  delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

function rowToAccount(row: AccountRow): Account {
  let cookies: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(row.cookies || '{}');
    if (parsed !== null && typeof parsed === 'object') {
      cookies = parsed as Record<string, string>;
    }
  } catch {
    cookies = {};
  }
  let mailbox: MailboxConfig | null = null;
  if (row.mailbox) {
    try {
      mailbox = JSON.parse(row.mailbox) as MailboxConfig;
    } catch {
      mailbox = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    real_email: row.real_email,
    icloud_email: row.icloud_email,
    cookies,
    host: row.host,
    proxy: row.proxy,
    app_password: row.app_password,
    mailbox,
    status: row.status,
    alias_total: row.alias_total,
    alias_active: row.alias_active,
    last_validated: row.last_validated,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
