import { describe, it, expect } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  type PairConfig,
  type ResolvedPairConfig,
} from "../../src/config/schema";

describe("ConfigSchema", () => {
  it("accepts empty object", () => {
    expect(Value.Check(ConfigSchema, {})).toBe(true);
  });

  it("accepts valid reviewer config", () => {
    const config = { reviewer: { model: "anthropic/sonnet-4-6" } };
    expect(Value.Check(ConfigSchema, config)).toBe(true);
  });

  it("accepts valid explorer config", () => {
    const config = { explorer: { model: "anthropic/sonnet-4-6" } };
    expect(Value.Check(ConfigSchema, config)).toBe(true);
  });

  it("accepts both reviewer and explorer config", () => {
    const config = {
      reviewer: { model: "anthropic/sonnet-4-6" },
      explorer: { model: "anthropic/haiku-4-5" },
    };
    expect(Value.Check(ConfigSchema, config)).toBe(true);
  });

  it("accepts reviewer with no model", () => {
    const config = { reviewer: {} };
    expect(Value.Check(ConfigSchema, config)).toBe(true);
  });

  it("accepts explorer with no model", () => {
    const config = { explorer: {} };
    expect(Value.Check(ConfigSchema, config)).toBe(true);
  });

  it("rejects empty model string", () => {
    const config = { reviewer: { model: "" } };
    expect(Value.Check(ConfigSchema, config)).toBe(false);
  });

  it("rejects empty explorer model string", () => {
    const config = { explorer: { model: "" } };
    expect(Value.Check(ConfigSchema, config)).toBe(false);
  });

  it("rejects additional top-level properties", () => {
    const config = { reviewer: {}, extra: true };
    expect(Value.Check(ConfigSchema, config)).toBe(false);
  });

  it("rejects additional reviewer properties", () => {
    const config = { reviewer: { model: "test", extra: true } };
    expect(Value.Check(ConfigSchema, config)).toBe(false);
  });

  it("rejects additional explorer properties", () => {
    const config = { explorer: { model: "test", extra: true } };
    expect(Value.Check(ConfigSchema, config)).toBe(false);
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has null reviewer model", () => {
    expect(DEFAULT_CONFIG.reviewer.model).toBeNull();
  });

  it("has null explorer model", () => {
    expect(DEFAULT_CONFIG.explorer.model).toBeNull();
  });
});
