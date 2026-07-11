import { createRoute } from "@hono/zod-openapi";
import { classifySession } from "../../market/session";
import { createOpenApiSubApp } from "../openapi-helpers";
import { marketStatusResponse, errorResponse } from "../openapi-schemas";
import { ok, fail } from "../errors";

const marketStatusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["System"],
  summary: "Get current market session",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: marketStatusResponse } },
      description: "Current market session",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
    503: {
      content: { "application/json": { schema: errorResponse } },
      description: "Session classification unavailable",
    },
  },
});

export function marketStatusRoutes() {
  const r = createOpenApiSubApp();
  r.openapi(marketStatusRoute, (c) => {
    try {
      const session = classifySession(new Date());
      return c.json(ok({ session, timestamp: Date.now() }), 200);
    } catch (err) {
      // Handle year-guard throw gracefully
      return c.json(
        fail("session_unavailable", err instanceof Error ? err.message : "Session classification failed"),
        503,
      );
    }
  });
  return r;
}
