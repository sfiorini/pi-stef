import { describe, it, expect } from "vitest";
import { andGatePasses, isApproved, MAX_REVIEW_ITERATIONS } from "../src/audit/requestreview.js";

describe("requestreview", () => {
  it("MAX_REVIEW_ITERATIONS is 5", () => {
    expect(MAX_REVIEW_ITERATIONS).toBe(5);
  });
  it("andGatePasses: both must pass (score >= threshold, no must-fix)", () => {
    expect(andGatePasses({ score: 0.95, mustFix: 0 }, { score: 0.95, mustFix: 0 }, 0.94)).toBe(true);
    expect(andGatePasses({ score: 0.95, mustFix: 0 }, { score: 0.9, mustFix: 0 }, 0.94)).toBe(false);
    expect(andGatePasses({ score: 0.99, mustFix: 1 }, { score: 0.99, mustFix: 0 }, 0.94)).toBe(false);
  });
  it("isApproved forbids iteration 6", () => {
    expect(isApproved(true, 6)).toBe(false);
    expect(isApproved(true, 5)).toBe(true);
  });
});
