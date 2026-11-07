import { ImapFlow } from 'imapflow';
import type { FetchMessageObject } from 'imapflow';
import {
  allEmailAddresses,
  decodeRfc2047,
  firstEmailAddress,
  parseMailDate,
  parseRfc822,
  readBody,
} from './mime.js';
import { sanitizePlainPreview } from './preview.js';

/**
 * IMAP mail client — port of internal/mail/client.go, via imapflow.
 *
 * Server: imap.mail.me.com:993 TLS, app-password login. Every call uses a
 * fresh client unless the caller manages the pool (pool.ts). Fetch uses PEEK
 * (imapflow never marks messages seen on fetch), so listing does not change
 * read state.
 */

export interface Message {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  preview: string;
}

export interface FullMessage extends Message {
  body: string;
  content_type: string;
}

const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class MailClient {
  private readonly imap: ImapFlow;
  private connected = false;

  constructor(
    private readonly user: string,
    private readonly pass: string,
    private readonly host = IMAP_HOST,
    private readonly port = IMAP_PORT,
  ) {
    this.imap = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user, pass },
      logger: false,
    });
  }

  get username(): string {
    return this.user;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      await this.noop();
      return;
    }
    await withTimeout(this.imap.connect(), 30_000, 'IMAP 连接');
    this.connected = true;
  }

  async noop(): Promise<void> {
    await this.imap.noop();
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.imap.logout().catch(() => undefined);
  }

  async inboxCount(): Promise<number> {
    await this.connect();
    const mailbox = await this.imap.mailboxOpen('INBOX', { readOnly: true });
    return mailbox.exists;
  }

  async listInbox(limit: number, days: number): Promise<Message[]> {
    await this.connect();
    const mailbox = await this.imap.mailboxOpen('INBOX', { readOnly: true });
    const total = mailbox.exists;
    if (total === 0) return [];
    const start = Math.max(1, total - limit + 1);
    const fetched: FetchMessageObject[] = [];
    for await (const msg of this.imap.fetch(`${start}:${total}`, {
      uid: true,
      envelope: true,
      internalDate: true,
      source: true,
    })) {
      fetched.push(msg);
    }
    const cutoff = days > 0 ? Date.now() - days * 24 * 3600 * 1000 : 0;
    const out: Message[] = [];
    for (const msg of fetched) {
      const parsed = messageFromFetch(msg);
      if (!parsed) continue;
      if (days > 0 && parsed.dateMs !== null && parsed.dateMs < cutoff) continue;
      out.push(parsed.message);
    }
    out.sort((a, b) => compareDateDesc(a.date, b.date));
    return out;
  }

  async findByRecipient(recipient: string, limit: number, days: number): Promise<Message[]> {
    await this.connect();
    await this.imap.mailboxOpen('INBOX', { readOnly: true });
    const since = days > 0 ? new Date(Date.now() - days * 24 * 3600 * 1000) : undefined;
    let uids: number[] = [];
    try {
      const query: Parameters<ImapFlow['search']>[0] = { header: { to: recipient } };
      if (since) query.since = since;
      const found = await this.imap.search(query, { uid: true });
      uids = Array.isArray(found) ? found : [];
    } catch {
      uids = [];
    }
    if (uids.length > 0) {
      uids.sort((a, b) => b - a);
      const wanted = uids.slice(0, limit);
      const out: Message[] = [];
      for (const uid of wanted) {
        const msg = await this.imap.fetchOne(
          uid,
          { uid: true, envelope: true, internalDate: true, source: true },
          { uid: true },
        );
        if (!msg) continue;
        const parsed = messageFromFetch(msg);
        if (parsed) out.push(parsed.message);
      }
      out.sort((a, b) => compareDateDesc(a.date, b.date));
      return out;
    }
    // Fallback: scan newest envelopes, filter locally.
    const mailbox = this.imap.mailbox;
    const total = mailbox ? mailbox.exists : 0;
    if (total === 0) return [];
    const scan = Math.max(20, Math.min(80, limit * 4));
    const start = Math.max(1, total - scan + 1);
    const envelopes: FetchMessageObject[] = [];
    for await (const msg of this.imap.fetch(`${start}:${total}`, {
      uid: true,
      envelope: true,
      internalDate: true,
    })) {
      envelopes.push(msg);
    }
    const lower = recipient.toLowerCase();
    const cutoff = days > 0 ? Date.now() - days * 24 * 3600 * 1000 : 0;
    const candidates: { uid: number; dateMs: number | null }[] = [];
    for (const msg of envelopes) {
      const to = msg.envelope?.to?.map((a) => a.address ?? '').join(', ') ?? '';
      if (!to.toLowerCase().includes(lower)) continue;
      const envDate = toDate(msg.envelope?.date) ?? toDate(msg.internalDate);
      const dateMs = envDate ? envDate.getTime() : null;
      if (days > 0 && dateMs !== null && dateMs < cutoff) continue;
      if (msg.uid !== undefined) candidates.push({ uid: msg.uid, dateMs });
    }
    candidates.sort((a, b) => (b.dateMs ?? 0) - (a.dateMs ?? 0));
    const out: Message[] = [];
    for (const cand of candidates.slice(0, limit)) {
      const msg = await this.imap.fetchOne(
        cand.uid,
        { uid: true, envelope: true, internalDate: true, source: true },
        { uid: true },
      );
      if (!msg) continue;
      const parsed = messageFromFetch(msg);
      if (parsed) out.push(parsed.message);
    }
    out.sort((a, b) => compareDateDesc(a.date, b.date));
    return out;
  }

  async getFull(uid: number): Promise<FullMessage> {
    await this.connect();
    await this.imap.mailboxOpen('INBOX', { readOnly: true });
    const msg = await this.imap.fetchOne(
      uid,
      { uid: true, envelope: true, internalDate: true, source: true },
      { uid: true },
    );
    if (!msg) throw new Error('邮件不存在');
    const parsed = messageFromFetch(msg);
    if (!parsed) throw new Error('邮件解析失败');
    const raw = msg.source ? msg.source.toString('utf8') : '';
    const { body, contentType } = readBody(raw);
    return { ...parsed.message, body, content_type: contentType };
  }

  async deleteMessage(uid: number): Promise<void> {
    await this.connect();
    await this.imap.mailboxOpen('INBOX');
    await this.imap.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
    await this.imap.messageDelete(uid, { uid: true });
  }
}

