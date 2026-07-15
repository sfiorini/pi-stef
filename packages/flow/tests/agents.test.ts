import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAgentFiles } from "../src/agents.js";

const FLOW_AGENTS = [
  "reviewer.md",
  "explorer.md",
  "auditor.md",
  "planner.md",
  "developer.md",
  "synth.md",
];

describe("ensureAgentFiles", () => {
  it("writes all bundled agents when absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-agents-"));
    const root = mkdtempSync(join(tmpdir(), "flow-root-"));
    const res = await ensureAgentFiles(home, root);
    expect(res.warnings).toEqual([]);
    for (const f of FLOW_AGENTS) {
      expect(existsSync(join(home, ".pi", "agent", "agents", f))).toBe(true);
    }
  });

  it("is write-once: existing files are not clobbered", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-agents-"));
    const root = mkdtempSync(join(tmpdir(), "flow-root-"));
    const target = join(home, ".pi", "agent", "agents", "reviewer.md");
    mkdirSync(join(home, ".pi", "agent", "agents"), { recursive: true });
    writeFileSync(target, "USER-EDITED");
    await ensureAgentFiles(home, root);
    expect(readFileSync(target, "utf8")).toBe("USER-EDITED");
  });

  it("warns on stale adapter-era project reviewer with placeholder", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-agents-"));
    const root = mkdtempSync(join(tmpdir(), "flow-root-"));
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(join(root, ".pi", "agents", "reviewer.md"), "model: {{REVIEWER_MODEL}}");
    const res = await ensureAgentFiles(home, root);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toContain("stale");
  });
});
