import { createRoute, z } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { listPendingSuggestions, dismissSuggestion } from "../../store/repo";
import { createOpenApiSubApp } from "../openapi-helpers";
import { suggestionsListResponse, dismissResponse, errorResponse } from "../openapi-schemas";
import { ok } from "../errors";

const listSuggestionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Suggestions"],
  summary: "List pending suggestions",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: suggestionsListResponse } },
      description: "Pending suggestions",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

const dismissRoute = createRoute({
  method: "post",
  path: "/dismiss",
  tags: ["Suggestions"],
  summary: "Dismiss a suggestion",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ id: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: dismissResponse } },
      description: "Suggestion dismissed",
    },
    400: {
      content: { "application/json": { schema: errorResponse } },
      description: "Missing id",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function suggestionsRoutes(db: Database.Database) {
  const r = createOpenApiSubApp();

  r.openapi(listSuggestionsRoute, (c) => {
    const suggestions = listPendingSuggestions(db).map((s) => ({
      ...s,
      payload: JSON.parse(s.payload),
    }));
    return c.json(ok({ suggestions }), 200);
  });

  r.openapi(dismissRoute, async (c) => {
    const { id } = c.req.valid("json");
    dismissSuggestion(db, id);
    return c.json(ok({ dismissed: id }), 200);
  });

  return r;
}
