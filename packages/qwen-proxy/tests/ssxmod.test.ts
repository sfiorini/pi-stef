import { describe, it, expect } from "vitest";
import { generateCookies } from "../src/upstream/ssxmod";
import { generateFingerprint } from "../src/upstream/fingerprint";

describe("generateFingerprint", () => {
  it("returns a string with 37 caret-delimited fields", () => {
    const fp = generateFingerprint();
    const fields = fp.split("^");
    expect(fields).toHaveLength(37);
  });

  it("returns a different fingerprint on each call (random deviceId + hashes)", () => {
    const fp1 = generateFingerprint();
    const fp2 = generateFingerprint();
    // They should differ because deviceId and hashes are randomized
    expect(fp1).not.toBe(fp2);
  });

  it("field 33 is a numeric timestamp (current-ish)", () => {
    const before = Date.now();
    const fp = generateFingerprint();
    const after = Date.now();
    const fields = fp.split("^");
    const ts = Number(fields[33]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("generateCookies", () => {
  it("returns two non-empty strings", () => {
    const pair = generateCookies();
    expect(pair.ssxmod_itna).toBeTruthy();
    expect(pair.ssxmod_itna2).toBeTruthy();
  });

  it("returns values prefixed with '1-'", () => {
    const pair = generateCookies();
    expect(pair.ssxmod_itna.startsWith("1-")).toBe(true);
    expect(pair.ssxmod_itna2.startsWith("1-")).toBe(true);
  });

  it("returns values that are base64/url-safe (no spaces or newlines)", () => {
    const pair = generateCookies();
    expect(pair.ssxmod_itna).not.toMatch(/[\s]/);
    expect(pair.ssxmod_itna2).not.toMatch(/[\s]/);
  });

  it("two calls yield different (re-randomized) pairs", () => {
    const pair1 = generateCookies();
    const pair2 = generateCookies();
    // Very unlikely to be equal given random fingerprints
    expect(pair1.ssxmod_itna).not.toBe(pair2.ssxmod_itna);
    expect(pair1.ssxmod_itna2).not.toBe(pair2.ssxmod_itna2);
  });

  it("accepts a pre-built fingerprint string", () => {
    // Even with a fixed fingerprint, hash fields are re-randomized each call
    // (this is by design — processFields randomizes HASH_FIELDS 16/17/18/31/34/36)
    const fp = generateFingerprint();
    const pair = generateCookies(fp);
    expect(pair.ssxmod_itna.startsWith("1-")).toBe(true);
    expect(pair.ssxmod_itna2.startsWith("1-")).toBe(true);
    expect(pair.ssxmod_itna.length).toBeGreaterThan(10);
  });
});
