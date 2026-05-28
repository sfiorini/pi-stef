import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

import { Value } from "typebox/value";
import { ConfigSchema, DEFAULT_CONFIG, type ResolvedDefaults } from "../src/config/schema";
import { createSfTeamImplement } from "../src/tools/implement";
import { createSfTeamAuto } from "../src/tools/auto";
import { resolveDefaults } from "../src/config/load";
import { planFolderPath } from "../src/plan/paths";
import { slugify } from "../src/plan/slug";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

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
  const root = mkdtempSync(path.join(tmpdir(), "ct-pause-gate-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "x");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function seedPlanFolder(
  root: string,
  slug: string,
  milestoneCount: number,
  opts: { executionStrategy?: "parallel-milestones" } = {},
): void {
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  let plan = "# Plan\n\n## Goal\nseeded\n\n## Milestones\n\n";
  let tracker = "# Story Tracker\n\n## Milestones\n\n";
  for (let i = 1; i <= milestoneCount; i++) {
    plan += `### M${i}: Milestone ${i}\n\n**Stories:**\n- **S-${i}01 — task ${i}.** Body.\n\n`;
    // Description text avoids the literal word "Story" (case-insensitive)
    // because parseTrackerText's column-header detection is regex-based
    // and would treat a row containing "story" in its description as a
    // second header line, dropping the row.
    tracker += `### M${i}: Milestone ${i}\n\n| Story | Description | Status | Notes |\n|-------|-------------|--------|-------|\n| S-${i}01 | task | pending | |\n\n**Approval Status:** pending\n\n`;
  }
  writeFileSync(path.join(folder, "milestone-plan.md"), plan);
  writeFileSync(path.join(folder, "story-tracker.md"), tracker);
  writeFileSync(path.join(folder, "continuation-runbook.md"), "runbook stub");
  writeFileSync(path.join(folder, "original-plan.md"), plan);
  writeFileSync(path.join(folder, "final-transcript.md"), "transcript stub");
  if (opts.executionStrategy === "parallel-milestones") {
    writeFileSync(
      path.join(folder, "execution-strategy.json"),
      JSON.stringify({
        version: 1,
        maxParallelMilestones: milestoneCount,
        maxParallelStoriesPerMilestone: 1,
        milestoneWaves: [
          {
            id: "W1",
            milestones: Array.from({ length: milestoneCount }, (_, index) => `M${index + 1}`),
            maxParallel: milestoneCount,
          },
        ],
        stories: Object.fromEntries(
          Array.from({ length: milestoneCount }, (_, index) => {
            const milestoneIndex = index + 1;
            const milestoneId = `M${milestoneIndex}`;
            const storyId = `S-${milestoneIndex}01`;
            return [
              milestoneId,
              {
                maxParallelStories: 1,
                storyWaves: [
                  {
                    id: `${milestoneId}-W1`,
                    stories: [storyId],
                    maxParallel: 1,
                    writeSets: { [storyId]: [`m${milestoneIndex}.txt`] },
                  },
                ],
              },
            ];
          }),
        ),
      }),
    );
  }
}

describe("S-201: schema + DEFAULT_CONFIG", () => {
  it("DEFAULT_CONFIG.implement.pause_between_milestones is true", () => {
    expect(DEFAULT_CONFIG.implement.pause_between_milestones).toBe(true);
  });
  it("DEFAULT_CONFIG.auto.pause_between_milestones is false", () => {
    expect(DEFAULT_CONFIG.auto.pause_between_milestones).toBe(false);
  });
  it("ConfigSchema accepts both true and false on implement.pause_between_milestones", () => {
    expect([...Value.Errors(ConfigSchema, { implement: { pause_between_milestones: true } })]).toHaveLength(0);
    expect([...Value.Errors(ConfigSchema, { implement: { pause_between_milestones: false } })]).toHaveLength(0);
    expect([...Value.Errors(ConfigSchema, { auto: { pause_between_milestones: true } })]).toHaveLength(0);
    expect([...Value.Errors(ConfigSchema, { auto: { pause_between_milestones: false } })]).toHaveLength(0);
  });
});

describe("S-202: resolveDefaults merges pause_between_milestones", () => {
  it("project-config wins over default", () => {
    const r = resolveDefaults({ implement: { pause_between_milestones: false } });
    expect(r.implement.pause_between_milestones).toBe(false);
    // auto unchanged
    expect(r.auto.pause_between_milestones).toBe(false);
  });
  it("falls back to DEFAULT_CONFIG when no override is present", () => {
    const r = resolveDefaults({});
    expect(r.implement.pause_between_milestones).toBe(true);
    expect(r.auto.pause_between_milestones).toBe(false);
  });
  it("auto override does not affect implement", () => {
    const r = resolveDefaults({ auto: { pause_between_milestones: true } });
    expect(r.auto.pause_between_milestones).toBe(true);
    expect(r.implement.pause_between_milestones).toBe(true); // default
  });
});

describe("S-203: implement-tool inter-milestone confirm gate", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  async function runScenario(opts: {
    pause: boolean | undefined;
    confirmAnswer?: boolean;
    headless?: boolean;
    milestones: number;
    mode?: "all-milestones" | "single-milestone";
    useWorktree?: boolean;
    parallelStrategy?: boolean;
  }): Promise<{ outcomes: number; confirmCalls: number; warnCalls: number; developerCalls: number }> {
    const { root, dispose } = makeRepo();
    try {
      const slug = slugify("Pause Gate", new Date("2026-05-02"));
      seedPlanFolder(root, slug, opts.milestones, {
        executionStrategy: opts.parallelStrategy ? "parallel-milestones" : undefined,
      });
      let confirmCalls = 0;
      const ui = opts.headless ? undefined : ({
        select: async () => undefined,
        input: async () => "",
        confirm: vi.fn(async () => {
          confirmCalls++;
          return opts.confirmAnswer ?? true;
        }),
        notify: () => undefined,
      } as never);
      // spawnAgent: developer makes a tiny diff (so commit can succeed),
      // reviewer immediately APPROVES. We do not exercise the real review
      // loop here; we want the inter-milestone gate behavior.
      let devCount = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          devCount++;
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, `dev-${devCount}.md`), `dev ${devCount}\n`);
          spawnSync("git", ["add", `dev-${devCount}.md`], { cwd });
          return fakeRun("done");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const configDefaults = resolveDefaults({}) satisfies ResolvedDefaults;
      const result = await tool(
        {
          slug,
          mode: opts.mode ?? "all-milestones",
          useWorktree: opts.useWorktree ?? false,
          pauseBetweenMilestones: opts.pause,
          verifyCommand: false, // skip lint/typecheck/test gate in fixture repo
        },
        { repoRoot: root, ui, configDefaults },
      );
      // Debug aid for failures: log when no milestones came back.
      if (result.milestones.length === 0) {
        // eslint-disable-next-line no-console
        console.error("[debug] zero outcomes; spawnAgent calls:", spawnAgent.mock.calls.length);
      }
      return {
        outcomes: result.milestones.length,
        confirmCalls,
        warnCalls: warnSpy.mock.calls.length,
        developerCalls: devCount,
      };
    } finally {
      dispose();
    }
  }

  it("pause=true + confirm=yes: continues through all milestones; gate fires N-1 times", async () => {
    const r = await runScenario({ pause: true, confirmAnswer: true, milestones: 2 });
    expect(r.outcomes).toBe(2);
    // The gate is skipped after the LAST milestone (nothing to continue
    // to), so we expect exactly N-1 confirms for N milestones.
    expect(r.confirmCalls).toBe(1);
  });

  it("pause=true + confirm=no: stops after first milestone", async () => {
    const r = await runScenario({ pause: true, confirmAnswer: false, milestones: 2 });
    expect(r.outcomes).toBe(1);
    expect(r.confirmCalls).toBe(1);
  });

  it("single-milestone parallel strategy asks before the second milestone batch", async () => {
    const r = await runScenario({
      pause: true,
      confirmAnswer: false,
      milestones: 2,
      mode: "single-milestone",
      useWorktree: true,
      parallelStrategy: true,
    });
    expect(r.outcomes).toBe(1);
    expect(r.confirmCalls).toBe(1);
    expect(r.developerCalls).toBe(1);
  });

  it("pause=false: continues without prompting", async () => {
    const r = await runScenario({ pause: false, milestones: 2 });
    expect(r.outcomes).toBe(2);
    expect(r.confirmCalls).toBe(0);
  });
});

