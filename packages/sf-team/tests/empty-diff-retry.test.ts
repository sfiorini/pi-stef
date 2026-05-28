/**
 * S-M36 — Tests for the M3 empty-diff retry policy.
 *
 * Scenarios pinned by this file:
 *   1. Retry success: first dev attempt stages nothing, retry stages a
 *      real file → milestone approved (no throw).
 *   2. Retry exhaustion: every dev attempt stages nothing → EmptyDiffError
 *      with `attempts === 1 + retries`, slug + resumeTool populated.
 *   3. Model bump: when `implement.empty_diff_retry_model` is configured,
 *      only the LAST retry's developer spawn receives the override.
 *   4. Transcript records: each retry has a
 *      `developer-impl-retry-${milestoneId}-${attempt}` entry.
 *   5. `developerOutput` replacement: the reviewer's payload reflects the
 *      successful retry's text, not the failed first attempt's.
 *   6. Parallel-story site: same retry logic at the story-lane call.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resolveDefaults } from "../src/config/load";
import { EmptyDiffError } from "../src/errors";
import { planFolderPath } from "../src/plan/paths";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { createSfTeamImplement } from "../src/tools/implement";

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

function makeRepoSequential(): { root: string; slug: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-empty-diff-retry-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const slug = "2026-05-08-empty-diff-retry";
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "milestone-plan.md"),
    `# Plan

### M1: First milestone

**Stories:**
- **S-101 — make a change.** Body.
`,
  );
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M1: First milestone

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | make a change | pending | |

**Approval Status:** pending
`,
  );
  // Force sequential path: omit execution-strategy.json so the tool falls
  // back to the sequential per-milestone loop where reviewMilestoneChanges
  // runs (the retry site for the milestone path).
  return { root, slug, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function makeRepoParallel(): { root: string; slug: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-empty-diff-retry-par-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const slug = "2026-05-08-empty-diff-retry-par";
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, "milestone-plan.md"),
    `# Plan

### M1: One

**Stories:**
- **S-101 — make a change.** Body.
- **S-102 — make another change.** Body.
`,
  );
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M1: One

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | make a change | pending | |
| S-102 | make another change | pending | |

**Approval Status:** pending
`,
  );
  writeFileSync(
    path.join(folder, "execution-strategy.json"),
    JSON.stringify({
      version: 1,
      maxParallelMilestones: 1,
      maxParallelStoriesPerMilestone: 2,
      milestoneWaves: [{ id: "W1", milestones: ["M1"], maxParallel: 1 }],
      stories: {
        M1: {
          maxParallelStories: 2,
          storyWaves: [{ id: "M1-W1", stories: ["S-101", "S-102"], maxParallel: 2, writeSets: { "S-101": ["m1.txt"], "S-102": ["m2.txt"] } }],
        },
      },
    }),
  );
  return { root, slug, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("S-M36 milestone empty-diff retry policy", () => {
  it("retry-success: first dev attempt stages nothing, retry stages a real file → milestone approved", async () => {
    const { root, slug, dispose } = makeRepoSequential();
    try {
      const developerCalls: Array<{ task: string; cwd: string; model: string }> = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          developerCalls.push({ task: task.task, cwd, model: member.model });
          // First call: stage nothing. Second (retry) call: stage a file.
          if (developerCalls.length === 1) {
            return fakeRun("first attempt: i thought about it but didn't write anything");
          }
          writeFileSync(path.join(cwd, "m1.txt"), `m1 content from retry ${developerCalls.length - 1}\n`);
          spawnSync("git", ["add", "m1.txt"], { cwd });
          return fakeRun(`recovered attempt: wrote m1.txt on retry ${developerCalls.length - 1}`);
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          slug,
          mode: "single-milestone",
          useWorktree: true,
          branchPrefix: "impl/",
          verifyCommand: false,
          pauseBetweenMilestones: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({ parallel: { enabled: false } }) },
      );

      expect(result.milestones.map((m) => m.id)).toEqual(["M1"]);
      expect(result.milestones[0].approved).toBe(true);
      // Original + 1 retry that succeeded = 2 developer calls total.
      expect(developerCalls.length).toBe(2);
      // Retry's reprompt mentions the milestone id and the explicit "use Edit/Write" instruction.
      expect(developerCalls[1].task).toMatch(/Retry 1/);
      expect(developerCalls[1].task).toMatch(/Use the Edit\/Write tools to stage actual changes/);
    } finally {
      dispose();
    }
  });

  /**
   * Real-world failure mode (cursor/composer-2 in 2026-05-08):
   * developer edits tracked files via Edit/Write tools but never runs
   * `git add`. Pre-fix-B: readReviewDiff only saw staged + committed,
   * so the unstaged tracked changes looked identical to "did nothing"
   * and the M3 retry exhausted itself making more unstaged edits.
   * Fix B: readStagedDiff/readReviewDiff auto-stage tracked
   * modifications via `git add -u` before reading the diff. The
   * developer's edits are picked up on the FIRST attempt, no retry.
   */
  it("auto-stage: developer edits tracked files but does NOT git add → milestone approved on first attempt (no retry)", async () => {
    const { root, slug, dispose } = makeRepoSequential();
    try {
      // Seed a tracked file in the repo so the developer can modify it
      // without having to create+add a brand-new file.
      writeFileSync(path.join(root, "tracked.txt"), "original\n");
      spawnSync("git", ["add", "tracked.txt"], { cwd: root });
      spawnSync("git", ["commit", "-q", "-m", "seed tracked.txt"], { cwd: root });

      const developerCalls: string[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          developerCalls.push(task.task);
          const cwd = task.cwd ?? root;
          // Modify the tracked file but DO NOT `git add`. This mirrors
          // the failure mode where cursor/composer-2 edited 14 files
          // and never staged any of them.
          writeFileSync(path.join(cwd, "tracked.txt"), `modified by developer attempt ${developerCalls.length}\n`);
          return fakeRun(`I edited tracked.txt — the orchestrator should auto-stage`);
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          slug,
          mode: "single-milestone",
          useWorktree: true,
          branchPrefix: "impl/",
          verifyCommand: false,
          pauseBetweenMilestones: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({ parallel: { enabled: false } }) },
      );
      expect(result.milestones[0].approved).toBe(true);
      // Critical assertion: ONE developer call, not three. No retry fired
      // because the auto-stage caught the unstaged modifications.
      expect(developerCalls.length).toBe(1);
      // The committed milestone diff includes tracked.txt (proves auto-stage
      // path also feeds commitStaged correctly).
      const log = spawnSync("git", ["log", "--oneline", "--name-only"], {
        cwd: result.worktreePath,
        encoding: "utf8",
      }).stdout;
      expect(log).toContain("tracked.txt");
    } finally {
      dispose();
    }
  });

  it("retry-exhaustion: all dev attempts stage nothing → EmptyDiffError with attempts===1+retries, slug+resumeTool populated", async () => {
    const { root, slug, dispose } = makeRepoSequential();
    try {
      const developerCalls: number[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, _task: AgentTask) => {
        if (member.role === "developer") {
          developerCalls.push(developerCalls.length + 1);
          return fakeRun("nothing here either");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      let caught: unknown;
      try {
        await tool(
          {
            slug,
            mode: "single-milestone",
            useWorktree: true,
            branchPrefix: "impl/",
            verifyCommand: false,
            pauseBetweenMilestones: false,
          },
          {
            repoRoot: root,
            configDefaults: resolveDefaults({ parallel: { enabled: false }, implement: { empty_diff_retries: 2 } }),
            toolName: "sf_team_implement",
          },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EmptyDiffError);
      const e = caught as EmptyDiffError;
      // 1 initial + 2 retries = 3 attempts.
      expect(e.details.attempts).toBe(3);
      expect(e.details.slug).toBe(slug);
      expect(e.resumeTool).toBe("sf_team_implement_resume");
      expect(e.message.startsWith("FAILED: sf_team_implement empty_diff:")).toBe(true);
      expect(e.message).toContain("RESUME: invoke sf_team_implement_resume { resume: '" + slug + "' }");
      expect(developerCalls.length).toBe(3);
    } finally {
      dispose();
    }
  });

  it("model-bump: empty_diff_retry_model is passed to the developer spawn ONLY on the last retry", async () => {
    const { root, slug, dispose } = makeRepoSequential();
    try {
      const developerCalls: Array<{ model: string }> = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          developerCalls.push({ model: member.model });
          return fakeRun("still nothing");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      try {
        await tool(
          {
            slug,
            mode: "single-milestone",
            useWorktree: true,
            branchPrefix: "impl/",
            verifyCommand: false,
            pauseBetweenMilestones: false,
          },
          {
            repoRoot: root,
            configDefaults: resolveDefaults({
              parallel: { enabled: false },
              implement: { empty_diff_retries: 2, empty_diff_retry_model: "claude-opus-4-7" },
            }),
            toolName: "sf_team_implement",
          },
        );
      } catch {
        // Expected EmptyDiffError after exhaustion.
      }
      // Total: 1 initial + 2 retries = 3 calls.
      expect(developerCalls.length).toBe(3);
      // Initial + first retry use the configured developer model (default sonnet); only the last retry uses opus.
      const defaultDev = resolveDefaults({}).agents.developer.model;
      expect(developerCalls[0].model).toBe(defaultDev);
      expect(developerCalls[1].model).toBe(defaultDev);
      expect(developerCalls[2].model).toBe("claude-opus-4-7");
    } finally {
      dispose();
    }
  });

  it("developerOutput replacement: the reviewer payload reflects the SUCCESSFUL retry's text, not the failed first attempt", async () => {
    const { root, slug, dispose } = makeRepoSequential();
    try {
      const reviewerCalls: AgentTask[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          // First call: stage nothing AND say so (so the failed-attempt text is distinctive).
          if (!task.task.match(/Retry/)) {
            return fakeRun("FIRST_ATTEMPT_TEXT_NOT_TO_LEAK");
          }
          // Retry: stage a real file, return distinctive text.
          writeFileSync(path.join(cwd, "m1.txt"), `recovered\n`);
          spawnSync("git", ["add", "m1.txt"], { cwd });
          return fakeRun("RECOVERED_RETRY_TEXT");
        }
        if (member.role === "reviewer") {
          reviewerCalls.push(task);
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          slug,
          mode: "single-milestone",
          useWorktree: true,
          branchPrefix: "impl/",
          verifyCommand: false,
          pauseBetweenMilestones: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({ parallel: { enabled: false } }), toolName: "sf_team_implement" },
      );
      expect(result.milestones[0].approved).toBe(true);
      // The reviewer is called with composeImplSummary(finalText: activeDeveloperOutput).
      // After M3 S-M33's replacement, finalText must be the recovered retry's text.
      expect(reviewerCalls.length).toBeGreaterThan(0);
      const round1Payload = reviewerCalls[0].task;
      expect(round1Payload).toContain("RECOVERED_RETRY_TEXT");
      expect(round1Payload).not.toContain("FIRST_ATTEMPT_TEXT_NOT_TO_LEAK");
    } finally {
      dispose();
    }
  });

  it("retry attempts are recorded to the transcript under `developer-impl-retry-${milestoneId}-${attempt}`", async () => {
    const { root, slug, dispose } = makeRepoSequential();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          // Force one retry that succeeds.
          const cwd = task.cwd ?? root;
          if (!task.task.match(/Retry/)) return fakeRun("first attempt");
          writeFileSync(path.join(cwd, "m1.txt"), `recovered\n`);
          spawnSync("git", ["add", "m1.txt"], { cwd });
          return fakeRun("retry stage");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          slug,
          mode: "single-milestone",
          useWorktree: true,
          branchPrefix: "impl/",
          verifyCommand: false,
          pauseBetweenMilestones: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({ parallel: { enabled: false } }), toolName: "sf_team_implement" },
      );
      expect(result.milestones[0].approved).toBe(true);
      // Read the transcript folder; it lives under ai_plan/<slug>/transcript-* by orchestrator convention.
      // Look for an entry whose label starts with developer-impl-retry-M1-1.
      const fs = await import("node:fs/promises");
      const planFolder = planFolderPath(root, slug);
      const items = await fs.readdir(path.join(planFolder, "transcript", "implementation")).catch(() => [] as string[]);
      const retryEntry = items.find((name) => name.includes("developer-impl-retry-M1-1"));
      expect(retryEntry, `expected a developer-impl-retry-M1-1 entry under transcript; got ${items.join(", ")}`).toBeDefined();
    } finally {
      dispose();
    }
  });
});

