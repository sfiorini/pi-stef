import { Hono } from "hono";
import type Database from "better-sqlite3";
import { listPendingSuggestions, dismissSuggestion } from "../../store/repo";
import { ok, fail } from "../errors";

export function suggestionsRoutes(db: Database.Database) {
  const r = new Hono();
  r.get("/", (c) => {
    const suggestions = listPendingSuggestions(db).map((s) => ({
      ...s,
      payload: JSON.parse(s.payload),
    }));
    return c.json(ok({ suggestions }));
  });
  r.post("/dismiss", async (c) => {
    const { id } = await c.req.json();
    if (!id) return c.json(fail("bad_request", "Missing id"), 400);
    dismissSuggestion(db, id);
    return c.json(ok({ dismissed: id }));
  });
  return r;
}
