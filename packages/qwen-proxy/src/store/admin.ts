import type Database from "better-sqlite3";

// ── Row types ────────────────────────────────────────────────────────────────

export interface AdminAccountRow {
  id: number;
  email: string;
  ord: number;
  state: string;
  re_enable_at: number | null;
}

export interface AdminTokenRow {
  account_id: number;
  has_bearer: boolean;
  expires_at: number | null;
  updated_at: number;
}

export interface AdminRateLimitRow {
  account_id: number;
  last_429_at: number | null;
  retry_after_at: number | null;
  re_enable_at: number | null;
  updated_at: number;
}

export interface AdminLoginFailureRow {
  id: number;
  account_id: number;
  attempted_at: number;
  reason: string;
  status_code: number | null;
}

export interface AdminVideoJobCount {
  account_id: number | null;
  status: string;
  count: number;
}

// ── Read-only helpers ─────────────────────────────────────────────────────────

/** List all accounts with pool state. */
export function listAccountsForAdmin(db: Database.Database): AdminAccountRow[] {
  return db
    .prepare(
      "SELECT id, email, ord, state, re_enable_at FROM accounts ORDER BY ord, id",
    )
    .all() as AdminAccountRow[];
}

/** List tokens with has_bearer boolean (never the raw bearer). */
export function listTokensForAdmin(db: Database.Database): AdminTokenRow[] {
  return db
    .prepare(
      "SELECT account_id, bearer IS NOT NULL AS has_bearer, expires_at, updated_at FROM tokens",
    )
    .all() as AdminTokenRow[];
}

/** List rate limit rows for all accounts. */
export function listRateLimitsForAdmin(
  db: Database.Database,
): AdminRateLimitRow[] {
  return db
    .prepare(
      "SELECT account_id, last_429_at, retry_after_at, re_enable_at, updated_at FROM rate_limits",
    )
    .all() as AdminRateLimitRow[];
}

/** List recent login failures, most recent first. */
export function listRecentLoginFailures(
  db: Database.Database,
  limit = 50,
): AdminLoginFailureRow[] {
  return db
    .prepare(
      "SELECT id, account_id, attempted_at, reason, status_code FROM login_failures ORDER BY attempted_at DESC LIMIT ?",
    )
    .all(limit) as AdminLoginFailureRow[];
}

/** Count video jobs grouped by account_id and status. */
export function countVideoJobsByStatus(
  db: Database.Database,
): AdminVideoJobCount[] {
  return db
    .prepare(
      "SELECT account_id, status, COUNT(*) AS count FROM video_jobs GROUP BY account_id, status",
    )
    .all() as AdminVideoJobCount[];
}

/** Count login failures per account since a given timestamp. */
export function countLoginFailuresByAccount(
  db: Database.Database,
  sinceMs: number,
): { account_id: number; count: number }[] {
  return db
    .prepare(
      "SELECT account_id, COUNT(*) AS count FROM login_failures WHERE attempted_at >= ? GROUP BY account_id",
    )
    .all(sinceMs) as { account_id: number; count: number }[];
}

/** Get the active account ID, or null if pool is exhausted. */
export function getActiveAccountId(db: Database.Database): number | null {
  const row = db
    .prepare("SELECT id FROM accounts WHERE state = 'active' LIMIT 1")
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}
