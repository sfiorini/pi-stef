/**
 * OpenAI-compatible route barrel.
 *
 * Mounts all OpenAI-compatible sub-routers under /v1:
 *   - /v1/models
 *   - /v1/chat/completions
 *   - /v1/images/generations, /v1/images/edits
 *   - /v1/videos/generations, /v1/videos/generations/:id, /v1/videos/edits
 *
 * Each sub-router's relative paths compose to the full /v1/... paths.
 * The auth gate is mounted upstream in app.ts (not here).
 */

import { createOpenApiSubApp } from "../../server/openapi-helpers";
import { modelsRoutes, type ModelsRouteDeps } from "./models";
import { chatRoutes, type ChatRouteDeps } from "./chat";
import { imagesRoutes, type ImagesRouteDeps } from "./images";
import { videosRoutes, type VideosRouteDeps } from "./videos";

export type { ModelsRouteDeps, ChatRouteDeps, ImagesRouteDeps, VideosRouteDeps };

export type OpenAIRouteDeps = ModelsRouteDeps &
  ChatRouteDeps &
  ImagesRouteDeps &
  VideosRouteDeps;

export function openaiRoutes(deps: OpenAIRouteDeps) {
  const r = createOpenApiSubApp();

  r.route("/", modelsRoutes(deps));
  r.route("/", chatRoutes(deps));
  r.route("/", imagesRoutes(deps));
  r.route("/", videosRoutes(deps));

  return r;
}
