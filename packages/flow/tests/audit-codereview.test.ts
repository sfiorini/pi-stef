import { describe, it, expect } from "vitest";
import { buildCodeReviewPrompt, MAX_DIFF_CHARS } from "../src/audit/codereview.js";

describe("codereview", () => {
  it("MAX_DIFF_CHARS is 200000", () => {
    expect(MAX_DIFF_CHARS).toBe(200_000);
  });
  it("builds a prompt with 7 finder angles", () => {
    const p = buildCodeReviewPrompt("git diff content", "/repo");
    expect(p).toContain("correctness");
    expect(p).toContain("A/B/C");
    expect(p).toContain("D/E/F");
    expect(p).toContain("G");
  });
  it("truncates oversized diffs", () => {
    const huge = "x".repeat(MAX_DIFF_CHARS + 1000);
    const p = buildCodeReviewPrompt(huge, "/repo");
    expect(p.length).toBeLessThan(huge.length);
  });
});
