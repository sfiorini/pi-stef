/**
 * GET /v1/models — list available models (live upstream + configured aliases).
 *
 * Uses withPoolRetry for empty-completion inline-retry + cooldown.
 * PoolExhaustedError → 429 rate_limit_error + Retry-After.
 * Upstream errors → openaiError envelope.
 */

import type { UpstreamClient } from "../../upstream/client";
import type { withPoolRetry as WithPoolRetryFn } from "../../pool/retry";
import type { RetryDeps } from "../../pool/retry";
import { PoolExhaustedError } from "../../pool/errors";
import { parseModelAliases } from "../../config/model-aliases";
import { createOpenApiSubApp } from "../../server/openapi-helpers";
import { openaiError } from "./errors";

export interface ModelsRouteDeps extends RetryDeps {
  client: Pick<UpstreamClient, "listModels">;
  retry: typeof WithPoolRetryFn;
  configModels: { modelAliasesRaw: string };
}

export function modelsRoutes(deps: ModelsRouteDeps) {
  const r = createOpenApiSubApp();

  r.get("/models", async (c) => {
    // Parse aliases
    const aliases = parseModelAliases(deps.configModels.modelAliasesRaw);

    let upstreamModels: { id: string; object: "model"; owned_by?: string }[];

    try {
      upstreamModels = await deps.retry(deps, async (_accountId, bearer) => {
        return deps.client.listModels(bearer);
      });
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        const retryAfterMs = err.earliestReEnableAt
          ? Math.max(0, err.earliestReEnableAt - Date.now())
          : 60_000;
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);
        c.header("Retry-After", String(retryAfterSec));
        return openaiError(c, 429, "All accounts rate-limited", {
          code: "rate_limit_exceeded",
        });
      }
      return openaiError(c, 500, "Upstream error", {
        code: "upstream_error",
      });
    }

    const now = Math.floor(Date.now() / 1000);

    // Map live models
    const data = upstreamModels.map((m) => ({
      id: m.id,
      object: "model" as const,
      created: now,
      owned_by: m.owned_by,
    }));

    // Append aliases as their own model entries
    for (const [alias] of aliases) {
      data.push({
        id: alias,
        object: "model" as const,
        created: now,
        owned_by: "proxy-alias",
      });
    }

    return c.json({ object: "list" as const, data }, 200);
  });

  return r;
}
