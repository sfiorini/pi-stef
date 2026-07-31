import { describe, it, expect } from "vitest";
import {
  scrapedEntriesToMap,
  buildScrapedContextsContent,
} from "../scripts/scrape-docs-contexts.js";
import type { ScrapedContextEntry } from "../src/model-config.js";

describe("scrapedEntriesToMap", () => {
  it("converts entries to a map keyed by modelId", () => {
    const entries = [
      { modelId: "claude-4-sonnet", contextWindow: 200000, slug: "claude-4-sonnet" },
      { modelId: "gpt-5", maxContext: 272000, slug: "gpt-5" },
    ];
    const map = scrapedEntriesToMap(entries);
    expect(Object.keys(map)).toEqual(["claude-4-sonnet", "gpt-5"]);
    expect(map["claude-4-sonnet"]!).toEqual({ contextWindow: 200000, slug: "claude-4-sonnet" });
    expect(map["gpt-5"]!).toEqual({ maxContext: 272000, slug: "gpt-5" });
  });

  it("includes contextWindow and maxContext when both present", () => {
    const entries = [
      { modelId: "m1", contextWindow: 100000, maxContext: 200000, slug: "m1-slug" },
    ];
    const map = scrapedEntriesToMap(entries);
    expect(map["m1"]!).toEqual({ contextWindow: 100000, maxContext: 200000, slug: "m1-slug" });
  });

  it("omits undefined contextWindow and maxContext", () => {
    const entries = [{ modelId: "m2", slug: "m2-slug" }];
    const map = scrapedEntriesToMap(entries);
    expect(map["m2"]!).toEqual({ slug: "m2-slug" });
    expect(map["m2"]!).not.toHaveProperty("contextWindow");
    expect(map["m2"]!).not.toHaveProperty("maxContext");
  });

  it("returns empty object for empty input", () => {
    expect(scrapedEntriesToMap([])).toEqual({});
  });
});

describe("buildScrapedContextsContent", () => {
  it("generates a valid TypeScript module string", () => {
    const map: Record<string, ScrapedContextEntry> = {
      "model-b": { contextWindow: 100000, slug: "model-b" },
      "model-a": { maxContext: 50000, slug: "model-a" },
    };
    const content = buildScrapedContextsContent(map);

    // Should contain the import
    expect(content).toContain('import type { ScrapedContextEntry } from "./model-config.js";');

    // Should contain the export
    expect(content).toContain("export const SCRAPED_MODEL_CONTEXTS");

    // Keys should be sorted alphabetically
    const indexA = content.indexOf('"model-a"');
    const indexB = content.indexOf('"model-b"');
    expect(indexA).toBeLessThan(indexB);

    // Should contain header comment
    expect(content).toContain("AUTO-GENERATED");
    expect(content).toContain("Regenerate via");
  });

  it("generates empty map correctly", () => {
    const content = buildScrapedContextsContent({});
    expect(content).toContain("export const SCRAPED_MODEL_CONTEXTS");
    expect(content).toContain("Record<string, ScrapedContextEntry>");
    // Empty map should produce { } with closing brace on next line
    expect(content).toContain("{\n};");
  });
});
