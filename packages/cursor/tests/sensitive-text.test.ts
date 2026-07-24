import { describe, expect, it } from "vitest";

import { redactCursorSecrets, fingerprintApiKey } from "../src/sensitive-text";

describe("redactCursorSecrets", () => {
  it("redacts crsr_ prefixed keys", () => {
    const text = "API key is crsr_abc123def456ghi789jkl012mno345";
    const result = redactCursorSecrets(text);
    expect(result).not.toContain("crsr_abc123def456ghi789jkl012mno345");
    expect(result).toContain("[redacted");
  });

  it("redacts JWT tokens (three base64 segments with dots)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456";
    const text = `Token: ${jwt}`;
    const result = redactCursorSecrets(text);
    expect(result).not.toContain(jwt);
    expect(result).toContain("[redacted");
  });

  it("redacts key= values", () => {
    const text = "config key=supersecretvalue123";
    const result = redactCursorSecrets(text);
    expect(result).not.toContain("supersecretvalue123");
    expect(result).toContain("[redacted");
  });

  it("handles empty strings", () => {
    expect(redactCursorSecrets("")).toBe("");
  });
});

describe("fingerprintApiKey", () => {
  it("returns a 16-character hex string", () => {
    const fp = fingerprintApiKey("crsr_test_key_123");
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same key", () => {
    const key = "crsr_deterministic_test";
    expect(fingerprintApiKey(key)).toBe(fingerprintApiKey(key));
  });

  it("produces different fingerprints for different keys", () => {
    const fp1 = fingerprintApiKey("crsr_key_a");
    const fp2 = fingerprintApiKey("crsr_key_b");
    expect(fp1).not.toBe(fp2);
  });
});
