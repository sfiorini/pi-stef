import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findAgentDefinition,
  resolveAgentInfoMap,
  globalAgentsDir,
  projectAgentsDir,
} from "../src/config/agent-files.js";

// Temp-dir fixture (repo convention: mkdtempSync under the OS tmpdir): a fake
// "project" cwd and a fake "global" agent dir driven by PI_CODING_AGENT_DIR
// (getAgentDir honors it), so tests never touch the user's real
// ~/.pi/agent/agents.
let TMP = "";

function makeProject(agent: { name: string; frontmatter?: string }) {
  const cwd = join(TMP, "proj");
  mkdirSync(projectAgentsDir(cwd), { recursive: true });
  writeFileSync(
    join(projectAgentsDir(cwd), `${agent.name}.md`),
    `---\n${agent.frontmatter ?? "description: test agent\n"}---\n\nBody prompt.\n`,
    "utf8",
  );
  return cwd;
}

/** Write a global agent under a given PI_CODING_AGENT_DIR, in the real layout
 *  (<agentDir>/agents/<name>.md) so discovery finds it. */
function makeGlobal(agent: { name: string; frontmatter?: string }) {
  const dir = join(TMP, "global-agents", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${agent.name}.md`),
    `---\n${agent.frontmatter ?? "description: global agent\n"}---\n\nGlobal body.\n`,
    "utf8",
  );
}

describe("agent-files discovery", () => {
  const originalEnv = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "flow-agent-files-"));
    process.env.PI_CODING_AGENT_DIR = join(TMP, "agent-dir");
    mkdirSync(join(TMP, "agent-dir", "agents"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalEnv;
  });

  it("finds a global agent and parses its frontmatter", async () => {
    makeGlobal({ name: "researcher", frontmatter: "description: Researcher\nmodel: global/model-r\n" });
    process.env.PI_CODING_AGENT_DIR = join(TMP, "global-agents");
    const info = await findAgentDefinition("researcher", join(TMP, "empty-proj"));
    expect(info).not.toBeNull();
    expect(info!.source).toBe("global");
    expect(info!.path).toContain("researcher.md");
    expect(info!.frontmatter.model).toBe("global/model-r");
  });

  it("returns null when no .md exists in either location", async () => {
    const info = await findAgentDefinition("ghost", join(TMP, "empty-proj"));
    expect(info).toBeNull();
  });

  it("project .md overrides global of the same name", async () => {
    process.env.PI_CODING_AGENT_DIR = join(TMP, "global-agents");
    makeGlobal({ name: "reviewer", frontmatter: "description: global rev\nmodel: global/model-x\n" });
    const cwd = makeProject({ name: "reviewer", frontmatter: "description: project rev\nmodel: project/model-y\n" });
    const info = await findAgentDefinition("reviewer", cwd);
    expect(info!.source).toBe("project");
    expect(info!.frontmatter.model).toBe("project/model-y");
  });

  it("matches names case-insensitively (Reviewer.md found for 'reviewer')", async () => {
    const cwd = join(TMP, "proj-ci");
    mkdirSync(projectAgentsDir(cwd), { recursive: true });
    writeFileSync(join(projectAgentsDir(cwd), "Reviewer.md"), "---\nmodel: a/b\n---\n\nbody\n", "utf8");
    const info = await findAgentDefinition("reviewer", cwd);
    expect(info!.source).toBe("project");
    expect(info!.frontmatter.model).toBe("a/b");
  });

  it("reads the full frontmatter report shape", async () => {
    const cwd = makeProject({
      name: "auditor",
      frontmatter:
        "description: Audit\nmodel: anthropic/claude-sonnet-5-5\nthinking: high\ntools: read, grep, find, ls\nmax_turns: 30\nisolated: true\n",
    });
    const info = await findAgentDefinition("auditor", cwd);
    expect(info!.frontmatter).toEqual({
      model: "anthropic/claude-sonnet-5-5",
      thinking: "high",
      tools: "read, grep, find, ls",
      max_turns: 30,
      isolated: true,
      enabled: true,
    });
  });

  it("reports enabled: false so a disabled agent is not presented as usable", async () => {
    const cwd = makeProject({ name: "scanner", frontmatter: "description: s\nenabled: false\nmodel: a/b\n" });
    const info = await findAgentDefinition("scanner", cwd);
    expect(info!.frontmatter.enabled).toBe(false);
  });

  it("does NOT match a .MD extension (pi-subagents only loads .md)", async () => {
    const cwd = join(TMP, "proj-md-ext");
    mkdirSync(projectAgentsDir(cwd), { recursive: true });
    writeFileSync(join(projectAgentsDir(cwd), "Reviewer.MD"), "---\nmodel: a/b\n---\n\nbody\n", "utf8");
    const info = await findAgentDefinition("reviewer", cwd);
    expect(info).toBeNull();
  });

  it("a .md with no frontmatter reports empty fields (not an error)", async () => {
    const cwd = join(TMP, "proj-bare");
    mkdirSync(projectAgentsDir(cwd), { recursive: true });
    writeFileSync(join(projectAgentsDir(cwd), "synth.md"), "Just a body, no frontmatter.\n", "utf8");
    const info = await findAgentDefinition("synth", cwd);
    expect(info!.source).toBe("project");
    expect(info!.frontmatter.model).toBeUndefined();
  });

  it("honors PI_CODING_AGENT_DIR for the global dir", async () => {
    makeGlobal({ name: "scanner", frontmatter: "description: global scanner\n" });
    process.env.PI_CODING_AGENT_DIR = join(TMP, "global-agents");
    // global-agents is a DIFFERENT tree than the default ~/.pi/agent/agents,
    // so a find there proves the env var was honored.
    const dir = await globalAgentsDir();
    expect(dir).toBe(join(TMP, "global-agents", "agents"));
    const info = await findAgentDefinition("scanner", join(TMP, "empty-proj"));
    expect(info!.source).toBe("global");
  });

  it("resolveAgentInfoMap resolves several agents, null for missing ones", async () => {
    const cwd = makeProject({ name: "planner", frontmatter: "description: p\n" });
    makeGlobal({ name: "notifier", frontmatter: "description: n\nmodel: g/n\n" });
    process.env.PI_CODING_AGENT_DIR = join(TMP, "global-agents");
    const map = await resolveAgentInfoMap(["planner", "notifier", "ghost"], cwd);
    expect(map.get("planner")!.source).toBe("project");
    expect(map.get("notifier")!.source).toBe("global");
    expect(map.get("notifier")!.frontmatter.model).toBe("g/n");
    expect(map.get("ghost")).toBeNull();
  });
});
