import type Database from "better-sqlite3";

export interface AccountRow { id: string; provider_id: string; kind: string; name: string; mask_last4?: string | null; currency?: string; }
export interface HoldingRow { account_id: string; symbol: string; quantity: number; avg_cost?: number | null; asset_class: string; subclass?: string | null; as_of: number; }

export function upsertAccount(db: Database.Database, a: AccountRow): void {
  db.prepare(`INSERT INTO accounts (id,provider_id,kind,name,mask_last4,currency,stale_at,stale_reason)
              VALUES (@id,@provider_id,@kind,@name,@mask_last4,@currency,NULL,NULL)
              ON CONFLICT(id) DO UPDATE SET provider_id=@provider_id, kind=@kind, name=@name, mask_last4=@mask_last4, currency=@currency, stale_at=NULL, stale_reason=NULL`)
    .run({ ...a, mask_last4: a.mask_last4 ?? null, currency: a.currency ?? "USD" });
}

export function markStale(db: Database.Database, id: string, staleAt: number, reason: string): void {
  db.prepare("UPDATE accounts SET stale_at=?, stale_reason=? WHERE id=?").run(staleAt, reason, id);
}

export function upsertHolding(db: Database.Database, h: HoldingRow): void {
  db.prepare(`INSERT INTO holdings (account_id,symbol,quantity,avg_cost,asset_class,subclass,as_of)
              VALUES (@account_id,@symbol,@quantity,@avg_cost,@asset_class,@subclass,@as_of)
              ON CONFLICT(account_id,symbol) DO UPDATE SET quantity=@quantity,avg_cost=@avg_cost,asset_class=@asset_class,subclass=@subclass,as_of=@as_of`)
    .run({ ...h, avg_cost: h.avg_cost ?? null, subclass: h.subclass ?? null });
}

export function listHoldings(db: Database.Database, accountId: string): HoldingRow[] {
  return db.prepare("SELECT * FROM holdings WHERE account_id=?").all(accountId) as HoldingRow[];
}

export function listAccounts(db: Database.Database): AccountRow[] {
  return db.prepare("SELECT * FROM accounts").all() as AccountRow[];
}

export interface TransactionRow { id: string; account_id: string; date: number; symbol?: string | null; qty?: number | null; price?: number | null; type: string; fees?: number | null }

export function upsertTransaction(db: Database.Database, t: TransactionRow): void {
  db.prepare(`INSERT INTO transactions (id, account_id, date, symbol, qty, price, type, fees)
              VALUES (@id, @account_id, @date, @symbol, @qty, @price, @type, @fees)
              ON CONFLICT(id) DO UPDATE SET account_id=@account_id, date=@date, symbol=@symbol, qty=@qty, price=@price, type=@type, fees=@fees`)
    .run({ ...t, symbol: t.symbol ?? null, qty: t.qty ?? null, price: t.price ?? null, fees: t.fees ?? null });
}

export function listTransactions(db: Database.Database, accountId: string): TransactionRow[] {
  return db.prepare("SELECT * FROM transactions WHERE account_id=? ORDER BY date").all(accountId) as TransactionRow[];
}

export interface BalanceRow { account_id: string; cash: number; market_value: number; as_of: number }

export function upsertBalance(db: Database.Database, b: BalanceRow): void {
  db.prepare(`INSERT INTO balances (account_id, cash, market_value, as_of)
              VALUES (@account_id, @cash, @market_value, @as_of)
              ON CONFLICT(account_id) DO UPDATE SET cash=@cash, market_value=@market_value, as_of=@as_of`)
    .run(b);
}

export function getBalance(db: Database.Database, accountId: string): BalanceRow | undefined {
  return db.prepare("SELECT * FROM balances WHERE account_id=?").get(accountId) as BalanceRow | undefined;
}

export function getTxnWatermark(db: Database.Database, accountId: string): number | null {
  const row = db.prepare("SELECT last_txn_sync_at AS w FROM accounts WHERE id=?").get(accountId) as { w: number | null } | undefined;
  return row?.w ?? null;
}

export function setTxnWatermark(db: Database.Database, accountId: string, ts: number): void {
  db.prepare("UPDATE accounts SET last_txn_sync_at=? WHERE id=?").run(ts, accountId);
}

export interface LotRow { id: string; holding_key: string; open_date: number; qty: number; cost_basis: number }

export function upsertLot(db: Database.Database, lot: LotRow): void {
  db.prepare(`INSERT INTO lots (id, holding_key, open_date, qty, cost_basis)
              VALUES (@id, @holding_key, @open_date, @qty, @cost_basis)
              ON CONFLICT(id) DO UPDATE SET qty=@qty, cost_basis=@cost_basis`)
    .run(lot);
}

export interface SuggestionRow { id: string; created_at: number; market_session: string; kind: string; payload: string; status: string }

export function insertSuggestion(db: Database.Database, s: SuggestionRow): void {
  db.prepare(`INSERT INTO suggestion_records (id, created_at, market_session, kind, payload, status)
              VALUES (@id, @created_at, @market_session, @kind, @payload, @status)`)
    .run(s);
}

export function listPendingSuggestions(db: Database.Database): SuggestionRow[] {
  return db.prepare("SELECT * FROM suggestion_records WHERE status='pending' ORDER BY created_at").all() as SuggestionRow[];
}

export function dismissSuggestion(db: Database.Database, id: string): void {
  db.prepare("UPDATE suggestion_records SET status='dismissed' WHERE id=?").run(id);
}

export interface GoalRow { id: string; name: string; target_allocation: string; risk_limits: string; horizon_years?: number | null }

export function upsertGoal(db: Database.Database, g: GoalRow): void {
  db.prepare(`INSERT INTO goals (id, name, target_allocation, risk_limits, horizon_years)
              VALUES (@id, @name, @target_allocation, @risk_limits, @horizon_years)
              ON CONFLICT(id) DO UPDATE SET name=@name, target_allocation=@target_allocation, risk_limits=@risk_limits, horizon_years=@horizon_years`)
    .run({ ...g, horizon_years: g.horizon_years ?? null });
}

export function listGoals(db: Database.Database): GoalRow[] {
  return db.prepare("SELECT * FROM goals").all() as GoalRow[];
}
