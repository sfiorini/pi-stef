export interface GoalInput { targetAllocation: Record<string, number>; riskLimits: Record<string, number> }

export function validateGoal(goal: GoalInput): string[] {
  const errs: string[] = [];
  const entries = Object.entries(goal.targetAllocation);
  for (const [, v] of entries) if (v < 0) errs.push("targetAllocation has a negative value (must be >= 0)");
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  // Tolerance band: ±0.01 (1 percentage point). Explicit and tested — see validate.test.ts.
  if (Math.abs(sum - 1) > 0.01) errs.push(`targetAllocation must sum to ~1.0 within ±1pp tolerance (got ${sum.toFixed(4)})`);
  return errs;
}
