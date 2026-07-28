import { describe, it, expect } from "vitest";
import { normalizeModelSpec, isWellFormedModelSpec } from "../src/config/model-spec.js";

describe("normalizeModelSpec", () => {
  it("passes well-formed provider/modelId through verbatim", () => {
    expect(normalizeModelSpec("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
    expect(normalizeModelSpec("openai/gpt-5.6-terra")).toBe("openai/gpt-5.6-terra");
  });
  it("passes bare aliases/registry ids through (>= 2 chars, no slash)", () => {
    expect(normalizeModelSpec("sonnet")).toBe("sonnet");
    expect(normalizeModelSpec("opus")).toBe("opus");
  });
  it.each([undefined, null, "", "   ", "/", "x/", "/y", "a/b/c", "anthropic/"])(
    "returns null for non-conforming input %p",
    (input) => expect(normalizeModelSpec(input)).toBeNull(),
  );
  it("NEVER fabricates a hybrid: it only echoes its own input or null", () => {
    expect(normalizeModelSpec("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
    expect(normalizeModelSpec("anthropic/claude-opus-5")).not.toContain("gpt");
  });
  it("isWellFormedModelSpec mirrors normalizeModelSpec", () => {
    expect(isWellFormedModelSpec("anthropic/opus")).toBe(true);
    expect(isWellFormedModelSpec("anthropic/")).toBe(false);
    expect(isWellFormedModelSpec(undefined)).toBe(false);
  });
});
