import { describe, it, expect } from "vitest";
import { parseModelAliases, resolveModel } from "../../src/config/model-aliases";

describe("parseModelAliases", () => {
  it("parses a valid JSON object into a Map", () => {
    const raw = '{"claude-sonnet-4-6":"qwen3-max","gpt-4o":"qwen3-coder"}';
    const aliases = parseModelAliases(raw);
    expect(aliases.get("claude-sonnet-4-6")).toBe("qwen3-max");
    expect(aliases.get("gpt-4o")).toBe("qwen3-coder");
    expect(aliases.size).toBe(2);
  });

  it("returns empty map for empty string", () => {
    expect(parseModelAliases("").size).toBe(0);
  });

  it("returns empty map for unset/undefined", () => {
    expect(parseModelAliases(undefined as any).size).toBe(0);
  });

  it("returns empty map for '{}'", () => {
    expect(parseModelAliases("{}").size).toBe(0);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseModelAliases("{bad json")).toThrow();
  });

  it("throws on non-object JSON (e.g. array)", () => {
    expect(() => parseModelAliases('["not","an","object"]')).toThrow();
  });
});

describe("resolveModel", () => {
  // Use qwen3.7-max (a real current model NOT in the built-in default aliases)
  // as the base for suffix-stripping tests, so they isolate suffix behavior.
  const emptyAliases = new Map<string, string>();

  it("passthrough for unmapped id with no suffix", () => {
    const result = resolveModel("qwen3.7-max", emptyAliases);
    expect(result).toEqual({
      upstreamId: "qwen3.7-max",
      thinking: false,
      search: false,
    });
  });

  it("strips -thinking suffix", () => {
    const result = resolveModel("qwen3.7-max-thinking", emptyAliases);
    expect(result).toEqual({
      upstreamId: "qwen3.7-max",
      thinking: true,
      search: false,
    });
  });

  it("strips -search suffix", () => {
    const result = resolveModel("qwen3.7-max-search", emptyAliases);
    expect(result).toEqual({
      upstreamId: "qwen3.7-max",
      thinking: false,
      search: true,
    });
  });

  it("strips -thinking-search suffix", () => {
    const result = resolveModel("qwen3.7-max-thinking-search", emptyAliases);
    expect(result).toEqual({
      upstreamId: "qwen3.7-max",
      thinking: true,
      search: true,
    });
  });

  it("strips -search-thinking suffix (reversed order)", () => {
    const result = resolveModel("qwen3.7-max-search-thinking", emptyAliases);
    expect(result).toEqual({
      upstreamId: "qwen3.7-max",
      thinking: true,
      search: true,
    });
  });

  it("resolves alias then strips suffix", () => {
    const aliases = new Map([["claude-sonnet-4-6", "qwen3.7-max"]]);
    const result = resolveModel("claude-sonnet-4-6-thinking", aliases);
    expect(result).toEqual({
      upstreamId: "qwen3.7-max",
      thinking: true,
      search: false,
    });
  });

  it("resolves alias without suffix", () => {
    const aliases = new Map([["claude-sonnet-4-6", "qwen3.7-max"]]);
    const result = resolveModel("claude-sonnet-4-6", aliases);
    expect(result).toEqual({
      upstreamId: "qwen3.7-max",
      thinking: false,
      search: false,
    });
  });

  it("passthrough for unmapped id with suffix", () => {
    const result = resolveModel("unknown-model-thinking", emptyAliases);
    expect(result).toEqual({
      upstreamId: "unknown-model",
      thinking: true,
      search: false,
    });
  });

  // ── built-in default aliases (common short/legacy names → current ids) ──

  it("applies built-in default alias for a common name (qwen3-max → qwen3.8-max)", () => {
    const result = resolveModel("qwen3-max", emptyAliases);
    expect(result.upstreamId).toBe("qwen3.8-max");
  });

  it("applies default alias after stripping a suffix (qwen-max-thinking → qwen3.8-max + thinking)", () => {
    const result = resolveModel("qwen-max-thinking", emptyAliases);
    expect(result).toEqual({
      upstreamId: "qwen3.8-max",
      thinking: true,
      search: false,
    });
  });

  it("user aliases override the built-in defaults", () => {
    const aliases = new Map([["qwen3-max", "qwen3.9-max"]]);
    const result = resolveModel("qwen3-max", aliases);
    expect(result.upstreamId).toBe("qwen3.9-max");
  });
});
