import { Hono } from "hono";
import { createRoute } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { upsertGoal, listGoals } from "../../store/repo";
import { validateGoal } from "../../quant/validate";
import { createOpenApiSubApp } from "../openapi-helpers";
import { goalsListResponse, errorResponse } from "../openapi-schemas";
import { ok, fail } from "../errors";

const listGoalsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Goals"],
  summary: "List all goals",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: goalsListResponse } },
      description: "All configured goals",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function goalsRoutes(db: Database.Database) {
  // Use OpenAPIHono for GET routes, plain Hono methods for POST (converted in M3)
  const r = createOpenApiSubApp();

  r.openapi(listGoalsRoute, (c) => {
    const goals = listGoals(db).map((g) => ({
      ...g,
      targetAllocation: JSON.parse(g.target_allocation),
      riskLimits: JSON.parse(g.risk_limits),
    }));
    return c.json(ok({ goals }), 200);
  });

  // POST handler — will be converted to createRoute in M3
  (r as unknown as Hono).post("/", async (c) => {
    const body = await c.req.json();

    if (!body.id || !body.name) {
      return c.json(fail("bad_request", "Missing required fields: id, name"), 400);
    }
    if (!body.targetAllocation || typeof body.targetAllocation !== "object") {
      return c.json(fail("bad_request", "Missing or invalid targetAllocation"), 400);
    }

    const errors = validateGoal({ targetAllocation: body.targetAllocation, riskLimits: body.riskLimits ?? {} });
    if (errors.length > 0) {
      return c.json(fail("validation_error", errors.join("; ")), 400);
    }

    upsertGoal(db, {
      id: body.id,
      name: body.name,
      target_allocation: JSON.stringify(body.targetAllocation),
      risk_limits: JSON.stringify(body.riskLimits),
      horizon_years: body.horizonYears ?? null,
    });
    return c.json(ok({ id: body.id }));
  });

  return r;
}
