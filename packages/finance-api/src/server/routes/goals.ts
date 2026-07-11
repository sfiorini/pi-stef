import { createRoute, z } from "@hono/zod-openapi";
import type Database from "better-sqlite3";
import { upsertGoal, listGoals } from "../../store/repo";
import { validateGoal } from "../../quant/validate";
import { createOpenApiSubApp } from "../openapi-helpers";
import { goalsListResponse, upsertGoalResponse, errorResponse } from "../openapi-schemas";
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

const upsertGoalRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Goals"],
  summary: "Create or update a goal",
  security: [{ BearerAuth: [] }],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            targetAllocation: z.record(z.string(), z.number()),
            riskLimits: z.record(z.string(), z.number()).optional(),
            horizonYears: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: upsertGoalResponse } },
      description: "Goal upserted",
    },
    400: {
      content: { "application/json": { schema: errorResponse } },
      description: "Validation error",
    },
    401: {
      content: { "application/json": { schema: errorResponse } },
      description: "Unauthorized",
    },
  },
});

export function goalsRoutes(db: Database.Database) {
  const r = createOpenApiSubApp();

  r.openapi(listGoalsRoute, (c) => {
    const goals = listGoals(db).map((g) => ({
      ...g,
      targetAllocation: JSON.parse(g.target_allocation),
      riskLimits: JSON.parse(g.risk_limits),
    }));
    return c.json(ok({ goals }), 200);
  });

  r.openapi(upsertGoalRoute, async (c) => {
    const body = c.req.valid("json");

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
    return c.json(ok({ id: body.id }), 200);
  });

  return r;
}
