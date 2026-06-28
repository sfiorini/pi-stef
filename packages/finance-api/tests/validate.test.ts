import { describe, it, expect } from "vitest";
import { validateGoal } from "../src/quant/validate";

describe("validateGoal", () => {
  it("passes when targets sum within the ±1pp tolerance band", () => {
    expect(validateGoal({ targetAllocation: { equity: 0.7, bonds: 0.25, cash: 0.05 }, riskLimits: {} })).toEqual([]);
    // exactly 1.0 within tolerance (0.999 — within 1pp)
    expect(validateGoal({ targetAllocation: { equity: 0.999 }, riskLimits: {} })).toEqual([]);
  });
  it("fails when targets fall outside the ±1pp tolerance band", () => {
    const errs = validateGoal({ targetAllocation: { equity: 0.7, bonds: 0.5 }, riskLimits: {} }); // sum 1.2 → +20pp
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/sum/i);
    const errs2 = validateGoal({ targetAllocation: { equity: 0.7 }, riskLimits: {} }); // sum 0.7 → -30pp
    expect(errs2.some((e) => /sum/i.test(e))).toBe(true);
  });
  it("fails on negative target", () => {
    const errs = validateGoal({ targetAllocation: { equity: 1.2, bonds: -0.2 }, riskLimits: {} });
    expect(errs.join(" ")).toMatch(/negative|>= 0/i);
  });
});
