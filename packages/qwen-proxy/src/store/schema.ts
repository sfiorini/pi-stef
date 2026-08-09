export interface Migration {
  version: number;
  statement: string;
}

export const MIGRATIONS: Migration[] = [
  // v1 — accounts (plaintext password, hashed at send-time only)
  {
    version: 1,
    statement: `CREATE TABLE IF NOT EXISTS accounts (
       id       INTEGER PRIMARY KEY,
       email    TEXT NOT NULL UNIQUE,
       password TEXT NOT NULL,
       ord      INTEGER NOT NULL DEFAULT 0)`,
  },

  // v2 — tokens (W11 SEPARATE table; one row per account; cascade on account delete)
  {
    version: 2,
    statement: `CREATE TABLE IF NOT EXISTS tokens (
       account_id INTEGER PRIMARY KEY,
       bearer     TEXT,
       expires_at INTEGER,
       updated_at INTEGER NOT NULL,
       FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE)`,
  },

  // v3 — rate_limits (current cooldown state)
  {
    version: 3,
    statement: `CREATE TABLE IF NOT EXISTS rate_limits (
       account_id     INTEGER PRIMARY KEY,
       last_429_at    INTEGER,
       retry_after_at INTEGER,
       updated_at     INTEGER NOT NULL,
       FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE)`,
  },

  // v4 — login_failures (diagnostics log; many rows per account)
  {
    version: 4,
    statement: `CREATE TABLE IF NOT EXISTS login_failures (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       account_id   INTEGER NOT NULL,
       attempted_at INTEGER NOT NULL,
       reason       TEXT NOT NULL,
       status_code  INTEGER,
       FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE)`,
  },

  // v5 — schema_versions (idempotent; runner also creates it)
  {
    version: 5,
    statement: `CREATE TABLE IF NOT EXISTS schema_versions (
       version    INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL)`,
  },

  // v6 — index: accounts (failover selection by ord)
  {
    version: 6,
    statement: `CREATE INDEX IF NOT EXISTS idx_accounts_ord ON accounts (ord)`,
  },

  // v7 — index: tokens (refresh sweep by recency)
  {
    version: 7,
    statement: `CREATE INDEX IF NOT EXISTS idx_tokens_updated ON tokens (updated_at)`,
  },

  // v8 — index: rate_limits (cooldown sweep by recency)
  {
    version: 8,
    statement: `CREATE INDEX IF NOT EXISTS idx_rate_limits_updated ON rate_limits (updated_at)`,
  },

  // v9 — PRAGMA re-assert (connection-scoped; openDb also sets it on every connection)
  // NOTE: This migration is symbolic/redundant — SQLite ignores `PRAGMA foreign_keys`
  // inside a transaction, and `openDb` sets it outside any txn. Kept for schema_versions
  // bookkeeping so a maintainer doesn't remove the openDb PRAGMA.
  {
    version: 9,
    statement: `PRAGMA foreign_keys = ON`,
  },
];
