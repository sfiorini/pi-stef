import { describe, expect, it } from "vitest";
import type { ModelListItem } from "../src/model-cache";
import { contextValuesFromItem } from "../src/model-config";

describe("contextValuesFromItem", () => {
  it("multi: 300k default + 1m", () => {
    const item: ModelListItem = {
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      variants: [
        {
          params: [{ id: "context", value: "300k" }],
          displayName: "Claude Opus 5",
          isDefault: true,
        },
        {
          params: [{ id: "context", value: "1m" }],
          displayName: "Claude Opus 5",
          isDefault: false,
        },
      ],
    };
    expect(contextValuesFromItem(item)).toEqual([
      { value: "300k", isDefault: true, variantDisplayName: "Claude Opus 5" },
      { value: "1m", isDefault: false, variantDisplayName: "Claude Opus 5" },
    ]);
  });

  it("single: 200k default", () => {
    const item: ModelListItem = {
      id: "claude-sonnet-4",
      displayName: "Sonnet 4",
      variants: [
        {
          params: [{ id: "context", value: "200k" }],
          displayName: "Sonnet 4",
          isDefault: true,
        },
      ],
    };
    expect(contextValuesFromItem(item)).toEqual([
      { value: "200k", isDefault: true, variantDisplayName: "Sonnet 4" },
    ]);
  });

  it("dedupe by value — first wins", () => {
    const item: ModelListItem = {
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      variants: [
        {
          params: [{ id: "context", value: "1m" }],
          displayName: "First",
          isDefault: false,
        },
        {
          params: [{ id: "context", value: "1m" }],
          displayName: "Second",
          isDefault: true,
        },
      ],
    };
    expect(contextValuesFromItem(item)).toEqual([
      { value: "1m", isDefault: false, variantDisplayName: "First" },
    ]);
  });

  it("fallback to param definition (no variants)", () => {
    const item: ModelListItem = {
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      parameters: [
        {
          id: "context",
          values: [{ value: "272k" }, { value: "1m" }],
        },
      ],
    };
    const result = contextValuesFromItem(item);
    expect(result).toEqual([
      { value: "272k", isDefault: true },
      { value: "1m", isDefault: false },
    ]);
  });

  it("fallback when variants exist but lack context", () => {
    const item: ModelListItem = {
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      variants: [
        { params: [{ id: "fast", value: "true" }] },
      ],
      parameters: [
        {
          id: "context",
          values: [{ value: "272k" }, { value: "1m" }],
        },
      ],
    };
    const result = contextValuesFromItem(item);
    expect(result).toEqual([
      { value: "272k", isDefault: true },
      { value: "1m", isDefault: false },
    ]);
  });

  it("silent: no params/variants", () => {
    const item: ModelListItem = {
      id: "simple-model",
      displayName: "Simple",
    };
    expect(contextValuesFromItem(item)).toEqual([]);
  });

  it("malformed variants", () => {
    const item: ModelListItem = {
      id: "bad-model",
      displayName: "Bad",
      variants: [{ notParams: true }, { params: "nope" }, null],
    };
    expect(contextValuesFromItem(item)).toEqual([]);
  });

  it("empty item", () => {
    const item: ModelListItem = {
      id: "",
      displayName: "",
    };
    expect(contextValuesFromItem(item)).toEqual([]);
  });
});
