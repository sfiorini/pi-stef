import { describe, it, expect } from "vitest";
import {
  assignFindingIds,
  renderCanonicalList,
  parseVerification,
  evolveCanonical,
  verificationApproved,
} from "../src/audit/verification.js";
import type { Finding } from "../src/audit/verdict.js";

function f(severity: Finding["severity"], file: string, line: number, summary = "s", failure_scenario = "sc"): Finding {
  return { severity, file, line, summary, failure_scenario };
}

describe("assignFindingIds", () => {
  it("assigns F1..Fn sorted by severity, then file, then line", () => {
    const out = assignFindingIds([f("P3", "a.ts", 5), f("P0", "b.ts", 1), f("P0", "a.ts", 10)]);
    expect(out.map((x) => `${x.id}:${x.severity}:${x.file}:${x.line}`)).toEqual([
      "F1:P0:a.ts:10",
      "F2:P0:b.ts:1",
      "F3:P3:a.ts:5",
    ]);
  });
  it("is deterministic for identical input", () => {
    const input = [f("P1", "z.ts", 2), f("P1", "a.ts", 9)];
    expect(assignFindingIds(input)).toEqual(assignFindingIds(input));
  });
  it("breaks ties on file then line ascending", () => {
    const out = assignFindingIds([f("P2", "m.ts", 30), f("P2", "m.ts", 3), f("P2", "a.ts", 99)]);
    expect(out.map((x) => `${x.file}:${x.line}`)).toEqual(["a.ts:99", "m.ts:3", "m.ts:30"]);
    expect(out.map((x) => x.id)).toEqual(["F1", "F2", "F3"]);
  });
  it("does not mutate the input array elements", () => {
    const input = [f("P0", "a.ts", 1)];
    assignFindingIds(input);
    expect("id" in input[0]).toBe(false);
  });
});

