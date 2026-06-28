import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

/**
 * Bearer-token auth middleware for Hono.
 * Compares the Authorization header against the expected token using constant-time comparison.
 */
export function bearerAuth(token: string) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = c.req.header("Authorization") ?? "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json({ ok: false, error: { code: "unauthorized", message: "Missing or invalid Authorization header" } }, 401);
    }
    
    const provided = Buffer.from(match[1]);
    const expected = Buffer.from(token);
    
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return c.json({ ok: false, error: { code: "unauthorized", message: "Invalid token" } }, 401);
    }
    
    await next();
  };
}
