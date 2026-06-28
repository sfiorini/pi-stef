import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listAccounts, listHoldings } from "../../store/repo";
import { ok } from "../errors";

export function holdingsRoutes(db: Database.Database) {
  const r = new Hono();
  r.get("/", (c) => {
    const accounts = listAccounts(db).map((a) => ({
      ...a,
      holdings: listHoldings(db, a.id),
      staleAt: a.stale_at,
      staleReason: a.stale_reason,
    }));
    return c.json(ok({ accounts }));
  });
  return r;
}
