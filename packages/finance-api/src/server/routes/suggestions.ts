import { Hono } from "hono";
import { createRoute } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { listPendingSuggestions, dismissSuggestion } from "../../store/repo";
import { createOpenApiSubApp } from "../openapi-helpers";
import { suggestionsListResponse, errorResponse } from "../openapi-schemas";
import { ok, fail } from "../errors";

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

export function suggestionsRoutes(db: Database.Database) {
  // Use OpenAPIHono for GET routes, plain Hono methods for POST (converted in M3)
  const r = createOpenApiSubApp();

  r.openapi(listSuggestionsRoute, (c) => {
    const suggestions = listPendingSuggestions(db).map((s) => ({
      ...s,
      payload: JSON.parse(s.payload),
    }));
    return c.json(ok({ suggestions }), 200);
  });

  // POST handler — will be converted to createRoute in M3
  (r as unknown as Hono).post("/dismiss", async (c) => {
    const { id } = await c.req.json();
    if (!id) return c.json(fail("bad_request", "Missing id"), 400);
    dismissSuggestion(db, id);
    return c.json(ok({ dismissed: id }));
  });

  return r;
}
