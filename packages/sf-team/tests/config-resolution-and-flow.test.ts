import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { loadAndResolveDefaults, resolveDefaults } from "../src/config/load";
import { DEFAULT_CONFIG } from "../src/config/schema";
import { createSfTeamPlan } from "../src/tools/plan";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { validPlanText } from "./helpers/valid-plan";

const APPROVED = `## Summary
ok
## Findings
### P0
- None.
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: APPROVED`;

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-cfg-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "x");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  mkdirSync(path.join(root, "ai_plan"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeRun(text: string): AgentRun {
  return {
    state: "completed",
    pid: 1,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: 0,
    finalText: text,
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    stderrTail: "",
  };
}

describe("resolveDefaults: deep-merge loaded config onto DEFAULT_CONFIG", () => {
  it("empty loaded config falls back to DEFAULT_CONFIG verbatim", () => {
    expect(resolveDefaults({})).toEqual(DEFAULT_CONFIG);
  });

  it("partial agents override only the specified roles", () => {
    const out = resolveDefaults({
      agents: { researcher: { model: "gpt-5.4-mini", thinking: "low" as const } },
    } as never);
    expect(out.agents.researcher.model).toBe("gpt-5.4-mini");
    expect(out.agents.researcher.thinking).toBe("low");
    // unspecified fields inherit from defaults
    expect(out.agents.researcher.heartbeatMs).toBe(DEFAULT_CONFIG.agents.researcher.heartbeatMs);
    // unspecified roles are unchanged
    expect(out.agents.planner).toEqual(DEFAULT_CONFIG.agents.planner);
  });

  it("review.max_rounds and other knobs override correctly", () => {
    const out = resolveDefaults({ review: { max_rounds: 3 } });
    expect(out.review).toEqual({ max_rounds: 3, plan_max_rounds: 3, implementation_max_rounds: 3 });
    expect(out.implement).toEqual(DEFAULT_CONFIG.implement);
  });

  it("workflow.profile=headless applies faster review caps unless explicitly overridden", () => {
    const headless = resolveDefaults({ workflow: { profile: "headless" } } as never);
    expect(headless.workflow.profile).toBe("headless");
    expect(headless.review).toEqual({
      max_rounds: 4,
      plan_max_rounds: 3,
      implementation_max_rounds: 4,
    });

    const explicit = resolveDefaults({
      workflow: { profile: "headless" },
      review: { max_rounds: 6, plan_max_rounds: 2 },
    } as never);
    expect(explicit.review).toEqual({
      max_rounds: 6,
      plan_max_rounds: 2,
      implementation_max_rounds: 6,
    });
  });

  it("performance defaults to 150ms widget coalescing and accepts explicit overrides", () => {
    expect(DEFAULT_CONFIG.performance.widget_update_interval_ms).toBe(150);
    expect(resolveDefaults({}).performance.widget_update_interval_ms).toBe(150);
    expect(resolveDefaults({ performance: { widget_update_interval_ms: 0 } } as never).performance.widget_update_interval_ms).toBe(0);
  });

  it("parallel defaults are enabled and merge as a dedicated config section", () => {
    expect(DEFAULT_CONFIG.parallel).toEqual({
      enabled: true,
      max_milestones: 3,
      max_stories_per_milestone: 2,
      on_conflict: "stop",
      keep_lane_branches: false,
    });
    expect(resolveDefaults({ parallel: { enabled: false, max_milestones: 1 } }).parallel).toEqual({
      ...DEFAULT_CONFIG.parallel,
      enabled: false,
      max_milestones: 1,
    });
  });

  it("built-in defaults favor routine speed in the default profile", () => {
    expect(DEFAULT_CONFIG.agents.planner).toEqual({ model: "claude-sonnet-4-6", thinking: "medium", heartbeatMs: 300_000 });
    expect(DEFAULT_CONFIG.agents.reviewer).toEqual({ model: "claude-sonnet-4-6", thinking: "high", heartbeatMs: 600_000 });
    expect(DEFAULT_CONFIG.agents.developer).toEqual({ model: "claude-sonnet-4-6", thinking: "medium", heartbeatMs: 600_000 });
    expect(DEFAULT_CONFIG.agents.researcher).toEqual({ model: "claude-haiku-4-5", thinking: "low", heartbeatMs: 300_000 });
    expect(DEFAULT_CONFIG.performance.researcher).toBe("auto");
    expect(DEFAULT_CONFIG.performance.plan_revision).toBe("patch");
    expect(DEFAULT_CONFIG.workflow.profile).toBe("default");
  });

  it("agent overrides remain field-level for model, thinking, heartbeat, and all three together", () => {
    expect(resolveDefaults({ agents: { planner: { model: "gpt-5.3-codex" } } }).agents.planner).toEqual({
      ...DEFAULT_CONFIG.agents.planner,
      model: "gpt-5.3-codex",
    });
    expect(resolveDefaults({ agents: { planner: { thinking: "xhigh" } } } as never).agents.planner).toEqual({
      ...DEFAULT_CONFIG.agents.planner,
      thinking: "xhigh",
    });
    expect(resolveDefaults({ agents: { planner: { heartbeatMs: 123_000 } } } as never).agents.planner).toEqual({
      ...DEFAULT_CONFIG.agents.planner,
      heartbeatMs: 123_000,
    });
    expect(
      resolveDefaults({
        agents: { planner: { model: "claude-opus-4-7", thinking: "high", heartbeatMs: 999_000 } },
      } as never).agents.planner,
    ).toEqual({ model: "claude-opus-4-7", thinking: "high", heartbeatMs: 999_000 });
  });

  it("explicit rollback config restores the prior opus defaults and full-rewrite policies", () => {
    const rollback = resolveDefaults({
      agents: {
        planner: { model: "claude-opus-4-7", thinking: "high", heartbeatMs: 300_000 },
        reviewer: { model: "claude-opus-4-7", thinking: "xhigh", heartbeatMs: 600_000 },
        developer: { model: "claude-opus-4-7", thinking: "high", heartbeatMs: 600_000 },
        researcher: { model: "claude-opus-4-7", thinking: "medium", heartbeatMs: 300_000 },
      },
      performance: { researcher: "always", plan_revision: "full" },
    } as never);
    expect(rollback.agents.planner.model).toBe("claude-opus-4-7");
    expect(rollback.agents.reviewer.thinking).toBe("xhigh");
    expect(rollback.agents.researcher.thinking).toBe("medium");
    expect(rollback.performance.researcher).toBe("always");
    expect(rollback.performance.plan_revision).toBe("full");
  });
});

describe("loadAndResolveDefaults: surfaces broken JSON via notify and falls back", () => {
  it("ignores a missing config and returns DEFAULT_CONFIG silently", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-home-"));
    try {
      const notify = vi.fn();
      const out = await loadAndResolveDefaults("/nonexistent/repo", { homeDir: home, notify });
      expect(out).toEqual(DEFAULT_CONFIG);
      expect(notify).not.toHaveBeenCalled(); // missing file is not an error
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("on broken JSON, notifies the user and falls back to defaults", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-home-bad-"));
    try {
      const cfgDir = path.join(home, ".pi", "sf-team");
      mkdirSync(cfgDir, { recursive: true });
      // EXACT shape from the user's actual broken file: missing closing quote on key.
      writeFileSync(
        path.join(cfgDir, "config.json"),
        '{ "agents": { "researcher: { "model": "gpt-5.4-mini" } } }',
      );
      const notify = vi.fn();
      const out = await loadAndResolveDefaults("/nonexistent/repo", { homeDir: home, notify });
      expect(out).toEqual(DEFAULT_CONFIG);
      expect(notify).toHaveBeenCalledOnce();
      const [msg, level] = notify.mock.calls[0];
      expect(msg).toMatch(/sf-team config:.*falling back to built-in defaults/i);
      expect(msg).toMatch(/invalid JSON/i);
      expect(level).toBe("warning");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("project performance policy wins over global while preserving unspecified global fields", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-home-perf-"));
    const { root, dispose } = makeRepo();
    try {
      const globalDir = path.join(home, ".pi", "sf-team");
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(
        path.join(globalDir, "config.json"),
        JSON.stringify({ performance: { researcher: "always", plan_revision: "full", widget_update_interval_ms: 10 } }),
      );
      writeFileSync(path.join(root, ".sf-team.json"), JSON.stringify({ performance: { researcher: "never" } }));
      const out = await loadAndResolveDefaults(root, { homeDir: home });
      expect(out.performance).toEqual({
        researcher: "never",
        plan_revision: "full",
        widget_update_interval_ms: 10,
      });
      expect(out.workflow.profile).toBe("default");
    } finally {
      rmSync(home, { recursive: true, force: true });
      dispose();
    }
  });

  it("on valid config, applies it without notify", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-home-good-"));
    try {
      const cfgDir = path.join(home, ".pi", "sf-team");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        path.join(cfgDir, "config.json"),
        JSON.stringify({
          agents: {
            researcher: { model: "gpt-5.4-mini", thinking: "medium" },
            planner: { model: "gpt-5.3-codex" },
          },
        }),
      );
      const notify = vi.fn();
      const out = await loadAndResolveDefaults("/nonexistent/repo", { homeDir: home, notify });
      expect(notify).not.toHaveBeenCalled();
      expect(out.agents.researcher.model).toBe("gpt-5.4-mini");
      expect(out.agents.planner.model).toBe("gpt-5.3-codex");
      expect(out.agents.developer.model).toBe(DEFAULT_CONFIG.agents.developer.model);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("project config (<repo>/.sf-team.json) is loaded and wins over global on field conflicts", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-home-proj-"));
    const { root, dispose } = makeRepo();
    try {
      const globalDir = path.join(home, ".pi", "sf-team");
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(
        path.join(globalDir, "config.json"),
        JSON.stringify({
          agents: {
            planner: { model: "global-planner" },
            reviewer: { model: "global-reviewer" },
          },
          review: { max_rounds: 7 },
        }),
      );
      writeFileSync(
        path.join(root, ".sf-team.json"),
        JSON.stringify({
          agents: { planner: { model: "project-planner", thinking: "xhigh" } },
          review: { max_rounds: 3 },
        }),
      );
      const notify = vi.fn();
      const out = await loadAndResolveDefaults(root, { homeDir: home, notify });
      expect(notify).not.toHaveBeenCalled();
      // project wins on conflicting fields, global preserved otherwise
      expect(out.agents.planner.model).toBe("project-planner");
      expect(out.agents.planner.thinking).toBe("xhigh");
      expect(out.agents.reviewer.model).toBe("global-reviewer");
      expect(out.review.max_rounds).toBe(3);
    } finally {
      rmSync(home, { recursive: true, force: true });
      dispose();
    }
  });
});

describe("end-to-end: configDefaults reaches the spawned agents", () => {
  it("when ctx.configDefaults overrides agent models, the planner+reviewer are spawned with those models (researcher path skipped here via analysisOverride)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const observed: TeamMember[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, _t: AgentTask) => {
        observed.push(member);
        if (member.role === "planner") return fakeRun(validPlanText("config-draft"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });

      const overrideDefaults = resolveDefaults({
        agents: {
          researcher: { model: "gpt-5.4-mini", thinking: "low" as const },
          planner: { model: "gpt-5.3-codex" },
          reviewer: { model: "gpt-5.2" },
        },
      } as never);
      await tool(
        { title: "test", brief: "go", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, configDefaults: overrideDefaults },
      );

      const planner = observed.find((m) => m.role === "planner")!;
      const reviewer = observed.find((m) => m.role === "reviewer")!;
      expect(planner.model).toBe("gpt-5.3-codex");
      expect(reviewer.model).toBe("gpt-5.2");
    } finally {
      dispose();
    }
  });

  it("buggy notify hook does NOT propagate as a rejection from loadAndResolveDefaults", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-home-throw-"));
    try {
      const cfgDir = path.join(home, ".pi", "sf-team");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(path.join(cfgDir, "config.json"), '{ "garbage": ');
      const notify = vi.fn(() => {
        throw new Error("UI hook crashed");
      });
      const out = await loadAndResolveDefaults("/x", { homeDir: home, notify });
      // Falls back to DEFAULT_CONFIG even though notify threw.
      expect(out).toEqual(DEFAULT_CONFIG);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("warning message uses ~ for home and <repo> for repo-root paths (no absolute paths leaked)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-home-path-"));
    try {
      const cfgDir = path.join(home, ".pi", "sf-team");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(path.join(cfgDir, "config.json"), "{ broken json");
      const messages: string[] = [];
      await loadAndResolveDefaults("/x", { homeDir: home, notify: (m) => messages.push(m) });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/~\/\.pi\/sf-team\/config\.json/);
      expect(messages[0]).not.toContain(home); // raw home path absent
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("non-agent knob END-TO-END: configured task.allow_dirty=true skips the dirty-worktree guard", async () => {
    const { createSfTeamTask } = await import("../src/tools/task");
    const { root, dispose } = makeRepo();
    try {
      // Make the worktree dirty.
      writeFileSync(path.join(root, "uncommitted.txt"), "x");
      const observed: TeamMember[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, _t: AgentTask) => {
        observed.push(member);
        if (member.role === "developer") {
          // Stage a real change so impl-review has a non-empty diff.
          writeFileSync(path.join(root, "dev-touched.txt"), "y");
          spawnSync("git", ["add", "dev-touched.txt"], { cwd: root });
          return fakeRun("dev done");
        }
        if (member.role === "planner") return fakeRun(validPlanText("config-plan"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });

      // 1) WITHOUT the config override → throws.
      await expect(
        tool({ title: "x", brief: "go", verifyCommand: false }, { repoRoot: root }),
      ).rejects.toThrow(/working tree is dirty/);

      // 2) WITH config override allow_dirty=true → run completes.
      const resolved = resolveDefaults({ task: { allow_dirty: true } } as never);
      const result = await tool(
        { title: "y", brief: "go", verifyCommand: false },
        { repoRoot: root, configDefaults: resolved },
      );
      expect(result.approved).toBe(true);
    } finally {
      dispose();
    }
  });

  it("default developer heartbeat (600_000ms = 10min) reaches the spawned developer member end-to-end", async () => {
    // Regression test for the 5min → 10min bump. A multi-file milestone
    // turn was getting killed during a legitimately-slow inference call
    // because the developer's previous default was 5min while the model
    // was still reasoning. See packages/sf-team/src/config/schema.ts
    // DEFAULT_CONFIG.agents.developer.heartbeatMs.
    const { createSfTeamTask } = await import("../src/tools/task");
    const { root, dispose } = makeRepo();
    try {
      const observed: TeamMember[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, _t: AgentTask) => {
        observed.push(member);
        if (member.role === "developer") {
          writeFileSync(path.join(root, "dev-touched.txt"), "y");
          spawnSync("git", ["add", "dev-touched.txt"], { cwd: root });
          return fakeRun("dev done");
        }
        if (member.role === "planner") return fakeRun(validPlanText("hb"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      // No agent overrides — exercise the DEFAULT_CONFIG fallback path for
      // agents.developer.heartbeatMs. allow_dirty=true is needed because the
      // tool's pre-flight clean-worktree check fires before the developer
      // ever spawns; we set it via configDefaults so the assertion below
      // observes the developer the orchestrator actually built.
      const resolved = resolveDefaults({ task: { allow_dirty: true } } as never);
      await tool(
        { title: "hb", brief: "go", verifyCommand: false },
        { repoRoot: root, configDefaults: resolved },
      );
      const developer = observed.find((m) => m.role === "developer")!;
      expect(developer.heartbeatMs).toBe(600_000);
      expect(developer.heartbeatMs).toBe(DEFAULT_CONFIG.agents.developer.heartbeatMs);
    } finally {
      dispose();
    }
  });

  it("non-agent knobs are correctly resolved (shape-level test, complements the e2e above)", async () => {
    const { createSfTeamImplement } = await import("../src/tools/implement");
    const { createSfTeamAuto } = await import("../src/tools/auto");
    // No real run — just verify resolveDefaults' shape is what tools read.
    const r = resolveDefaults({
      implement: { mode: "all-milestones", branch_prefix: "feature/" },
      auto: { mode: "single-milestone", branch_prefix: "ci/" },
      task: { allow_dirty: true },
      followup: { allow_dirty: true },
    } as never);
    expect(r.implement.mode).toBe("all-milestones");
    expect(r.implement.branch_prefix).toBe("feature/");
    expect(r.auto.mode).toBe("single-milestone");
    expect(r.auto.branch_prefix).toBe("ci/");
    expect(r.task.allow_dirty).toBe(true);
    expect(r.followup.allow_dirty).toBe(true);
    // reuse_parent_worktree was removed from the followup schema; followup
    // now runs in cwd (mirrors task), so the field has nothing to gate.
    expect((r.followup as Record<string, unknown>).reuse_parent_worktree).toBeUndefined();
    // (factories are imported just to confirm they compile against the resolved types)
    expect(typeof createSfTeamImplement).toBe("function");
    expect(typeof createSfTeamAuto).toBe("function");
  });

  it("when ctx.configDefaults is omitted, falls back to DEFAULT_CONFIG (claude-opus-4-7)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const observed: TeamMember[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        observed.push(member);
        if (member.role === "planner") return fakeRun(validPlanText("config-draft"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { title: "x", brief: "go", analysisOverride: null, answersOverride: {} },
        { repoRoot: root },
      );
      const planner = observed.find((m) => m.role === "planner")!;
      expect(planner.model).toBe(DEFAULT_CONFIG.agents.planner.model);
    } finally {
      dispose();
    }
  });

  it("project config (<repo>/.sf-team.json) reaches the spawned agents (parallel to the global-only e2e above)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-home-proj-e2e-"));
    const { root, dispose } = makeRepo();
    try {
      writeFileSync(
        path.join(root, ".sf-team.json"),
        JSON.stringify({
          agents: {
            planner: { model: "openai-codex/gpt-5.3-codex" },
            reviewer: { model: "openai-codex/gpt-5.2" },
          },
        }),
      );
      const observed: TeamMember[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        observed.push(member);
        if (member.role === "planner") return fakeRun(validPlanText("config-draft"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const configDefaults = await loadAndResolveDefaults(root, { homeDir: home });
      await tool(
        { title: "x", brief: "go", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, configDefaults },
      );
      const planner = observed.find((m) => m.role === "planner")!;
      const reviewer = observed.find((m) => m.role === "reviewer")!;
      expect(planner.model).toBe("openai-codex/gpt-5.3-codex");
      expect(reviewer.model).toBe("openai-codex/gpt-5.2");
    } finally {
      rmSync(home, { recursive: true, force: true });
      dispose();
    }
  });
});
