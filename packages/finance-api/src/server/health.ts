import { createRoute } from "@hono/zod-openapi";
import { createOpenApiSubApp } from "./openapi-helpers";
import { healthResponse } from "./openapi-schemas";
import { ok } from "./errors";

const healthRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["System"],
  summary: "Health check",
  responses: {
    200: {
      content: { "application/json": { schema: healthResponse } },
      description: "Service is healthy",
    },
  },
});

export function healthRoutes() {
  const r = createOpenApiSubApp();
  const startTime = Date.now();

  r.openapi(healthRoute, (c) => {
    const uptimeS = Math.floor((Date.now() - startTime) / 1000);
    return c.json(ok({ status: "ok", uptimeS }), 200);
  });

  return r;
}
