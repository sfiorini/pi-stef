import { Hono } from "hono";
import { ok } from "./errors";

export function healthRoutes() {
  const r = new Hono();
  const startTime = Date.now();
  
  r.get("/", (c) => {
    const uptimeS = Math.floor((Date.now() - startTime) / 1000);
    return c.json(ok({ status: "ok", uptimeS }));
  });
  
  return r;
}
