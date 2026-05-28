import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { createSfTeamImplement } from "../src/tools/implement";
import { createSfTeamTask } from "../src/tools/task";
import { createSfTeamAuto } from "../src/tools/auto";
import { createSfTeamFollowup } from "../src/tools/followup";
import { writePlanFolder } from "../src/plan/write";
import { slugify } from "../src/plan/slug";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

/**
 * Live tool smoke: exercises every sf_team_* tool through ALL production
 * code paths short of the actual `pi --mode json` subprocess. Each tool is
 * invoked with a real tmp git repo, real lock acquisition, real plan-folder
 * write, real worktree (where applicable), real commit, real pr-description.
 *
 * Agent spawns are stubbed so no external API calls happen — the stub
 * returns the deterministic content each role needs to drive the workflow
 * forward.
 *
 * Asserts each tool returns a non-empty, schema-shaped result. No swallowed
 * failures.
 */

const APPROVED_BODY = `## Summary
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

const PLAN_BODY = `# Plan

## Goal
Add a /healthz endpoint.

## Architecture
Tiny — one route, one test.

## Tech stack
- ts

## Milestones

### M0: Add /healthz endpoint that returns {ok:true}

**Description:** Build the route.

**Stories:**
- **S-001 — Write failing test.** Author the failing test first.
- **S-002 — Implement route.** Make the test pass.

