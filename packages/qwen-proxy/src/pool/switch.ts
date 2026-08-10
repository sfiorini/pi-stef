import type Database from "better-sqlite3";

export interface SwitchResult {
  newActiveId: number | null;
  earliestReEnableAt: number | null;
}

/**
 * Atomic failover: demote the failed account, pick next eligible, promote.
 * Runs as ONE synchronous db.transaction.
 *
 * 1. Double-check active == failedId (else no-op, return current).
 * 2. Demote failedId (state='disabled', re_enable_at=now+cooldownMs), guarded WHERE state='active'.
 * 3. Upsert rate_limits row (last_429_at=now, re_enable_at=now+cooldownMs).
 * 4. Pick next eligible (disabled, re_enable_at IS NULL OR re_enable_at <= now, lowest ord).
 * 5. If found → promote to 'active', return {newActiveId, earliestReEnableAt:null}.
 *    Else → {newActiveId:null, earliestReEnableAt: MIN(re_enable_at) among disabled}.
 */
export function atomicSwitch(
  db: Database.Database,
  failedId: number,
  cooldownMs: number,
  now: number,
): SwitchResult {
  const txn = db.transaction((): SwitchResult => {
    // (1) Double-check: is failedId still active?
    const current = db
      .prepare("SELECT id FROM accounts WHERE state = 'active'")
      .get() as { id: number } | undefined;

    if (!current || current.id !== failedId) {
      // Active already differs (or no active) — no-op
      return {
        newActiveId: current?.id ?? null,
        earliestReEnableAt: null,
      };
    }

    // (2) Demote failedId
    const reEnableAt = now + cooldownMs;
    db.prepare(
      "UPDATE accounts SET state = 'disabled', re_enable_at = ? WHERE id = ? AND state = 'active'",
    ).run(reEnableAt, failedId);

    // (3) Upsert rate_limits
    db.prepare(
      `INSERT INTO rate_limits (account_id, last_429_at, retry_after_at, re_enable_at, updated_at)
       VALUES (?, ?, NULL, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         last_429_at    = excluded.last_429_at,
         retry_after_at = excluded.retry_after_at,
         re_enable_at   = excluded.re_enable_at,
         updated_at     = excluded.updated_at`,
    ).run(failedId, now, reEnableAt, now);

    // (4) Pick next eligible (disabled, re_enable_at IS NULL OR re_enable_at <= now, lowest ord)
    const next = db
      .prepare(
        `SELECT id FROM accounts
         WHERE state = 'disabled'
           AND (re_enable_at IS NULL OR re_enable_at <= ?)
         ORDER BY ord ASC, id ASC
         LIMIT 1`,
      )
      .get(now) as { id: number } | undefined;

    if (next) {
      // (5a) Promote next
      db.prepare(
        "UPDATE accounts SET state = 'active', re_enable_at = NULL WHERE id = ?",
      ).run(next.id);
      return { newActiveId: next.id, earliestReEnableAt: null };
    }

    // (5b) No eligible — find earliest re_enable_at
    const minRow = db
      .prepare(
        `SELECT MIN(re_enable_at) as min_re FROM accounts
         WHERE state = 'disabled' AND re_enable_at IS NOT NULL`,
      )
      .get() as { min_re: number | null };

    return { newActiveId: null, earliestReEnableAt: minRow.min_re };
  });

  return txn();
}
