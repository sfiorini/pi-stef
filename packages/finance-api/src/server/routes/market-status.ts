import { Hono } from "hono";
import { classifySession } from "../../market/session";
import { ok, fail } from "../errors";

export function marketStatusRoutes() {
  const r = new Hono();
  r.get("/", (c) => {
    try {
      const session = classifySession(new Date());
      return c.json(ok({ session, timestamp: Date.now() }));
    } catch (err) {
      // Handle year-guard throw gracefully
      return c.json(fail("session_unavailable", err instanceof Error ? err.message : "Session classification failed"), 503);
    }
  });
  return r;
}
