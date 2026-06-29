import type Database from "better-sqlite3";
import type { ProviderAdapter, Credentials } from "./contract";
import { normalizeHolding } from "./normalizer";
import { upsertAccount, upsertHolding, upsertLot, markStale, listHoldings, listAccounts, upsertTransaction, upsertBalance, getTxnWatermark, setTxnWatermark } from "../store/repo";

export type AdapterRegistry = Map<string, ProviderAdapter>;

export interface IngestCreds { [providerId: string]: Credentials }

export interface IngestResult { accounts: number; holdings: number; transactions: number; errors: number }

export async function runIngest(db: Database.Database, registry: AdapterRegistry, creds: IngestCreds, log?: { warn: (m: string, ctx?: unknown) => void }): Promise<IngestResult> {
  let accounts = 0, holdings = 0, transactions = 0, errors = 0;
  for (const [providerId, adapter] of registry) {
    const c = creds[providerId];
    if (!c) continue;
    let session;
    try {
      session = await adapter.authenticate(c);
    } catch (e) {
      // provider-level auth failure: log so the always-on daemon doesn't silently retry forever.
      // No per-account row exists yet to mark stale; surfaced via the result + log.
      log?.warn(`ingest auth failed`, { providerId, error: e instanceof Error ? e.message : String(e) });
      errors++;
      continue;
    }
    // Attach creds to the session so per-call methods (getHoldings/getTransactions/getBalances)
    // receive them via `session.creds` — the agreed threading pattern for all adapters.
    session = { ...session, creds: c };
    try {
      const accts = await adapter.listAccounts(session);
      for (const acc of accts) {
        const id = `${providerId}:${acc.providerAccountId}`;
        upsertAccount(db, { id, provider_id: providerId, kind: acc.kind, name: acc.name, mask_last4: acc.maskLast4 ?? null, currency: acc.currency });
        accounts++;
        try {
          const asOf = Date.now();
          const raws = await adapter.getHoldings(session, acc.providerAccountId);
          
          // Clear existing holdings for this account before re-inserting
          // This prevents stale holdings from accumulating when positions are sold
          // Wrap in a transaction so either all holdings are replaced or none are
          const replaceHoldings = db.transaction(() => {
            // Delete existing holdings and lots for this account
            db.prepare("DELETE FROM holdings WHERE account_id=?").run(id);
            db.prepare("DELETE FROM lots WHERE holding_key LIKE ?").run(`${id}:%`);
            
            for (const raw of raws) {
              try {
                const n = normalizeHolding({ providerId, accountId: id, asOf }, raw);
                const { lots, ...row } = n;
                upsertHolding(db, row);
                holdings++;
                // Persist tax lots if provided
                if (lots) {
                  for (const lot of lots) {
                    upsertLot(db, {
                      id: `${id}:${n.symbol}:${lot.open_date}`,
                      holding_key: `${id}:${n.symbol}`,
                      ...lot,
                    });
                  }
                }
              } catch (e) {
                // Log individual holding errors but continue with others
                log?.warn("holding ingest failed", { accountId: id, symbol: raw.symbol, error: e instanceof Error ? e.message : String(e) });
              }
            }
          });
          replaceHoldings();
        } catch (e) {
          markStale(db, id, Date.now(), e instanceof Error ? e.message : String(e));
          errors++;
        }
        // Persist transactions incrementally (id-keyed upsert) using the per-account watermark.
        try {
          const lastSync = getTxnWatermark(db, id);
          // null watermark (first sync) → undefined, matching the contract's optional `since?: number`
          const txns = await adapter.getTransactions(session, acc.providerAccountId, lastSync ?? undefined);
          for (const t of txns) {
            try {
              upsertTransaction(db, {
                id: t.id, account_id: id, date: t.date,
                symbol: t.symbol ?? null, qty: t.qty ?? null, price: t.price ?? null,
                type: t.type, fees: t.fees ?? 0,
              });
            } catch (e) {
              log?.warn("transaction ingest failed", { accountId: id, txnId: t.id, error: e instanceof Error ? e.message : String(e) });
            }
          }
          transactions += txns.length;
          setTxnWatermark(db, id, Date.now());
        } catch (e) {
          // Transaction fetch failures are non-fatal for ingest
          log?.warn("transactions fetch failed", { accountId: id, error: e instanceof Error ? e.message : String(e) });
        }
        // Persist the latest balance snapshot (one row per account).
        try {
          const bal = await adapter.getBalances(session, acc.providerAccountId);
          upsertBalance(db, { account_id: id, cash: bal.cash, market_value: bal.marketValue, as_of: bal.asOf });
        } catch (e) {
          // Balance fetch failures are non-fatal for ingest
          log?.warn("balance fetch failed", { accountId: id, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      // listAccounts-level failure: account rows may not exist yet to mark stale; log + count.
      log?.warn(`ingest listAccounts failed`, { providerId, error: e instanceof Error ? e.message : String(e) });
      errors++;
    }
  }
  return { accounts, holdings, transactions, errors };
}

// re-exports for convenience
export { listHoldings, listAccounts };
