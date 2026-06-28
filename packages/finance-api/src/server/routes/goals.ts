import { Hono } from "hono";
import type Database from "better-sqlite3";
import { upsertGoal, listGoals } from "../../store/repo";
import { validateGoal } from "../../quant/validate";
import { ok, fail } from "../errors";

export function goalsRoutes(db: Database.Database) {
  const r = new Hono();
  r.get("/", (c) => {
    const goals = listGoals(db).map((g) => ({
      ...g,
      targetAllocation: JSON.parse(g.target_allocation),
      riskLimits: JSON.parse(g.risk_limits),
    }));
    return c.json(ok({ goals }));
  });
  r.post("/", async (c) => {
    const body = await c.req.json();
    
    // Validate goal configuration
    const errors = validateGoal({ targetAllocation: body.targetAllocation ?? {}, riskLimits: body.riskLimits ?? {} });
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
