#!/usr/bin/env tsx
/**
 * Refresh the bundled fallback model list from the live Cursor API,
 * and the scraped context-window lookup from cursor.com/docs/models.
 *
 * Usage:
 *   CURSOR_API_KEY=crsr_… pnpm --filter @pi-stef/cursor refresh-models
 *   (the docs scrape requires chromium: npx playwright install chromium)
 *
 * Writes: src/model-fallback.generated.ts        (from live API)
 *         src/model-scraped-contexts.generated.ts (from docs scrape)
 * MANUAL — not run in CI.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCursorSdk } from "../src/sdk-runtime.js";
import {
  mapModelListItems,
  setScrapedContextLookup,
  KNOWN_CONTEXT_WINDOWS,
} from "../src/model-config.js";
import type { ScrapedContextEntry } from "../src/model-config.js";
import { scrapeCursorModelContexts } from "./scrape-docs-contexts.js";

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "Error: CURSOR_API_KEY is not set.\n" +
      "Usage: CURSOR_API_KEY=crsr_… pnpm --filter @pi-stef/cursor refresh-models",
  );
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FALLBACK = join(__dirname, "..", "src", "model-fallback.generated.ts");
const OUT_SCRAPED = join(__dirname, "..", "src", "model-scraped-contexts.generated.ts");

async function main(): Promise<void> {
  // ── Step 1: Scrape docs context windows (non-fatal) ──────────────────
  let scrapedEntries: Awaited<ReturnType<typeof scrapeCursorModelContexts>> = [];
  try {
    console.log("Scraping cursor.com/docs for context windows...");
    scrapedEntries = await scrapeCursorModelContexts();
    console.log(`Scraped ${scrapedEntries.length} model detail pages.`);
  } catch (err) {
    scrapedEntries = [];
    console.warn(
      "Scrape failed (non-fatal — continuing with empty scraped map):",
      err instanceof Error ? err.message : err,
    );
  }

  // ── Step 2: Build scraped map + write model-scraped-contexts.generated.ts ──
  const scrapedMap: Record<string, ScrapedContextEntry> = {};
  for (const entry of scrapedEntries) {
    scrapedMap[entry.modelId] = {
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxContext !== undefined ? { maxContext: entry.maxContext } : {}),
      slug: entry.slug,
    };
  }

  const sortedKeys = Object.keys(scrapedMap).sort();
  const scrapedFileContent = [
    "// AUTO-GENERATED scraped context-window lookup from cursor.com/docs/models-and-pricing.",
    "// Regenerate via: pnpm --filter @pi-stef/cursor refresh-models  (requires CURSOR_API_KEY + chromium)",
    "// MANUAL — not run in CI",
    "",
    'import type { ScrapedContextEntry } from "./model-config.js";',
    "",
    "export const SCRAPED_MODEL_CONTEXTS: Record<string, ScrapedContextEntry> = {",
    ...sortedKeys.map(
      (k, i) =>
        `  ${JSON.stringify(k)}: ${JSON.stringify(scrapedMap[k])}${i < sortedKeys.length - 1 ? "," : ""}`,
    ),
    "};",
    "",
  ].join("\n");
  writeFileSync(OUT_SCRAPED, scrapedFileContent, "utf8");
  console.log(`Wrote ${sortedKeys.length} scraped entries to ${OUT_SCRAPED}`);

  // ── Step 3: Inject scraped map into resolveSilentContextWindow ────────
  setScrapedContextLookup(scrapedMap);

  // ── Step 4: Fetch live models from the Cursor API ────────────────────
  const sdk = await loadCursorSdk();
  const items = await sdk.Cursor.models.list({ apiKey });

  if (items.length === 0) {
    console.error("Error: Cursor API returned an empty model list.");
    process.exit(1);
  }

  // ── Step 5: Map + drift log (informational; KNOWN always wins at runtime) ──
  const cursorModels = mapModelListItems(items);

  for (const entry of scrapedEntries) {
    const known = KNOWN_CONTEXT_WINDOWS[entry.modelId];
    if (
      known !== undefined &&
      entry.contextWindow !== undefined &&
      known !== entry.contextWindow
    ) {
      console.warn(
        `Drift: KNOWN[${entry.modelId}]=${known} vs scraped=${entry.contextWindow}`,
      );
    }
  }

  // ── Step 6: Write model-fallback.generated.ts (unchanged emission) ────
  const fileContent = [
    "// AUTO-GENERATED fallback model list. Regenerate via: pnpm --filter @pi-stef/cursor refresh-models  (requires CURSOR_API_KEY)",
    "// MANUAL — not run in CI",
    "",
    'import type { CursorModel } from "./model-config.js";',
    "",
    "export const FALLBACK_MODEL_ITEMS: CursorModel[] = [",
    ...cursorModels.map(
      (m, i) =>
        `  ${JSON.stringify(m)}${i < cursorModels.length - 1 ? "," : ""}`,
    ),
    "];",
    "",
  ].join("\n");

  writeFileSync(OUT_FALLBACK, fileContent, "utf8");
  console.log(`Wrote ${cursorModels.length} models to ${OUT_FALLBACK}`);
}

main().catch((err: unknown) => {
  console.error("Failed to refresh models:", err);
  process.exit(1);
});
