import { describe, expect, it } from "vitest";
import type { ModelListItem } from "../src/model-cache";
import {
  contextValuesFromItem,
  resolveSilentContextWindow,
  normalizeContextWindow,
  parseModelId,
  mapModelListItems,
  processModels,
} from "../src/model-config";
import type { CursorModel } from "../src/model-config";

// ═══════════════════════════════════════════════════════════════════
// S-M2-1: contextValuesFromItem
// ═══════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════
// S-M2-2: resolveSilentContextWindow + normalizeContextWindow
// ═══════════════════════════════════════════════════════════════════

describe("resolveSilentContextWindow", () => {
  it("known: gpt-5.4 → 272000", () => {
    expect(resolveSilentContextWindow("gpt-5.4")).toBe(272_000);
  });

  it("known: gpt-5.6-sol → 272000", () => {
    expect(resolveSilentContextWindow("gpt-5.6-sol")).toBe(272_000);
  });

  it("known: claude-opus-5 → 300000", () => {
    expect(resolveSilentContextWindow("claude-opus-5")).toBe(300_000);
  });

  it("known: claude-sonnet-5 → 300000", () => {
    expect(resolveSilentContextWindow("claude-sonnet-5")).toBe(300_000);
  });

  it("unknown default: gemini-3-flash → 200000", () => {
    expect(resolveSilentContextWindow("gemini-3-flash")).toBe(200_000);
  });

  it("unknown default: grok-4.5 → 200000", () => {
    expect(resolveSilentContextWindow("grok-4.5")).toBe(200_000);
  });

  it("unknown default: auto-smart → 200000", () => {
    expect(resolveSilentContextWindow("auto-smart")).toBe(200_000);
  });

  it("effort-suffix-stripped: gpt-5.4-high → 272000", () => {
    expect(resolveSilentContextWindow("gpt-5.4-high")).toBe(272_000);
  });

  it("effort-suffix-stripped: claude-opus-5-medium → 300000", () => {
    expect(resolveSilentContextWindow("claude-opus-5-medium")).toBe(300_000);
  });
});

describe("normalizeContextWindow", () => {
  it("-1m → 1M", () => {
    const model: CursorModel = {
      id: "claude-4-sonnet-1m",
      name: "Sonnet 4 1M",
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 16_384,
    };
    expect(normalizeContextWindow(model).contextWindow).toBe(1_000_000);
  });

  it("-1m + effort → 1M", () => {
    const model: CursorModel = {
      id: "gpt-5.4-1m-high",
      name: "GPT-5.4 1M High",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 16_384,
    };
    expect(normalizeContextWindow(model).contextWindow).toBe(1_000_000);
  });

  it("curated: gpt-5.4-medium → 272000", () => {
    const model: CursorModel = {
      id: "gpt-5.4-medium",
      name: "GPT-5.4 Medium",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 16_384,
    };
    expect(normalizeContextWindow(model).contextWindow).toBe(272_000);
  });

  it("keep existing: gemini-3-flash → 200000", () => {
    const model: CursorModel = {
      id: "gemini-3-flash",
      name: "Gemini 3 Flash",
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 16_384,
    };
    expect(normalizeContextWindow(model).contextWindow).toBe(200_000);
  });

  it("same ref when unchanged", () => {
    const model: CursorModel = {
      id: "gemini-3-flash",
      name: "Gemini 3 Flash",
      reasoning: false,
      contextWindow: 200_000,
      maxTokens: 16_384,
    };
    expect(normalizeContextWindow(model)).toBe(model);
  });
});

// ═══════════════════════════════════════════════════════════════════
// S-M2-3: mapModelListItems context expansion
// ═══════════════════════════════════════════════════════════════════

