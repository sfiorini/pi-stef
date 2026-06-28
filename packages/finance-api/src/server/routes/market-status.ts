import { Hono } from "hono";
import { classifySession } from "../../market/session";
import { ok } from "../errors";

export function marketStatusRoutes() {
  const r = new Hono();
  r.get("/", (c) => {
    const session = classifySession(new Date());
    return c.json(ok({ session, timestamp: Date.now() }));
  });
  return r;
}
