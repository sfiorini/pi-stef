import { describe, it, expect } from "vitest";
import { parseVerdict, severityRank, isBlocking, renderReport } from "../src/audit/verdict.js";

describe("verdict", () => {
  it("parses APPROVED with no blocking findings", () => {
    const v = parseVerdict("## Verdict\nVERDICT: APPROVED");
    expect(v.verdict).toBe("APPROVED");
    expect(v.blockingCount).toBe(0);
  });
  it("parses findings P0-P3", () => {
    const v = parseVerdict("### P0\n- bug X\n### P3\n- nit");
    expect(v.bySeverity.P0).toHaveLength(1);
    expect(v.bySeverity.P3).toHaveLength(1);
  });
  it("severityRank orders P0<P1<P2<P3", () => {
    expect(severityRank("P0")).toBeLessThan(severityRank("P3"));
  });
  it("isBlocking: P0-P2 block, P3 doesn't", () => {
    expect(isBlocking("P0")).toBe(true);
    expect(isBlocking("P3")).toBe(false);
  });
  it("renderReport reproduces pair's format", () => {
    const out = renderReport({
      findings: [{ severity: "P1", file: "a.ts", line: 3, summary: "s", failure_scenario: "f" }],
      verdict: "REVISE",
    });
    expect(out).toContain("### P1");
    expect(out).toContain("a.ts:3");
    expect(out).toContain("VERDICT: REVISE");
  });
});