describe("S-M31 auto-side empty_diff_retries overrides reach implement via verificationDefaultsForAutoImplement", () => {
  it("auto.empty_diff_retries=0 short-circuits the retry loop in the inner implement call", async () => {
    // Direct unit-style coverage: auto.ts maps auto.* config onto the implement.*
    // surface via verificationDefaultsForAutoImplement. We verify the mapping
    // here so the auto path's retry budget knob actually reaches implement.
    const { verificationDefaultsForAutoImplement } = await import("../src/tools/verification-stage");
    const baseDefaults = resolveDefaults({
      auto: { empty_diff_retries: 0, empty_diff_retry_model: "claude-opus-4-7" },
      implement: { empty_diff_retries: 5, empty_diff_retry_model: "claude-haiku-4-5" },
    });
    const autoDefaults = verificationDefaultsForAutoImplement(baseDefaults);
    expect(autoDefaults.implement.empty_diff_retries).toBe(0);
    expect(autoDefaults.implement.empty_diff_retry_model).toBe("claude-opus-4-7");
  });
});

describe("S-M36 parallel-story empty-diff retry", () => {
  it("retry-exhaustion at the parallel-story site: all dev attempts stage nothing → EmptyDiffError", async () => {
    const { root, slug, dispose } = makeRepoParallel();
    try {
      const developerCalls: number[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, _task: AgentTask) => {
        if (member.role === "developer") {
          developerCalls.push(developerCalls.length + 1);
          return fakeRun("staged nothing");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      let caught: unknown;
      try {
        await tool(
          {
            slug,
            mode: "all-milestones",
            useWorktree: true,
            branchPrefix: "impl/",
            verifyCommand: false,
            pauseBetweenMilestones: false,
          },
          {
            repoRoot: root,
            configDefaults: resolveDefaults({ parallel: { max_milestones: 1, max_stories_per_milestone: 2 }, implement: { empty_diff_retries: 1 } }),
            toolName: "sf_team_implement",
          },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EmptyDiffError);
      const e = caught as EmptyDiffError;
      expect(e.details.milestoneId).toBe("M1");
      // Either S-101 or S-102 will surface first (Promise.allSettled order); both are valid.
      expect([
        "S-101",
        "S-102",
      ]).toContain(e.details.storyId);
      // 1 initial + 1 retry = 2 attempts at the story lane.
      expect(e.details.attempts).toBe(2);
      // Two stories run in parallel; each tries 1 initial + 1 retry. So we should see at least 4 developer spawns total.
      expect(developerCalls.length).toBeGreaterThanOrEqual(4);
    } finally {
      dispose();
    }
  });
});