describe("mapModelListItems — context expansion", () => {
  it("multi {300k default, 1m} → 2 expanded models", () => {
    const item: ModelListItem = {
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      variants: [
        { params: [{ id: "context", value: "300k" }], displayName: "Claude Opus 5", isDefault: true },
        { params: [{ id: "context", value: "1m" }], displayName: "Claude Opus 5", isDefault: false },
      ],
    };
    const result = mapModelListItems([item]);
    expect(result).toHaveLength(2);

    // 300k is default context → no suffix, no parameters
    expect(result[0]).toMatchObject({
      id: "claude-opus-5",
      contextWindow: 300_000,
    });

    // 1m → expanded with suffix and parameters
    expect(result[1]).toMatchObject({
      id: "claude-opus-5-1m",
      contextWindow: 1_000_000,
      requestedModelId: "claude-opus-5",
      parameters: [{ id: "context", value: "1m" }],
      name: "Claude Opus 5 1M",
    });
  });

  it("multi {272k default, 1m} → gpt-5.4 + gpt-5.4-1m", () => {
    const item: ModelListItem = {
      id: "gpt-5.4",
      displayName: "GPT-5.4",
      variants: [
        { params: [{ id: "context", value: "272k" }], displayName: "GPT-5.4", isDefault: true },
        { params: [{ id: "context", value: "1m" }], displayName: "GPT-5.4", isDefault: false },
      ],
    };
    const result = mapModelListItems([item]);
    expect(result).toHaveLength(2);

    expect(result[0]).toMatchObject({
      id: "gpt-5.4",
      contextWindow: 272_000,
    });

    expect(result[1]).toMatchObject({
      id: "gpt-5.4-1m",
      contextWindow: 1_000_000,
      requestedModelId: "gpt-5.4",
      parameters: [{ id: "context", value: "1m" }],
    });
  });

  it("single {200k} → 1 model with parameters", () => {
    const item: ModelListItem = {
      id: "claude-sonnet-4",
      displayName: "Sonnet 4",
      variants: [
        { params: [{ id: "context", value: "200k" }], displayName: "Sonnet 4", isDefault: true },
      ],
    };
    const result = mapModelListItems([item]);
    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({
      id: "claude-sonnet-4",
      contextWindow: 200_000,
      requestedModelId: "claude-sonnet-4",
      parameters: [{ id: "context", value: "200k" }],
    });
  });

  it("silent curated → resolveSilentContextWindow, no parameters", () => {
    const item: ModelListItem = {
      id: "gpt-5.4",
      displayName: "GPT-5.4",
    };
    const result = mapModelListItems([item]);
    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({
      id: "gpt-5.4",
      contextWindow: 272_000,
    });
    expect((result[0]!).parameters).toBeUndefined();
    expect((result[0]!).requestedModelId).toBeUndefined();
  });

  it("silent unknown → 200000 fallback", () => {
    const item: ModelListItem = {
      id: "gemini-3-flash",
      displayName: "Gemini 3 Flash",
    };
    const result = mapModelListItems([item]);
    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({
      id: "gemini-3-flash",
      contextWindow: 200_000,
    });
  });

  it("heuristics: reasoning + supportsImages", () => {
    const gptItem: ModelListItem = { id: "gpt-5.4", displayName: "GPT-5.4" };
    const embedItem: ModelListItem = { id: "text-embedding-3", displayName: "Embed" };

    const gptResult = mapModelListItems([gptItem]);
    expect(gptResult[0]!.reasoning).toBe(true);
    expect(gptResult[0]!.supportsImages).toBe(true);
    expect(gptResult[0]!.maxTokens).toBe(16_384);

    const embedResult = mapModelListItems([embedItem]);
    expect(embedResult[0]!.reasoning).toBe(false);
    expect(embedResult[0]!.supportsImages).toBe(false);
    expect(embedResult[0]!.maxTokens).toBe(16_384);
  });

  it("deterministic: reversed variant order → identical ids and windows", () => {
    const forward: ModelListItem = {
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      variants: [
        { params: [{ id: "context", value: "300k" }], displayName: "Claude Opus 5", isDefault: true },
        { params: [{ id: "context", value: "1m" }], displayName: "Claude Opus 5", isDefault: false },
      ],
    };
    const reversed: ModelListItem = {
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      variants: [
        { params: [{ id: "context", value: "1m" }], displayName: "Claude Opus 5", isDefault: false },
        { params: [{ id: "context", value: "300k" }], displayName: "Claude Opus 5", isDefault: true },
      ],
    };
    const fwd = mapModelListItems([forward]);
    const rev = mapModelListItems([reversed]);
    expect(fwd.map((m) => m.id)).toEqual(rev.map((m) => m.id));
    expect(fwd.map((m) => m.contextWindow)).toEqual(rev.map((m) => m.contextWindow));
  });

  it("empty [] → []", () => {
    expect(mapModelListItems([])).toEqual([]);
  });

  it("malformed variants → silent fallback", () => {
    const item: ModelListItem = {
      id: "bad-model",
      displayName: "Bad",
      variants: [{ bad: true }],
    };
    const result = mapModelListItems([item]);
    expect(result).toHaveLength(1);
    expect(result[0]!).toMatchObject({
      id: "bad-model",
      contextWindow: 200_000,
    });
    expect((result[0]!).parameters).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// S-M2-3: parseModelId round-trip on expanded ids
// ═══════════════════════════════════════════════════════════════════

describe("parseModelId round-trip on expanded ids", () => {
  it("claude-opus-5-1m → base includes -1m", () => {
    expect(parseModelId("claude-opus-5-1m")).toEqual({
      base: "claude-opus-5-1m",
      effort: "",
      fast: false,
      thinking: false,
    });
  });

  it("gpt-5.4-1m-high → base includes -1m, effort high", () => {
    expect(parseModelId("gpt-5.4-1m-high")).toEqual({
      base: "gpt-5.4-1m",
      effort: "high",
      fast: false,
      thinking: false,
    });
  });

  it("gpt-5.4-1m-medium-fast → base includes -1m, effort medium, fast", () => {
    expect(parseModelId("gpt-5.4-1m-medium-fast")).toEqual({
      base: "gpt-5.4-1m",
      effort: "medium",
      fast: true,
      thinking: false,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// S-M2-3: processModels no-collision
// ═══════════════════════════════════════════════════════════════════

describe("processModels no-collision", () => {
  it("dedupes effort variants correctly", () => {
    const raw: CursorModel[] = [
      { id: "gpt-5.4-high", name: "GPT-5.4 High", reasoning: true, contextWindow: 272_000, maxTokens: 16_384, requestedModelId: "gpt-5.4", parameters: [{ id: "context", value: "272k" }] },
      { id: "gpt-5.4-medium", name: "GPT-5.4 Medium", reasoning: true, contextWindow: 272_000, maxTokens: 16_384, requestedModelId: "gpt-5.4", parameters: [{ id: "context", value: "272k" }] },
      { id: "gpt-5.4-low", name: "GPT-5.4 Low", reasoning: true, contextWindow: 272_000, maxTokens: 16_384, requestedModelId: "gpt-5.4", parameters: [{ id: "context", value: "272k" }] },
      { id: "gpt-5.4-1m-high", name: "GPT-5.4 1M High", reasoning: true, contextWindow: 1_000_000, maxTokens: 16_384, requestedModelId: "gpt-5.4", parameters: [{ id: "context", value: "1m" }] },
      { id: "gpt-5.4-1m-medium", name: "GPT-5.4 1M Medium", reasoning: true, contextWindow: 1_000_000, maxTokens: 16_384, requestedModelId: "gpt-5.4", parameters: [{ id: "context", value: "1m" }] },
    ];
    const result = processModels(raw);
    expect(result).toHaveLength(2);

    // sorted by id: gpt-5.4, gpt-5.4-1m
    expect(result[0]!).toMatchObject({ id: "gpt-5.4", supportsEffort: true, contextWindow: 272_000 });
    expect(result[1]!).toMatchObject({ id: "gpt-5.4-1m", supportsEffort: true, contextWindow: 1_000_000 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// S-M2-4: FALLBACK_MODELS normalization
// ═══════════════════════════════════════════════════════════════════

import { FALLBACK_MODELS } from "../src/model-config";

describe("FALLBACK_MODELS normalization", () => {
  it("models with -1m base suffix have contextWindow 1000000", () => {
    const oneMillion = FALLBACK_MODELS.filter((m) => {
      const base = parseModelId(m.id).base;
      return base.endsWith("-1m");
    });
    expect(oneMillion.length).toBeGreaterThan(0);
    for (const m of oneMillion) {
      expect(m.contextWindow).toBe(1_000_000);
    }
  });

  it("models with base gpt-5.4 have contextWindow 272000", () => {
    const gpt54 = FALLBACK_MODELS.filter((m) => parseModelId(m.id).base === "gpt-5.4");
    expect(gpt54.length).toBeGreaterThan(0);
    for (const m of gpt54) {
      expect(m.contextWindow).toBe(272_000);
    }
  });
});
