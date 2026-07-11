import type Database from "better-sqlite3";
import { listAccounts, listHoldings, getBalance, type HoldingRow, type AccountRow } from "../store/repo";

export interface HoldingValued {
  account_id: string;
  symbol: string;
  quantity: number;
  price: number;
  marketValue: number;
  asset_class: string;
  security_type?: string | null;
}

function latestPrice(db: Database.Database, symbol: string): number | undefined {
  const row = db.prepare("SELECT close FROM prices WHERE symbol=? ORDER BY date DESC LIMIT 1").get(symbol) as { close: number } | undefined;
  return row?.close;
}

/**
 * Value a single holding. Price priority:
 *   1. Latest price from the prices table (Stooq — most recent market data)
 *   2. Provider-supplied price (holdings.price — sync-time snapshot)
 *   3. Cost basis (holdings.avg_cost — last resort)
 *   4. Zero
 *
 * `0` is a valid explicit price, NOT a missing value. The `??` chain only
 * falls through on `null`/`undefined`, so a provider-supplied `$0` price is
 * respected and does not fall through to avg_cost.
 */
export function valueHolding(db: Database.Database, h: HoldingRow): HoldingValued {
  const price = latestPrice(db, h.symbol) ?? h.price ?? h.avg_cost ?? 0;
  return {
    account_id: h.account_id,
    symbol: h.symbol,
    quantity: h.quantity,
    price,
    marketValue: h.quantity * price,
    asset_class: h.asset_class,
    security_type: h.security_type,
  };
}

/** Value all holdings across all accounts (or a single account if specified). */
export function valueHoldings(db: Database.Database, accountId?: string): HoldingValued[] {
  const accounts: AccountRow[] = accountId
    ? listAccounts(db).filter(a => a.id === accountId)
    : listAccounts(db);
  const result: HoldingValued[] = [];
  for (const a of accounts) {
    for (const h of listHoldings(db, a.id)) {
      result.push(valueHolding(db, h));
    }
  }
  return result;
}

/**
 * Compute cash in an account that is NOT already represented by a
 * cash-equivalent holding. Prevents double-counting: if a money market fund
 * (SPAXX/FDRXX) is both a position AND in balances.cash, only count it once.
 *
 * Returns 0 if the account has no balance row.
 */
export function computeUnbilledCash(db: Database.Database, accountId: string): number {
  const balance = getBalance(db, accountId);
  if (!balance) return 0;
  const cashHoldings = listHoldings(db, accountId).filter(h => h.asset_class === "cash");
  const cashPositionValue = cashHoldings.reduce((sum, h) => sum + valueHolding(db, h).marketValue, 0);
  return Math.max(0, balance.cash - cashPositionValue);
}

/** Net worth = Σ(holding market values) + Σ(unbilled cash across all accounts). */
export function computeNetWorth(db: Database.Database): { netWorth: number; accountCount: number } {
  const accounts = listAccounts(db);
  const holdingsValue = valueHoldings(db).reduce((sum, h) => sum + h.marketValue, 0);
  const unbilledCash = accounts.reduce((sum, a) => sum + computeUnbilledCash(db, a.id), 0);
  return { netWorth: holdingsValue + unbilledCash, accountCount: accounts.length };
}
