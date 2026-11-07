/**
 * Account types. Field names are frozen by the Go contract: the public
 * Summary is snake_case, while HME aliases (see hme/client.ts) are camelCase.
 * Do NOT unify them.
 */

export interface MailboxConfig {
  provider: string;
  email: string;
  imap_host: string;
  imap_port: number;
  /** Authorization code / app password for the external mailbox. Never serialized. */
  password?: string;
}

export interface MailboxSummary {
  provider: string;
  email: string;
  imap_host: string;
  imap_port: number;
}

export interface Account {
  id: string;
  name: string;
  real_email: string;
  icloud_email: string;
  /** iCloud session cookies, plaintext. Never leaves the server. */
  cookies: Record<string, string>;
  host: string;
  proxy: string;
  app_password: string;
  mailbox: MailboxConfig | null;
  status: string;
  alias_total: number;
  alias_active: number;
  last_validated: string;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface AccountSummary {
  id: string;
  name: string;
  real_email: string;
  icloud_email: string;
  host: string;
  status: string;
  alias_total: number;
  alias_active: number;
  has_cookies: boolean;
  has_app_password: boolean;
  has_proxy: boolean;
  mailbox?: MailboxSummary;
  last_validated: string;
  status_message?: string;
  created_at: string;
}

export interface AddAccountInput {
  name: string;
  icloud_email: string;
  cookieInput: string;
  host: string;
  proxy: string;
}

export interface UpdateAccountInput {
  name?: string;
  icloud_email?: string;
  host?: string;
}