describe("S-204: headless safety", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warnSpy.mockRestore());

  it("pause=true + no UI: warns and continues without hanging", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = slugify("Headless Pause", new Date("2026-05-02"));
      seedPlanFolder(root, slug, 2);
      let devCount = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          devCount++;
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, `dev-${devCount}.md`), `dev ${devCount}\n`);
          spawnSync("git", ["add", `dev-${devCount}.md`], { cwd });
          return fakeRun("done");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          slug,
          mode: "all-milestones",
          useWorktree: false,
          pauseBetweenMilestones: true, // explicit on
          verifyCommand: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({}) },
      );
      // Both milestones complete; no UI was available, so we must have
      // continued silently with a warning.
      expect(result.milestones.length).toBe(2);
      const warned = warnSpy.mock.calls.some((args: unknown[]) =>
        String(args[0] ?? "").includes("pause_between_milestones=true but no UI"),
      );
      expect(warned).toBe(true);
    } finally {
      dispose();
    }
  });
});

describe("S-205: sf_team_auto wires pauseBetweenMilestones to implement", () => {
  it("auto.pause_between_milestones=true in config makes the auto run prompt between milestones", async () => {
    const { root, dispose } = makeRepo();
    try {
      let confirmCalls = 0;
      const ui = {
        select: async () => undefined,
        input: async () => "",
        confirm: vi.fn(async () => {
          confirmCalls++;
          return true;
        }),
        notify: () => undefined,
      } as never;
      // Mock spawnAgent for both plan and implement phases.
      let devCount = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "planner") {
          // Two-milestone valid plan.
          const plan = `# Plan: pause-auto

## Goal
End-to-end auto run with pauseBetweenMilestones=true so the orchestrator
prompts the user between milestones.

## Architecture
Two milestones for the harness; both are tiny.

## Tech stack
- typescript

## Milestones

### M1: First

**Description:** First step.

**Stories:**
- **S-101 — first.** Body prose.

### M2: Second

**Description:** Second step.

**Stories:**
- **S-201 — second.** Body prose.
`;
          return fakeRun(plan);
        }
        if (member.role === "developer") {
          devCount++;
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, `auto-dev-${devCount}.md`), `auto ${devCount}\n`);
          spawnSync("git", ["add", `auto-dev-${devCount}.md`], { cwd });
          return fakeRun("done");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamAuto({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Pause Auto", brief: "go", analysisOverride: null, answersOverride: {} } as never,
        {
          repoRoot: root,
          ui,
          configDefaults: resolveDefaults({ auto: { pause_between_milestones: true, use_worktree: false } }),
        },
      );
      expect(result.implement.milestones.length).toBe(2);
      // Confirm was called between M1 and M2.
      expect(confirmCalls).toBeGreaterThanOrEqual(1);
    } finally {
      dispose();
    }
  });
});

