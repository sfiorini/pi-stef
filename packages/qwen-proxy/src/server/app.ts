import { OpenAPIHono } from "@hono/zod-openapi";
import { healthRoutes } from "./health";

export function createApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  // Health endpoint is public (no auth)
  app.route("/v1/health", healthRoutes());

  return app;
}
