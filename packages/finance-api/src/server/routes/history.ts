import { Hono } from "hono";
import type Database from "better-sqlite3";
import { ok, fail } from "../errors";

export function historyRoutes(db: Database.Database) {
  const r = new Hono();
  r.get("/", (c) => {
    const symbol = c.req.query("symbol");
    const accountId = c.req.query("accountId");
    if (!symbol) return c.json(fail("bad_request", "Missing symbol query param"), 400);
    
    let rows;
    if (accountId) {
      // Filter by account: join through holdings to get account-specific prices
      rows = db.prepare(`
        SELECT DISTINCT p.* FROM prices p
        JOIN holdings h ON h.symbol = p.symbol
        WHERE p.symbol = ? AND h.account_id = ?
        ORDER BY p.date DESC
      `).all(symbol, accountId);
    } else {
      rows = db.prepare("SELECT * FROM prices WHERE symbol=? ORDER BY date DESC").all(symbol);
    }
    return c.json(ok({ history: rows }));
  });
  return r;
}