describe("S-206: shouldContinue (when explicitly provided) overrides config", () => {
  it("test-injected shouldContinue takes precedence over pause_between_milestones=true", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = slugify("Callback Wins", new Date("2026-05-02"));
      seedPlanFolder(root, slug, 2);
      let devCount = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          devCount++;
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, `cb-dev-${devCount}.md`), `cb ${devCount}\n`);
          spawnSync("git", ["add", `cb-dev-${devCount}.md`], { cwd });
          return fakeRun("done");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const cbCalls: string[] = [];
      const ui = {
        select: async () => undefined,
        input: async () => "",
        confirm: vi.fn(async () => true),
        notify: () => undefined,
      } as never;
      const result = await tool(
        {
          slug,
          mode: "all-milestones",
          useWorktree: false,
          pauseBetweenMilestones: true, // would normally prompt
          verifyCommand: false,
          shouldContinue: async (id) => {
            cbCalls.push(id);
            return false; // stop after M1
          },
        },
        { repoRoot: root, ui, configDefaults: resolveDefaults({}) },
      );
      // Callback was used; ui.confirm was NOT called.
      expect(cbCalls).toEqual(["M1"]);
      expect((ui as { confirm: ReturnType<typeof vi.fn> }).confirm).not.toHaveBeenCalled();
      expect(result.milestones.length).toBe(1);
    } finally {
      dispose();
    }
  });
});
