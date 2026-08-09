import type Database from "better-sqlite3";
import type { Account } from "../config/types";

// ── Row types ───────────────────────────────────────────────────────────────

/** Safe view for public API — NO password. */
export interface SafeAccountRow {
  id: number;
  email: string;
  ord: number;
}

/** Full row for INTERNAL credential use only. */
export interface AccountRow extends SafeAccountRow {
  password: string;
}

export interface TokenRow {
  account_id: number;
  bearer: string | null;
  expires_at: number | null;
  updated_at: number;
}

// ── Accounts ────────────────────────────────────────────────────────────────

export function listAccounts(db: Database.Database): SafeAccountRow[] {
  return db
    .prepare("SELECT id, email, ord FROM accounts ORDER BY ord, id")
    .all() as SafeAccountRow[];
}

export function getAccount(
  db: Database.Database,
  id: number,
): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as
    | AccountRow
    | undefined;
}

/**
 * Reconcile the accounts table with the config list.
 * Runs in ONE transaction:
 *   1. Upsert each config account (INSERT … ON CONFLICT DO UPDATE).
 *   2. DELETE accounts whose id is NOT in the config list (or delete ALL if
 *      config is empty). The FK ON DELETE CASCADE purges tokens/rate_limits/
 *      login_failures automatically.
 * Returns counts for logging (no credentials in counts).
 */
export function reconcileAccounts(
  db: Database.Database,
  accounts: Account[],
): { inserted: number; updated: number; deleted: number } {
  const existingIds = new Set(
    (db.prepare("SELECT id FROM accounts").all() as { id: number }[]).map(
      (r) => r.id,
    ),
  );

  const upsertStmt = db.prepare(
    `INSERT INTO accounts (id, email, password, ord)
     VALUES (@id, @email, @password, @ord)
     ON CONFLICT(id) DO UPDATE SET
       email    = excluded.email,
       password = excluded.password,
       ord      = excluded.ord`,
  );

  let inserted = 0;
  let updated = 0;

  const reconcile = db.transaction(() => {
    for (const a of accounts) {
      const existed = existingIds.has(a.id);
      upsertStmt.run({ id: a.id, email: a.email, password: a.password, ord: a.ord });
      if (existed) {
        updated++;
      } else {
        inserted++;
      }
    }

    // Delete accounts not in config (or all if config empty)
    if (accounts.length > 0) {
      const placeholders = accounts.map(() => "?").join(",");
      const ids = accounts.map((a) => a.id);
      const info = db
        .prepare(`DELETE FROM accounts WHERE id NOT IN (${placeholders})`)
        .run(...ids);
      return Number(info.changes);
    } else {
      const info = db.prepare("DELETE FROM accounts").run();
      return Number(info.changes);
    }
  });

  const deleted = reconcile();
  return { inserted, updated, deleted };
}

// ── Tokens ──────────────────────────────────────────────────────────────────

export function upsertToken(
  db: Database.Database,
  accountId: number,
  bearer: string,
  expiresAt: number | null,
): void {
  db.prepare(
    `INSERT INTO tokens (account_id, bearer, expires_at, updated_at)
     VALUES (@accountId, @bearer, @expiresAt, @updatedAt)
     ON CONFLICT(account_id) DO UPDATE SET
       bearer     = excluded.bearer,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).run({
    accountId,
    bearer,
    expiresAt,
    updatedAt: Date.now(),
  });
}

export function getToken(
  db: Database.Database,
  accountId: number,
): TokenRow | undefined {
  return db.prepare("SELECT * FROM tokens WHERE account_id = ?").get(accountId) as
    | TokenRow
    | undefined;
}

export function listTokenRows(db: Database.Database): TokenRow[] {
  return db.prepare("SELECT * FROM tokens").all() as TokenRow[];
}

// ── Login failures ──────────────────────────────────────────────────────────

export function recordLoginFailure(
  db: Database.Database,
  accountId: number,
  reason: string,
  statusCode?: number,
): void {
  db.prepare(
    `INSERT INTO login_failures (account_id, attempted_at, reason, status_code)
     VALUES (@accountId, @attemptedAt, @reason, @statusCode)`,
  ).run({
    accountId,
    attemptedAt: Date.now(),
    reason,
    statusCode: statusCode ?? null,
  });
}

export function listLoginFailures(
  db: Database.Database,
  accountId: number,
): { attempted_at: number; reason: string; status_code: number | null }[] {
  return db
    .prepare(
      "SELECT attempted_at, reason, status_code FROM login_failures WHERE account_id = ? ORDER BY attempted_at",
    )
    .all(accountId) as { attempted_at: number; reason: string; status_code: number | null }[];
}

// ── Rate limits ─────────────────────────────────────────────────────────────

export function upsertRateLimit(
  db: Database.Database,
  accountId: number,
  fields: Partial<{ last_429_at: number; retry_after_at: number }>,
): void {
  db.prepare(
    `INSERT INTO rate_limits (account_id, last_429_at, retry_after_at, updated_at)
     VALUES (@accountId, @last429At, @retryAfterAt, @updatedAt)
     ON CONFLICT(account_id) DO UPDATE SET
       last_429_at    = excluded.last_429_at,
       retry_after_at = excluded.retry_after_at,
       updated_at     = excluded.updated_at`,
  ).run({
    accountId,
    last429At: fields.last_429_at ?? null,
    retryAfterAt: fields.retry_after_at ?? null,
    updatedAt: Date.now(),
  });
}

export function getRateLimit(
  db: Database.Database,
  accountId: number,
):
  | {
      account_id: number;
      last_429_at: number | null;
      retry_after_at: number | null;
    }
  | undefined {
  return db
    .prepare("SELECT * FROM rate_limits WHERE account_id = ?")
    .get(accountId) as
    | { account_id: number; last_429_at: number | null; retry_after_at: number | null }
    | undefined;
}
