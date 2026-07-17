import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureExampleWorkflows } from "../src/ensure-workflows.js";
import { globalWorkflowsDir } from "../src/paths.js";

const EXAMPLES = [
  "code-review.yaml",
  "ship-feature.yaml",
  "auth-audit.yaml",
  "research-report.yaml",
];

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("ensureExampleWorkflows", () => {
  it("seeds all bundled examples into the GLOBAL ~/.pi/sf/flow/workflows when absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-wf-"));
    const res = await ensureExampleWorkflows(home);
    expect(res.seeded.sort()).toEqual([...EXAMPLES].sort());
    for (const f of EXAMPLES) {
      expect(existsSync(join(globalWorkflowsDir(home), f))).toBe(true);
    }
  });

  it("is write-once: existing files are not clobbered", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-wf-"));
    const dir = globalWorkflowsDir(home);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "code-review.yaml");
    writeFileSync(target, "USER-EDITED");
    const res = await ensureExampleWorkflows(home);
    expect(readFileSync(target, "utf8")).toBe("USER-EDITED");
    expect(res.seeded).not.toContain("code-review.yaml");
  });

  it("is idempotent: re-run seeds nothing new", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-wf-"));
    await ensureExampleWorkflows(home);
    const res2 = await ensureExampleWorkflows(home);
    expect(res2.seeded).toEqual([]);
  });

  it("seeded content matches the bundled template", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-wf-"));
    await ensureExampleWorkflows(home);
    const seeded = readFileSync(join(globalWorkflowsDir(home), "ship-feature.yaml"), "utf8");
    const bundled = readFileSync(join(pkgRoot, "workflows", "ship-feature.yaml"), "utf8");
    expect(seeded).toBe(bundled);
  });

  it("re-throws non-ENOENT read errors (a directory at the target path)", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-wf-"));
    const dir = globalWorkflowsDir(home);
    mkdirSync(dir, { recursive: true });
    // A directory where a file is expected -> readFile throws EISDIR (not ENOENT),
    // which must propagate rather than be treated as "absent".
    mkdirSync(join(dir, "code-review.yaml"));
    await expect(ensureExampleWorkflows(home)).rejects.toThrow();
  });
});
