import type Database from "better-sqlite3";

export interface AccountRow { id: string; provider_id: string; kind: string; name: string; mask_last4?: string | null; currency?: string; }
export interface HoldingRow { account_id: string; symbol: string; quantity: number; avg_cost?: number | null; asset_class: string; subclass?: string | null; as_of: number; }

export function upsertAccount(db: Database.Database, a: AccountRow): void {
  db.prepare(`INSERT INTO accounts (id,provider_id,kind,name,mask_last4,currency,stale_at,stale_reason)
              VALUES (@id,@provider_id,@kind,@name,@mask_last4,@currency,NULL,NULL)
              ON CONFLICT(id) DO UPDATE SET provider_id=@provider_id, kind=@kind, name=@name, mask_last4=@mask_last4, currency=@currency`)
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
