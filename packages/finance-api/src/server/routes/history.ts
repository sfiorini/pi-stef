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
      rows = db.prepare("SELECT * FROM prices WHERE symbol=? ORDER BY date DESC").all(symbol);
    } else {
      rows = db.prepare("SELECT * FROM prices WHERE symbol=? ORDER BY date DESC").all(symbol);
    }
    return c.json(ok({ history: rows }));
  });
  return r;
}
