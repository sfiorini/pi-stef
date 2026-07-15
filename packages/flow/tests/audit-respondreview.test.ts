import { describe, it, expect } from "vitest";
import { categorize, applyOrder } from "../src/audit/respondreview.js";
import type { Finding } from "../src/audit/verdict.js";

const f = (severity: Finding["severity"]): Finding => ({
  severity,
  file: "a",
  line: 1,
  summary: "s",
  failure_scenario: "f",
});

describe("respondreview", () => {
  it("categorize maps severity to must-fix/should-fix/consider", () => {
    expect(categorize(f("P0"))).toBe("must-fix");
    expect(categorize(f("P1"))).toBe("must-fix");
    expect(categorize(f("P2"))).toBe("should-fix");
    expect(categorize(f("P3"))).toBe("consider");
  });
  it("applyOrder: must-fix before should-fix before consider", () => {
    const ordered = applyOrder([f("P3"), f("P0"), f("P2"), f("P1")]);
    expect(ordered.map((x) => x.severity)).toEqual(["P0", "P1", "P2", "P3"]);
  });
});
