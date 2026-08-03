import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ensureAgentFiles, resolveAgentType } from "../src/agents.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const FLOW_AGENTS = [
  "reviewer.md",
  "designer.md",
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
    expect(resolveAgentType("reviewer", ["reviewer.md", "researcher.md"])).toBe("reviewer");
    expect(resolveAgentType("developer", ["reviewer.md", "developer.md"])).toBe("developer");
  });

  it("falls back to built-in Plan when planner has no .md", () => {
    expect(resolveAgentType("planner", ["reviewer.md"])).toBe("Plan");
  });

  it("falls back to built-in Reviewer when reviewer has no .md", () => {
    expect(resolveAgentType("reviewer", ["developer.md"])).toBe("Reviewer");
  });

  it("does NOT fall back to Explore for a missing researcher (avoids Haiku) → general-purpose", () => {
    expect(resolveAgentType("researcher", ["reviewer.md"])).toBe("general-purpose");
  });

  it("returns general-purpose for any other undeclared name", () => {
    expect(resolveAgentType("custom", ["reviewer.md"])).toBe("general-purpose");
    expect(resolveAgentType("auditor", [])).toBe("general-purpose");
  });

  it("matches case-insensitively (lowercase .md name wins)", () => {
    expect(resolveAgentType("Reviewer", ["reviewer.md"])).toBe("reviewer");
    expect(resolveAgentType("PLANNER", ["reviewer.md", "planner.md"])).toBe("planner");
  });

  it("built-in fallback still applies case-insensitively", () => {
    expect(resolveAgentType("Planner", ["reviewer.md"])).toBe("Plan");
  });

  it("accepts bare agent keys (no .md) too — used by generate.ts", () => {
    expect(resolveAgentType("reviewer", ["reviewer", "researcher"])).toBe("reviewer");
    expect(resolveAgentType("planner", ["reviewer"])).toBe("Plan");
  });
});

describe("notifier agent definition", () => {
  let content: string;
  beforeAll(() => {
    content = readFileSync(join(pkgRoot, "agents", "notifier.md"), "utf8");
  });

  it("frontmatter: tools, thinking, max_turns, isolated, description", () => {
    expect(content).toMatch(/tools:\s*bash/);
    expect(content).toMatch(/thinking:\s*low/);
    expect(content).toMatch(/max_turns:\s*10/);
    expect(content).toMatch(/isolated:\s*true/);
    expect(content).toMatch(/description:/);
  });

  it("documents both env vars: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID", () => {
    expect(content).toContain("TELEGRAM_BOT_TOKEN");
    expect(content).toContain("TELEGRAM_CHAT_ID");
  });

  it("defines all 3 statuses: sent, skipped, failed", () => {
    expect(content).toContain('"sent"');
    expect(content).toContain('"skipped"');
    expect(content).toContain('"failed"');
  });

  it("invokes notify-telegram.sh bare-name with --message-file (no absolute path)", () => {
    expect(content).toMatch(/notify-telegram\.sh --message-file/);
    expect(content).not.toMatch(/\/notify-telegram\.sh/);
  });

  it("non-load-bearing rule: NEVER block, retry, or loop", () => {
    expect(content).toMatch(/NEVER block, retry, or loop/i);
  });

  it("documents the PATH-prepend for notify-telegram.sh resolution", () => {
    expect(content).toContain("$HOME/.pi/agent/npm/node_modules/.bin");
    expect(content).toMatch(/export\s+PATH=.*\.bin/);
  });

  it("output contract: status + detail", () => {
    expect(content).toContain("status");
    expect(content).toContain("detail");
  });
});

describe("researcher agent definition", () => {
  it("declares extensions:[web,atlassian], isolated:false, skills:false, and ext: selectors", () => {
    const content = readFileSync(join(pkgRoot, "agents", "researcher.md"), "utf8");
    expect(content).toMatch(/extensions:\s*\[.*web.*atlassian.*\]/);
    expect(content).toMatch(/isolated:\s*false/);
    expect(content).toMatch(/skills:\s*false/);
    expect(content).toContain("ext:web/");
    expect(content).toContain("ext:atlassian/");
  });
  it("documents private/authenticated source access", () => {
    const content = readFileSync(join(pkgRoot, "agents", "researcher.md"), "utf8");
    expect(content).toContain("gh pr view");
    expect(content).toContain("confluence_page");
    expect(content).toContain("ATLASSIAN_BASE_URL");
    expect(content).toContain("ATLASSIAN_API_TOKEN");
    expect(content).toContain("sf_web_login");
    expect(content).toContain("jira_issue");
    expect(content).toContain("story_context");
  });
});
