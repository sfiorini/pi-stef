/**
 * OpenAI-compatible route barrel.
 *
 * Mounts all OpenAI-compatible sub-routers under /v1:
 *   - /v1/models
 *   - /v1/chat/completions
 *
 * Each sub-router's relative paths compose to the full /v1/... paths.
 * The auth gate is mounted upstream in app.ts (not here).
 */

import { createOpenApiSubApp } from "../../server/openapi-helpers";
import { modelsRoutes, type ModelsRouteDeps } from "./models";
import { chatRoutes, type ChatRouteDeps } from "./chat";

export type { ModelsRouteDeps, ChatRouteDeps };

export type OpenAIRouteDeps = ModelsRouteDeps & ChatRouteDeps;

export function openaiRoutes(deps: OpenAIRouteDeps) {
  const r = createOpenApiSubApp();

  r.route("/", modelsRoutes(deps));
  r.route("/", chatRoutes(deps));

  return r;
}
