import type { Context, Next, MiddlewareHandler } from "hono";
import { constantTimeEquals } from "../store/api-keys";

export interface AdminGateDeps {
  adminKey: string | undefined;
}

/**
 * Admin auth middleware.
 *
 * D15: When adminKey is undefined, returns 404 (dashboard invisible).
 * Supports: Bearer > x-api-key > cookie admin_key > ?key= query param.
 * Valid query key sets an HttpOnly cookie for auto-refresh persistence.
 */
export function adminGate(deps: AdminGateDeps): MiddlewareHandler {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // D15: when adminKey is unset, the dashboard is fully invisible (404, not 401).
    if (deps.adminKey === undefined) return c.notFound();

    // Extract candidate (precedence: Bearer > x-api-key > cookie > query)
    let candidate: string | undefined;

    const authHeader = c.req.header("Authorization");
    if (authHeader) {
      const m = authHeader.match(/^Bearer\s+(.+)$/i);
      if (m) candidate = m[1];
    }

    if (!candidate) {
      const xKey = c.req.header("x-api-key");
      if (xKey) candidate = xKey;
    }

    if (!candidate) {
      const ck = c.req.header("Cookie");
      if (ck) {
        const m = ck.match(/(?:^|;\s*)admin_key=([^;]+)/);
        if (m) candidate = decodeURIComponent(m[1]);
      }
    }

    let queryKey: string | undefined;
    if (!candidate) {
      queryKey = c.req.query("key");
      if (queryKey) candidate = queryKey;
    }

    if (!candidate) return c.text("Unauthorized", 401);

    if (!constantTimeEquals(candidate, deps.adminKey))
      return c.text("Unauthorized", 401);

    // If valid query key, set HttpOnly cookie for future auto-refresh
    if (queryKey)
      c.header(
        "Set-Cookie",
        `admin_key=${encodeURIComponent(queryKey)}; HttpOnly; SameSite=Strict; Path=/admin`,
      );

    await next();
  };
}
