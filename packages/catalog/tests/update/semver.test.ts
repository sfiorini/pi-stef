import { describe, expect, it } from "vitest";
import { compareVersions, isNewer } from "../../src/update/semver.js";

describe("compareVersions", () => {
  // --- basic comparisons ---
  it("returns 0 for identical versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns 1 when major is greater", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
  });

  it("returns -1 when major is lesser", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });

  it("returns 1 when minor is greater", () => {
    expect(compareVersions("1.3.0", "1.2.0")).toBe(1);
  });

  it("returns 1 when patch is greater", () => {
    expect(compareVersions("1.2.4", "1.2.3")).toBe(1);
  });

  // --- pre-release handling ---
  it("treats pre-release as equal to its release (1.0.0-beta == 1.0.0)", () => {
    // Pre-release tag is stripped; documented simplification
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(0);
  });

  it("compares pre-release versions by numeric parts only", () => {
    expect(compareVersions("2.0.0-alpha", "1.9.9")).toBe(1);
  });

  // --- edge cases ---
  it("treats missing patch as 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  it("treats missing minor and patch as 0", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
  });

  it("handles 0.0.0 correctly", () => {
    expect(compareVersions("0.0.0", "0.0.0")).toBe(0);
    expect(compareVersions("0.0.1", "0.0.0")).toBe(1);
  });
});

describe("isNewer", () => {
  it("returns true when latest > current", () => {
    expect(isNewer("2.0.0", "1.0.0")).toBe(true);
  });

  it("returns false when latest === current", () => {
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  });

  it("returns false when latest < current", () => {
    expect(isNewer("1.0.0", "2.0.0")).toBe(false);
  });
});