/** imapflow types envelope.date as string | Date; normalize to Date. */
function toDate(v: string | Date | undefined): Date | null {
  if (v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** RFC3339 date descending; empty dates sort last (Go behaviour). */
function compareDateDesc(a: string, b: string): number {
  if (a === '' && b === '') return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

function messageFromFetch(
  msg: FetchMessageObject,
): { message: Message; dateMs: number | null } | null {
  if (msg.uid === undefined) return null;
  const env = msg.envelope;
  const from = env?.from?.[0]?.address ?? '';
  const to = env?.to?.map((a) => a.address ?? '').join(', ') ?? '';
  const subject = decodeRfc2047(env?.subject ?? '');
  let date = '';
  let dateMs: number | null = null;
  const envDate = toDate(env?.date) ?? toDate(msg.internalDate);
  if (envDate) {
    date = envDate.toISOString();
    dateMs = envDate.getTime();
  }
  let preview = '';
  if (msg.source) {
    const raw = msg.source.toString('utf8');
    const { headers, body } = parseRfc822(raw);
    const fromHdr = headers.get('from') ?? '';
    const toHdr = headers.get('to') ?? '';
    const subjectHdr = headers.get('subject') ?? '';
    const dateHdr = headers.get('date') ?? '';
    const parsedDate = parseMailDate(dateHdr);
    if (date === '' && parsedDate) {
      date = parsedDate.toISOString();
      dateMs = parsedDate.getTime();
    }
    const { body: previewText } = readBody(raw);
    preview = previewText;
    return {
      message: {
        id: String(msg.uid),
        from: from !== '' ? from : firstEmailAddress(fromHdr),
        to: to !== '' ? to : allEmailAddresses(toHdr),
        subject: subject !== '' ? subject : decodeRfc2047(subjectHdr),
        date,
        preview,
      },
      dateMs,
    };
  }
  return {
    message: {
      id: String(msg.uid),
      from,
      to,
      subject,
      date,
      preview: sanitizePlainPreview(''),
    },
    dateMs,
  };
}
