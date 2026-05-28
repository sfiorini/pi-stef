import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { resolveDefaults } from "../src/config/load";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { validPlanText } from "./helpers/valid-plan";

const APPROVED_WITH_P3 = `## Summary
ok modulo cosmetic
## Findings
### P0
- None.
### P1
- None.
### P2
- None.
### P3
- Inconsistent heading style on M1 (would be nice to align).
## Verdict
VERDICT: APPROVED`;

const APPROVED_CLEAN = `## Summary
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
  const root = mkdtempSync(path.join(tmpdir(), "ct-p3-"));
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

describe("P3-only one-more-pass (architecture step 7)", () => {
  it("when reviewer returns APPROVED with non-empty P3, planner gets ONE more revise pass; reviewer is NOT invoked again", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      let plannerIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, t: AgentTask) => {
        captured.push({ member, task: t });
        if (member.role === "planner") {
          plannerIdx += 1;
          return fakeRun(validPlanText(`v${plannerIdx}`));
        }
        // reviewer always returns APPROVED with P3
        return fakeRun(APPROVED_WITH_P3);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "P3 only", brief: "go", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "full", researcher: "never" } } as never) },
      );
      expect(result.approved).toBe(true);
      // Sequence: planner-1 (initial draft), reviewer-1 (APPROVED+P3), planner-2 (P3 fixup) — STOP.
      const roles = captured.map((c) => c.member.role);
      expect(roles).toEqual(["planner", "reviewer", "planner"]);
      // The second planner call's task references the P3 finding.
      const secondPlanner = captured.filter((c) => c.member.role === "planner")[1];
      expect(secondPlanner.task.task).toMatch(/Inconsistent heading style/);
      // Final plan in the result is the P3-revised draft.
      // The mock planner returns validPlanText("v2") for the second call
      // (after the P3-only fixup pass). Body is multi-line; the label
      // appears in the title and the goal text.
      expect(result.finalPlan).toContain("# Plan: v2");
      expect(result.finalPlan).toContain("Test goal for v2");
    } finally {
      dispose();
    }
  });

  it("when reviewer returns APPROVED with empty P3, NO extra planner pass fires", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        captured.push({ member });
        if (member.role === "planner") return fakeRun(validPlanText("clean-draft"));
        return fakeRun(APPROVED_CLEAN);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { title: "Clean", analysisOverride: null, answersOverride: {} },
        { repoRoot: root },
      );
      const plannerCount = captured.filter((c) => c.member.role === "planner").length;
      expect(plannerCount).toBe(1); // exactly one planner spawn — no P3 fixup pass
    } finally {
      dispose();
    }
  });
});