## Risks
None.`;

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-live-smoke-"));
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

function makeSpawnAgent(opts: {
  plannerOutputs?: string[];
  developerOutputs?: string[];
  reviewerOutputs?: string[];
  /** Side-effect: when developer fires, write+stage a small change so impl-review has a diff. */
  cwdForDeveloper?: () => string;
} = {}) {
  let pIdx = 0;
  let dIdx = 0;
  let rIdx = 0;
  return vi.fn(async (member: TeamMember, task: AgentTask) => {
    if (member.role === "planner") {
      const out = opts.plannerOutputs?.[pIdx++] ?? PLAN_BODY;
      return fakeRun(out);
    }
    if (member.role === "developer") {
      const out = opts.developerOutputs?.[dIdx++] ?? "developer made changes";
      const cwd = opts.cwdForDeveloper?.() ?? task.cwd ?? process.cwd();
      // Make a real change so the impl-review loop has a non-empty staged diff.
      const target = path.join(cwd, `dev-touch-${dIdx}.md`);
      writeFileSync(target, `developer round ${dIdx}\n`);
      spawnSync("git", ["add", `dev-touch-${dIdx}.md`], { cwd });
      return fakeRun(out);
    }
    // reviewer
    const out = opts.reviewerOutputs?.[rIdx++] ?? APPROVED_BODY;
    return fakeRun(out);
  });
}

describe("live-tool-smoke: all 5 sf_team_* tools through production code paths", () => {
  it("sf_team_plan writes a 5-file plan folder and returns approved=true", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = makeSpawnAgent();
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool({ title: "Healthz Endpoint", brief: "Add a /healthz endpoint that returns ok=true" }, { repoRoot: root });
      expect(result.approved).toBe(true);
      expect(result.rounds).toBeGreaterThan(0);
      expect(result.folderPath).toBeTruthy();
      const folder = result.folderPath!;
      // Five files all present:
      for (const name of ["original-plan.md", "milestone-plan.md", "story-tracker.md", "continuation-runbook.md", "final-transcript.md"]) {
        const body = readFileSync(path.join(folder, name), "utf8");
        expect(body.length).toBeGreaterThan(0);
      }
    } finally {
      dispose();
    }
  });

  it("sf_team_task plans, implements, verifies (skipped), reviews, and commits", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = makeSpawnAgent({ cwdForDeveloper: () => root });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Add Healthz", brief: "Add a /healthz endpoint that returns ok=true", verifyCommand: false, allowDirty: true },
        { repoRoot: root },
      );
      expect(result.approved).toBe(true);
      expect(result.commitSha).toBeTruthy();
      expect(result.pushed).toBe(false);
      // Commit landed on main
      const log = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf8" }).stdout;
      expect(log).toMatch(/feat\(.*\): Add Healthz/);
    } finally {
      dispose();
    }
  });

  it("sf_team_implement reads a 5-file plan and implements the milestones (worktree off for the harness)", async () => {
    const { root, dispose } = makeRepo();
    try {
      // Pre-write a 5-file plan folder with a single milestone.
      const slug = "implement-target";
      await writePlanFolder(root, {
        kind: "five-file",
        slug,
        files: {
          "original-plan.md": PLAN_BODY,
          "milestone-plan.md": PLAN_BODY,
          "story-tracker.md": "# Story Tracker\n\n## Milestones\n\n### M0: Add /healthz\n\n| Story | Description | Status | Notes |\n|-------|-------------|--------|-------|\n| S-001 | Add healthz | pending | |\n\n**Approval Status:** pending\n",
          "continuation-runbook.md": "see milestone-plan.md\n",
          "final-transcript.md": "n/a\n",
        },
      });
      const cwdRef = { cwd: root };
      const spawnAgent = makeSpawnAgent({ cwdForDeveloper: () => cwdRef.cwd });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { slug, useWorktree: false, verifyCommand: false, mode: "all-milestones" },
        { repoRoot: root },
      );
      expect(result.milestones.length).toBeGreaterThan(0);
      expect(result.milestones[0].approved).toBe(true);
      expect(result.milestones[0].commitSha).toBeTruthy();
      expect(result.prDescriptionPath).toBeTruthy();
    } finally {
      dispose();
    }
  });

  it("sf_team_auto chains plan + implement", async () => {
    const { root, dispose } = makeRepo();
    try {
      // No cwdForDeveloper override — implement spawns developer with task.cwd
      // set to the worktree path; makeSpawnAgent honors that.
      const spawnAgent = makeSpawnAgent();
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamAuto({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Auto Healthz", brief: "Add a /healthz endpoint that returns ok=true", verifyCommand: false },
        { repoRoot: root },
      );
      expect(result.planRounds).toBeGreaterThan(0);
      expect(result.implement.milestones.length).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });

  it("sf_team_followup forks from an existing parent plan and adds an overlay", async () => {
    const { root, dispose } = makeRepo();
    try {
      // Pre-create a parent plan folder + commit so the followup can fork.
      const parentSlug = slugify("Parent Plan");
      await writePlanFolder(root, {
        kind: "five-file",
        slug: parentSlug,
        files: {
          "original-plan.md": PLAN_BODY,
          "milestone-plan.md": PLAN_BODY,
          "story-tracker.md": "# Story Tracker\n\n## Milestones\n\n### M0: Already done\n\n| Story | Description | Status | Notes |\n|-------|-------------|--------|-------|\n| S-001 | first | completed | abc1234 |\n\n**Approval Status:** approved (abc1234)\n",
          "continuation-runbook.md": "n/a\n",
          "final-transcript.md": "n/a\n",
        },
      });
      // Create an `implement/<parentSlug>` branch so createWorktree has a base.
      spawnSync("git", ["checkout", "-q", "-b", `implement/${parentSlug}`], { cwd: root });
      writeFileSync(path.join(root, "src.ts"), "x\n");
      spawnSync("git", ["add", "src.ts"], { cwd: root });
      spawnSync("git", ["commit", "-q", "-m", "parent landed"], { cwd: root });
      spawnSync("git", ["checkout", "-q", "main"], { cwd: root });

      const cwdRef: { cwd: string } = { cwd: root };
      const spawnAgent = makeSpawnAgent({
        plannerOutputs: ["follow-up plan body"],
        cwdForDeveloper: () => cwdRef.cwd,
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamFollowup({ spawnAgent: spawnAgent as never, runReviewLoop });
      // Followup tool will create a new worktree and switch developer cwd into it.
      // We capture cwd via the developer task's `cwd` field since makeSpawnAgent
      // already supports task.cwd as the source of truth for staging.
      const result = await tool(
        {
          title: "tighten openapi",
          parentPlan: parentSlug,
          allowDirty: true,
          verifyCommand: false,
        },
        { repoRoot: root },
      );
      expect(result.approved).toBe(true);
      expect(result.commitSha).toBeTruthy();
      // Followup writes its own plan folder under
      // ai_plan/<date>-followup-<title-kebab>/ — no overlay file in the
      // parent's folder anymore.
      expect(result.slug).toMatch(/^\d{4}-\d{2}-\d{2}-followup-tighten-openapi$/);
    } finally {
      dispose();
    }
  });
});
