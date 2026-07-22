import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAgentFiles, resolveAgentType } from "../src/agents.js";

const FLOW_AGENTS = [
  "reviewer.md",
  "explorer.md",
  "auditor.md",
  "planner.md",
  "developer.md",
  "synth.md",
  "scanner.md",
  "researcher.md",
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

describe("resolveAgentType", () => {
  it("returns the named agent when a matching .md file exists", () => {
    expect(resolveAgentType("reviewer", ["reviewer.md", "explorer.md"])).toBe("reviewer");
    expect(resolveAgentType("developer", ["reviewer.md", "developer.md"])).toBe("developer");
  });

  it("falls back to built-in Plan when planner has no .md", () => {
    expect(resolveAgentType("planner", ["reviewer.md"])).toBe("Plan");
  });

  it("falls back to built-in Reviewer when reviewer has no .md", () => {
    expect(resolveAgentType("reviewer", ["developer.md"])).toBe("Reviewer");
  });

  it("does NOT fall back to Explore for a missing explorer (avoids Haiku) → general-purpose", () => {
    expect(resolveAgentType("explorer", ["reviewer.md"])).toBe("general-purpose");
  });

  it("returns general-purpose for any other undeclared name", () => {
    expect(resolveAgentType("custom", ["reviewer.md"])).toBe("general-purpose");
    expect(resolveAgentType("auditor", [])).toBe("general-purpose");
  });

  it("matches case-insensitively (lowercase .md name wins)", () => {
    expect(resolveAgentType("Reviewer", ["reviewer.md"])).toBe("reviewer");
    expect(resolveAgentType("PLANNER", ["planner.md"])).toBe("planner");
  });

  it("built-in fallback still applies case-insensitively", () => {
    expect(resolveAgentType("Planner", ["reviewer.md"])).toBe("Plan");
  });

  it("accepts bare agent keys (no .md) too — used by generate.ts", () => {
    expect(resolveAgentType("reviewer", ["reviewer", "explorer"])).toBe("reviewer");
    expect(resolveAgentType("planner", ["reviewer"])).toBe("Plan");
  });
});
