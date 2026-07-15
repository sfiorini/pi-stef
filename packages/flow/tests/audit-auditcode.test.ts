import { describe, it, expect } from "vitest";
import { CHECKLIST_SECTIONS, gateExitCode, qualityScore } from "../src/audit/auditcode.js";

describe("auditcode", () => {
  it("has the 10 checklist sections", () => {
    expect(CHECKLIST_SECTIONS.length).toBe(10);
    expect(CHECKLIST_SECTIONS).toContain("Supply Chain & Security");
    expect(CHECKLIST_SECTIONS).toContain("Agent Readability");
  });
  it("gateExitCode: 0 only when no failures", () => {
    expect(gateExitCode({ passed: 10, failed: 0 })).toBe(0);
    expect(gateExitCode({ passed: 9, failed: 1 })).toBe(1);
  });
  it("qualityScore = 100*(total-must-should)/total", () => {
    expect(qualityScore({ total: 10, mustFix: 1, shouldFix: 1 })).toBe(80);
  });
});
