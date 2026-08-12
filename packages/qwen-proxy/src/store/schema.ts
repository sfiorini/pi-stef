export interface Migration {
  version: number;
  statement: string;
}

export const MIGRATIONS: Migration[] = [
  // v1 — migration bookkeeping (the runner relies on this table existing).
  {
    version: 1,
    statement: `CREATE TABLE IF NOT EXISTS schema_versions (
       version    INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL)`,
  },
  // v2 — guest-mode client API keys (S4 client-auth gate). Guest-only schema:
  // there are no accounts/tokens/rate_limits/login_failures/video_jobs tables.
  {
    version: 2,
    statement: `CREATE TABLE IF NOT EXISTS api_keys (
       key         TEXT PRIMARY KEY,
       label       TEXT,
       created_at  INTEGER NOT NULL,
       last_used_at INTEGER,
       revoked_at  INTEGER)`,
  },
];
