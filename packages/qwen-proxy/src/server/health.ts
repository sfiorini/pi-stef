import { createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { createOpenApiSubApp } from "./openapi-helpers";

const healthResponse = z.object({
  status: z.literal("ok"),
});

const healthRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: { "application/json": { schema: healthResponse } },
      description: "Service is healthy",
    },
  },
});

export function healthRoutes() {
  const r = createOpenApiSubApp();

  r.openapi(healthRoute, (c) => {
    return c.json({ status: "ok" as const }, 200);
  });

  return r;
}