describe("renderCanonicalList", () => {
  it("renders header + [Fn] bullets, groups by severity, skips empty groups", () => {
    const out = renderCanonicalList([
      { ...f("P0", "a.ts", 4, "boom", "scen"), id: "F1" },
      { ...f("P3", "b.ts", 9, "nit", "scen3"), id: "F2" },
    ]);
    expect(out).toContain("## Canonical Findings (prior round)");
    expect(out).toContain("- [F1] a.ts:4 — boom (scenario: scen)");
    expect(out).toContain("- [F2] b.ts:9 — nit (scenario: scen3)");
    expect(out).toMatch(/### P0\b/);
    expect(out).not.toMatch(/### P1\b/);
    expect(out).not.toMatch(/### P2\b/);
    expect(out).toMatch(/### P3\b/);
  });
  it("orders P0 before P3", () => {
    const out = renderCanonicalList([{ ...f("P3", "b.ts", 1), id: "F2" }, { ...f("P0", "a.ts", 1), id: "F1" }]);
    expect(out.indexOf("### P0")).toBeLessThan(out.indexOf("### P3"));
  });
});

describe("parseVerification", () => {
  it("returns [] when there is no ## Verification section", () => {
    expect(parseVerification("## Findings\n### P0\n- x\n## Verdict\nVERDICT: APPROVED")).toEqual([]);
  });
  it("classifies each prior finding and extracts ref + evidence", () => {
    const text = [
      "## Summary", "verified.",
      "## Verification",
      "### FIXED", "- [F1] — Evidence: a.ts:4 fixed the null check",
      "### PARTIALLY-FIXED", "- [F2] — Evidence: b.ts:9 partial",
      "### NOT-FIXED", "- [F3] — Evidence: c.ts unchanged",
      "### NEW-ISSUE-INTRODUCED", "- [F4] — Evidence: F1 fix added a leak at d.ts:7",
      "## Findings", "### P1", "- d.ts:7 — new leak",
      "## Verdict", "VERDICT: REVISE",
    ].join("\n");
    expect(parseVerification(text)).toEqual([
      { ref: "F1", status: "FIXED", evidence: "a.ts:4 fixed the null check" },
      { ref: "F2", status: "PARTIALLY-FIXED", evidence: "b.ts:9 partial" },
      { ref: "F3", status: "NOT-FIXED", evidence: "c.ts unchanged" },
      { ref: "F4", status: "NEW-ISSUE-INTRODUCED", evidence: "F1 fix added a leak at d.ts:7" },
    ]);
  });
  it("ignores ### P0..P3 and VERDICT (does not bleed into ## Findings)", () => {
    const text = [
      "## Verification", "### FIXED", "- [F1] — Evidence: ok",
      "## Findings", "### P0", "- [F9] — should NOT be collected",
      "## Verdict", "VERDICT: APPROVED",
    ].join("\n");
    expect(parseVerification(text)).toEqual([{ ref: "F1", status: "FIXED", evidence: "ok" }]);
  });
  it("ignores `## `/`### `/`- ` lines inside a fenced code block", () => {
    const text = [
      "## Verification",
      "### FIXED",
      "- [F1] — Evidence: ok",
      "```",
      "## NotASectionBoundary",
      "### AlsoNot",
      "- [F9] — must NOT be collected",
      "```",
      "### NOT-FIXED",
      "- [F2] — Evidence: still parsed after the fence",
      "## Findings",
      "### P0",
      "- x",
      "## Verdict",
      "VERDICT: REVISE",
    ].join("\n");
    expect(parseVerification(text)).toEqual([
      { ref: "F1", status: "FIXED", evidence: "ok" },
      { ref: "F2", status: "NOT-FIXED", evidence: "still parsed after the fence" },
    ]);
  });
});

describe("evolveCanonical", () => {
  const prior = [
    { ...f("P0", "a.ts", 1, "fixed"), id: "F1" },
    { ...f("P1", "b.ts", 2, "partial"), id: "F2" },
    { ...f("P2", "c.ts", 3, "notfixed"), id: "F3" },
    { ...f("P3", "d.ts", 4, "noop"), id: "F4" },
  ];
  it("drops FIXED; keeps PARTIALLY-FIXED, NOT-FIXED, and no-entry", () => {
    const out = evolveCanonical(prior, [
      { ref: "F1", status: "FIXED", evidence: "ok" },
      { ref: "F2", status: "PARTIALLY-FIXED", evidence: "partial" },
      { ref: "F3", status: "NOT-FIXED", evidence: "none" },
    ], []);
    expect(out.map((x) => x.summary)).toEqual(["partial", "notfixed", "noop"]);
    expect(out.every((x) => !("id" in x))).toBe(true);
  });
  it("drops the original on NEW-ISSUE-INTRODUCED and appends the regression from newFindings", () => {
    const out = evolveCanonical(
      [{ ...f("P0", "a.ts", 1, "orig"), id: "F1" }],
      [{ ref: "F1", status: "NEW-ISSUE-INTRODUCED", evidence: "F1 caused leak" }],
      [f("P1", "a.ts", 50, "regression")],
    );
    expect(out.map((x) => x.summary)).toEqual(["regression"]);
    expect(out[0].line).toBe(50);
  });
});

describe("verificationApproved", () => {
  const blocking = [{ ...f("P1", "a.ts", 1, "blk"), id: "F1" }];
  it("true when all prior blocking FIXED and no new blocking regression", () => {
    expect(verificationApproved(blocking, [{ ref: "F1", status: "FIXED", evidence: "ok" }], [])).toBe(true);
  });
  it("true for NEW-ISSUE with only a P3 regression (P3 never blocks)", () => {
    expect(verificationApproved(blocking, [{ ref: "F1", status: "NEW-ISSUE-INTRODUCED", evidence: "x" }], [f("P3", "a.ts", 2, "nit")])).toBe(true);
  });
  it("false when a prior blocking finding is PARTIALLY-FIXED", () => {
    expect(verificationApproved(blocking, [{ ref: "F1", status: "PARTIALLY-FIXED", evidence: "x" }], [])).toBe(false);
  });
  it("false when a prior blocking finding is NOT-FIXED", () => {
    expect(verificationApproved(blocking, [{ ref: "F1", status: "NOT-FIXED", evidence: "x" }], [])).toBe(false);
  });
  it("false for NEW-ISSUE with a blocking regression", () => {
    expect(verificationApproved(blocking, [{ ref: "F1", status: "NEW-ISSUE-INTRODUCED", evidence: "x" }], [f("P0", "a.ts", 9, "regression")])).toBe(false);
  });
  it("false when all prior FIXED but a new blocking regression appears", () => {
    expect(verificationApproved(blocking, [{ ref: "F1", status: "FIXED", evidence: "ok" }], [f("P2", "a.ts", 9, "regression")])).toBe(false);
  });
  it("true when every prior finding is P3 (P3 never blocks)", () => {
    expect(verificationApproved([{ ...f("P3", "a.ts", 1, "nit"), id: "F1" }], [{ ref: "F1", status: "NOT-FIXED", evidence: "x" }], [])).toBe(true);
  });
  it("false when a prior blocking finding has no entry (conservative)", () => {
    expect(verificationApproved(blocking, [], [])).toBe(false);
  });
});
