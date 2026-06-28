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
        totalValue += h.quantity * (h.avg_cost ?? 0);
      }
    }
    return c.json(ok({ netWorth: totalValue, accountCount: accounts.length }));
  });
  return r;
}
