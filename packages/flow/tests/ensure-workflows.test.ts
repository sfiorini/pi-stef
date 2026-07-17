import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureExampleWorkflows } from "../src/ensure-workflows.js";

const EXAMPLES = [
  "code-review.yaml",
  "ship-feature.yaml",
  "auth-audit.yaml",
  "research-report.yaml",
];

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("ensureExampleWorkflows", () => {
  it("seeds all bundled examples into <root>/.pi/workflows when absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-wf-"));
    const res = await ensureExampleWorkflows(root);
    expect(res.seeded.sort()).toEqual([...EXAMPLES].sort());
    for (const f of EXAMPLES) {
      expect(existsSync(join(root, ".pi", "workflows", f))).toBe(true);
    }
  });

  it("is write-once: existing files are not clobbered", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-wf-"));
    const dir = join(root, ".pi", "workflows");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "code-review.yaml");
    writeFileSync(target, "USER-EDITED");
    const res = await ensureExampleWorkflows(root);
    expect(readFileSync(target, "utf8")).toBe("USER-EDITED");
    expect(res.seeded).not.toContain("code-review.yaml");
  });

  it("is idempotent: re-run seeds nothing new", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-wf-"));
    await ensureExampleWorkflows(root);
    const res2 = await ensureExampleWorkflows(root);
    expect(res2.seeded).toEqual([]);
  });

  it("seeded content matches the bundled template", async () => {
    const root = mkdtempSync(join(tmpdir(), "flow-wf-"));
    await ensureExampleWorkflows(root);
    const seeded = readFileSync(join(root, ".pi", "workflows", "ship-feature.yaml"), "utf8");
    const bundled = readFileSync(join(pkgRoot, "workflows", "ship-feature.yaml"), "utf8");
    expect(seeded).toBe(bundled);
  });
});
