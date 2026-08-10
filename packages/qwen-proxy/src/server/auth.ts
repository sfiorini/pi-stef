import type { Context, Next } from "hono";
import type Database from "better-sqlite3";
import type { Logger } from "./logger";
import { isValidKey, touchLastUsed } from "../store/api-keys";
import { openaiError, anthropicError } from "./envelopes";

export interface ClientAuthGateDeps {
  db: Database.Database;
  envKeys: string[];
  log: Logger;
}

/**
 * Hono middleware that authenticates client requests via
 * Authorization: Bearer <key> OR x-api-key: <key>.
 *
 * /v1/health is exempt (mounted before this gate).
 *
 * On failure: 401 in the path-appropriate envelope:
 *   /v1/messages* → Anthropic envelope (type: "error")
 *   else          → OpenAI envelope (error: {...})
 *
 * Both surfaces use type "authentication_error" (D11).
 */
export function clientAuthGate(deps: ClientAuthGateDeps) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Extract key from Authorization: Bearer <k> OR x-api-key: <k>
    let key: string | undefined;

    const authHeader = c.req.header("Authorization");
    if (authHeader) {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) key = match[1];
    }

    if (!key) {
      const xApiKey = c.req.header("x-api-key");
      if (xApiKey) key = xApiKey;
    }

    if (!key || !isValidKey(deps.db, key, deps.envKeys)) {
      // Determine path-appropriate envelope (D11)
      const path = new URL(c.req.url).pathname;
      const isAnthropic = path.startsWith("/v1/messages");

      if (isAnthropic) {
        return anthropicError(c, 401, "authentication_error", "Invalid API key");
      }
      return openaiError(c, 401, "Invalid API key");
    }

    // Fire-and-forget touch
    touchLastUsed(deps.db, key);

    await next();
  };
}
