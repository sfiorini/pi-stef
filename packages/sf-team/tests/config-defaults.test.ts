import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../src/config/schema";

// Resolve the template relative to THIS file rather than process.cwd().
// vitest is invoked from the package root (via `pnpm -F .. test`) and
// from the workspace root (via `pnpm -r test`), so process.cwd() is not
// stable. The package layout is stable, so we walk up from this test
// file to the package root and back down to the template.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_PATH = path.join(PACKAGE_ROOT, "config", "defaults.json");

describe("sf-team default config template", () => {
  it("matches DEFAULT_CONFIG exactly and uses canonical JSON formatting", async () => {
    const raw = await readFile(TEMPLATE_PATH, "utf8");

    expect(raw).toBe(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    expect(JSON.parse(raw)).toEqual(DEFAULT_CONFIG);
  });
});
