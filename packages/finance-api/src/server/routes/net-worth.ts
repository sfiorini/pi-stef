import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listAccounts, listHoldings } from "../../store/repo";
import { ok } from "../errors";

export function netWorthRoutes(db: Database.Database) {
  const r = new Hono();
  r.get("/", (c) => {
    const accounts = listAccounts(db);
    let totalValue = 0;
    for (const a of accounts) {
      const holdings = listHoldings(db, a.id);
      for (const h of holdings) {
        // Use latest price from prices table if available, otherwise fall back to avg_cost
        const priceRow = db.prepare("SELECT close FROM prices WHERE symbol=? ORDER BY date DESC LIMIT 1").get(h.symbol) as { close: number } | undefined;
        const price = priceRow?.close ?? h.avg_cost ?? 0;
        totalValue += h.quantity * price;
      }
    }
    return c.json(ok({ netWorth: totalValue, accountCount: accounts.length }));
  });
  return r;
}
