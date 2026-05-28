import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { resolveDefaults } from "../src/config/load";
import { parseReviewerVerdict } from "../src/review/parse";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { validPlanText } from "./helpers/valid-plan";

const REVISE_TEXT = `## Summary
fix
## Findings
### P0
- needs more architecture detail
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: REVISE`;

const APPROVED_TEXT = `## Summary
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
  const root = mkdtempSync(path.join(tmpdir(), "ct-plan-rf-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  mkdirSync(path.join(root, "ai_plan"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeRun(finalText: string): AgentRun {
  return {
    state: "completed",
    pid: 1,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: 0,
    finalText,
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    stderrTail: "",
  };
}

describe("M10 sf_team_plan plan-revise-forwarding (S-A01)", () => {
  it("the planner is re-spawned on REVISE; the second reviewer call sees the revised plan", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      // Planner outputs must satisfy the M1 plan-shape validators
      // (length >= 200, real milestones, real stories) — bare placeholders
      // like "draft v1" would now throw EmptyPlanError before the
      // test's assertions run. The validPlanText helper embeds the label
      // so the v1-vs-v2 distinction is preserved.
      const plannerOutputs = [validPlanText("v1"), validPlanText("v2-revised")];
      let plannerCallIdx = 0;
      const reviewerOutputs = [REVISE_TEXT, APPROVED_TEXT];
      let reviewerCallIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") {
          return fakeRun(plannerOutputs[Math.min(plannerCallIdx++, plannerOutputs.length - 1)]);
        }
        return fakeRun(reviewerOutputs[Math.min(reviewerCallIdx++, reviewerOutputs.length - 1)]);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Test Plan", brief: "do thing", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "full", researcher: "never" } } as never) },
      );
      expect(result.approved).toBe(true);
      expect(result.rounds).toBe(2);

      // Reviewer sees the REVISED plan on round 2 (load-bearing assertion).
      const reviewerCalls = captured.filter((c) => c.member.role === "reviewer");
      expect(reviewerCalls).toHaveLength(2);
      expect(reviewerCalls[0].task.task).toContain("v1");
      expect(reviewerCalls[1].task.task).toContain("v2-revised");

      // Planner is re-spawned with the prior plan + findings.
      const plannerCalls = captured.filter((c) => c.member.role === "planner");
      expect(plannerCalls).toHaveLength(2);
      expect(plannerCalls[1].task.task).toContain("Prior plan");
      expect(plannerCalls[1].task.task).toContain("v1");
      expect(plannerCalls[1].task.task).toMatch(/architecture detail/);
    } finally {
      dispose();
    }
  });

  it("no-op patch revisions fail before a second reviewer round", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const noChangePatch = JSON.stringify({
        operations: [
          {
            op: "replace_within_section",
            target: { topLevelHeading: "Architecture" },
            anchor: "sample architecture text",
            body: "sample architecture text",
          },
        ],
      });
      const plannerOutputs = [validPlanText("noop-loop"), noChangePatch];
      let plannerCallIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") {
          return fakeRun(plannerOutputs[Math.min(plannerCallIdx++, plannerOutputs.length - 1)]);
        }
        return fakeRun(REVISE_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await expect(
        tool(
          { title: "Noop Patch Plan", brief: "do thing", analysisOverride: null, answersOverride: {} },
          { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "patch", researcher: "never" } } as never) },
        ),
      ).rejects.toThrow(/patch produced no changes/);

      expect(captured.filter((c) => c.member.role === "reviewer")).toHaveLength(1);
      expect(captured.filter((c) => c.member.role === "planner")).toHaveLength(2);
    } finally {
      dispose();
    }
  });

  it("approves on first round when reviewer returns APPROVED immediately (no revise)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        return fakeRun(member.role === "planner" ? validPlanText("shipping") : APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Quick Plan", analysisOverride: null, answersOverride: {} },
        { repoRoot: root },
      );
      expect(result.approved).toBe(true);
      expect(result.rounds).toBe(1);
      expect(spawnAgent).toHaveBeenCalledTimes(2); // 1 planner + 1 reviewer (researcher skipped via override)
    } finally {
      dispose();
    }
  });

  it("verdict parser end-to-end: same shape produced by parseReviewerVerdict", () => {
    expect(parseReviewerVerdict(APPROVED_TEXT).verdict).toBe("APPROVED");
    expect(parseReviewerVerdict(REVISE_TEXT).verdict).toBe("REVISE");
  });

  it("default reviewer member has heartbeatMs=600_000 (per-role default from DEFAULT_CONFIG)", async () => {
    const { root, dispose } = makeRepo();
    try {
      let observedReviewer: TeamMember | undefined;
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "reviewer") observedReviewer = member;
        return fakeRun(member.role === "planner" ? validPlanText("hb-default") : APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool({ title: "Hb Default" }, { repoRoot: root });
      // Reviewer's heartbeatMs reaches the production runtime — fixes the
      // dead-code regression codex flagged in round 1 of this patch.
      expect(observedReviewer?.heartbeatMs).toBe(600_000);
    } finally {
      dispose();
    }
  });
});
