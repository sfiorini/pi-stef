export interface Migration { version: number; statement: string }

// v1 — initial schema. Future schema changes ADD new {version, statement} entries
// (e.g. ALTER TABLE ...) rather than editing these. The runner (migrations.ts)
// applies only migrations with version > current recorded version.
export const MIGRATIONS_V1: Migration[] = [
  { version: 1, statement:
    `CREATE TABLE IF NOT EXISTS accounts (
       id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, kind TEXT NOT NULL,
       name TEXT NOT NULL, mask_last4 TEXT, currency TEXT NOT NULL DEFAULT 'USD',
       stale_at INTEGER, stale_reason TEXT)` },
  { version: 2, statement:
    `CREATE TABLE IF NOT EXISTS holdings (
       account_id TEXT NOT NULL, symbol TEXT NOT NULL, quantity REAL NOT NULL,
       avg_cost REAL, asset_class TEXT NOT NULL, subclass TEXT, as_of INTEGER NOT NULL,
       PRIMARY KEY (account_id, symbol))` },
  { version: 3, statement:
    `CREATE TABLE IF NOT EXISTS transactions (
       id TEXT PRIMARY KEY, account_id TEXT NOT NULL, date INTEGER NOT NULL,
       symbol TEXT, qty REAL, price REAL, type TEXT, fees REAL DEFAULT 0)` },
  { version: 4, statement:
    `CREATE TABLE IF NOT EXISTS prices (
       symbol TEXT NOT NULL, date INTEGER NOT NULL, close REAL NOT NULL, source TEXT NOT NULL,
       PRIMARY KEY (symbol, date))` },
  { version: 5, statement:
    `CREATE TABLE IF NOT EXISTS lots (
       id TEXT PRIMARY KEY, holding_key TEXT NOT NULL, open_date INTEGER NOT NULL,
       qty REAL NOT NULL, cost_basis REAL NOT NULL)` },
  { version: 6, statement:
    `CREATE TABLE IF NOT EXISTS goals (
       id TEXT PRIMARY KEY, name TEXT NOT NULL, target_allocation TEXT NOT NULL,
       risk_limits TEXT NOT NULL, horizon_years INTEGER)` },
  { version: 7, statement:
    `CREATE TABLE IF NOT EXISTS suggestion_records (
       id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, market_session TEXT NOT NULL,
       kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending')` },
  { version: 8, statement:
    `CREATE TABLE IF NOT EXISTS market_sessions (
       date TEXT PRIMARY KEY, session TEXT NOT NULL, snapshot TEXT NOT NULL)` },
];
