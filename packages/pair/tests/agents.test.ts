import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ensureAgentFiles } from "../src/agents";

describe("ensureAgentFiles", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "pair-agents-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("writes reviewer.md and explorer.md to ~/.pi/agent/agents when absent", async () => {
    await ensureAgentFiles(home);
    expect(existsSync(join(home, ".pi", "agent", "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "agents", "explorer.md"))).toBe(true);
  });

  it("does NOT clobber an existing user-edited reviewer.md", async () => {
    await ensureAgentFiles(home);
    const p = join(home, ".pi", "agent", "agents", "reviewer.md");
    writeFileSync(p, "USER EDITS — KEEP ME");
    await ensureAgentFiles(home);
    expect(readFileSync(p, "utf8")).toBe("USER EDITS — KEEP ME");
  });

  it("written files omit the model frontmatter field", async () => {
    await ensureAgentFiles(home);
    const reviewer = readFileSync(join(home, ".pi", "agent", "agents", "reviewer.md"), "utf8");
    expect(/^\s*model:/m.test(reviewer)).toBe(false);
  });

  it("warns when a stale project .pi/agents/reviewer.md still contains the adapter placeholder", async () => {
    // Simulate a leftover adapter-era project reviewer file in the CWD.
    const cwd = mkdtempSync(join(tmpdir(), "pair-cwd-"));
    const staleProject = join(cwd, ".pi", "agents", "reviewer.md");
    mkdirSync(dirname(staleProject), { recursive: true });
    writeFileSync(staleProject, "model: {{REVIEWER_MODEL}}\n");
    const result = await ensureAgentFiles(home, cwd);
    rmSync(cwd, { recursive: true, force: true });
    expect(result.warnings.some((w) => w.includes("{{REVIEWER_MODEL}}") && w.includes("reviewer.md"))).toBe(true);
  });

  it("emits no warning when no stale project agent file exists", async () => {
    const result = await ensureAgentFiles(home, mkdtempSync(join(tmpdir(), "pair-clean-")));
    expect(result.warnings).toEqual([]);
  });
});
