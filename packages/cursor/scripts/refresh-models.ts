#!/usr/bin/env tsx
/**
 * Refresh the bundled fallback model list from the live Cursor API.
 *
 * Usage:
 *   CURSOR_API_KEY=crsr_… pnpm --filter @pi-stef/cursor refresh-models
 *
 * Writes: src/model-fallback.generated.ts
 * MANUAL — not run in CI.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCursorSdk } from "../src/sdk-runtime.js";
import { mapModelListItems } from "../src/model-config.js";

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  console.error(
    "Error: CURSOR_API_KEY is not set.\n" +
      "Usage: CURSOR_API_KEY=crsr_… pnpm --filter @pi-stef/cursor refresh-models",
  );
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "src", "model-fallback.generated.ts");

async function main(): Promise<void> {
  const sdk = await loadCursorSdk();
  const items = await sdk.Cursor.models.list({ apiKey });

  if (items.length === 0) {
    console.error("Error: Cursor API returned an empty model list.");
    process.exit(1);
  }

  const cursorModels = mapModelListItems(items);

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

  writeFileSync(OUT_PATH, fileContent, "utf8");
  console.log(
    `Wrote ${cursorModels.length} models to ${OUT_PATH}`,
  );
}

main().catch((err: unknown) => {
  console.error("Failed to refresh models:", err);
  process.exit(1);
});
