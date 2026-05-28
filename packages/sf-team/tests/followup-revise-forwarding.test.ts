import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamFollowup } from "../src/tools/followup";
import { resolveDefaults } from "../src/config/load";
import { planFolderPath } from "../src/plan/paths";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

const REVISE_TEXT_PLAN = `## Summary
plan needs more
## Findings
### P0
- list test cases
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: REVISE`;

const REVISE_TEXT_IMPL = `## Summary
diff missing tests
## Findings
### P0
- add unit test
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

function makeRepoWithParentPlan(): { root: string; parentSlug: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-followup-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const parentSlug = "2026-04-01-parent";
  const folder = planFolderPath(root, parentSlug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "milestone-plan.md"), "# Parent Plan\n## M0\n- S-001: bootstrap\n");
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M0: bootstrap

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | bootstrap | completed | abc123 |

**Approval Status:** approved
`,
  );
  // Plant a pr-description.md so the test that asserts the parent's
  // pr-description is NOT mutated by followup has something to compare.
  writeFileSync(
    path.join(folder, "pr-description.md"),
    "# Parent\n\n## Summary\nDone.\n\n## Changes\n- init\n",
  );
  return { root, parentSlug, dispose: () => rmSync(root, { recursive: true, force: true }) };
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

describe("M12 sf_team_followup plan-revise-forwarding (S-C05)", () => {
  it("planner re-spawned on plan-review REVISE; second reviewer call sees revised followup plan", async () => {
    const { root, parentSlug, dispose } = makeRepoWithParentPlan();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      // Plan reviewer: REVISE then APPROVE; impl reviewer: APPROVE.
      const reviewerOutputs = [REVISE_TEXT_PLAN, APPROVED_TEXT, APPROVED_TEXT];
      let rIdx = 0;
      const plannerOutputs = ["followup plan v1", "followup plan v2-revised"];
      let pIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun(plannerOutputs[Math.min(pIdx++, plannerOutputs.length - 1)]);
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, "feat.ts"), "// fix\n");
          spawnSync("git", ["add", "feat.ts"], { cwd });
          return fakeRun("dev prose");
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamFollowup({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          title: "Fix Edge Case",
          parentPlan: parentSlug,
          allowDirty: true,
          verifyCommand: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "full" } } as never) },
      );
      expect(result.approved).toBe(true);
      expect(result.rounds.plan).toBe(2);
      // Followup now writes its own plan folder, slugged
      // <date>-followup-<title-kebab> (no overlay file in the parent).
      expect(result.slug).toMatch(/^\d{4}-\d{2}-\d{2}-followup-fix-edge-case$/);

      const plannerCalls = captured.filter((c) => c.member.role === "planner");
      expect(plannerCalls).toHaveLength(2);
      // Revise carries the prior followup plan + findings.
      expect(plannerCalls[1].task.task).toContain("followup plan v1");
      expect(plannerCalls[1].task.task).toContain("list test cases");
      // Reviewer round 2 sees revised plan.
      const reviewerPlanCalls = captured.filter(
        (c) => c.member.role === "reviewer" && c.task.task.includes("followup plan"),
      );
      expect(reviewerPlanCalls[1].task.task).toContain("followup plan v2-revised");
    } finally {
      dispose();
    }
  });

  it("default patch mode applies planner patch before the second followup plan-review call", async () => {
    const { root, parentSlug, dispose } = makeRepoWithParentPlan();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const patch = JSON.stringify({
        operations: [
          {
            op: "replace_within_section",
            target: { topLevelHeading: "Followup" },
            anchor: "old followup detail",
            body: "patched followup detail",
          },
        ],
      });
      const plannerOutputs = ["## Followup\nold followup detail\n", patch];
      let pIdx = 0;
      const reviewerOutputs = [REVISE_TEXT_PLAN, APPROVED_TEXT, APPROVED_TEXT];
      let rIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun(plannerOutputs[Math.min(pIdx++, plannerOutputs.length - 1)]);
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, "feat.ts"), "// fix\n");
          spawnSync("git", ["add", "feat.ts"], { cwd });
          return fakeRun("dev prose");
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamFollowup({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          title: "Patch Followup Plan",
          parentPlan: parentSlug,
          allowDirty: true,
          verifyCommand: false,
        },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "patch" } } as never) },
      );

      expect(result.approved).toBe(true);
      expect(result.rounds.plan).toBe(2);
      expect(captured.filter((c) => c.member.role === "planner")).toHaveLength(2);
      const reviewerPlanCalls = captured.filter(
        (c) => c.member.role === "reviewer" && c.task.task.includes("followup plan"),
      );
      expect(reviewerPlanCalls[1].task.task).toContain("patched followup detail");
    } finally {
      dispose();
    }
  });
});

describe("M12 sf_team_followup impl-revise-forwarding (S-C05)", () => {
  it("developer re-spawned on impl-review REVISE; second reviewer call sees the new staged diff", async () => {
    const { root, parentSlug, dispose } = makeRepoWithParentPlan();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      // Plan reviewer: APPROVE; impl reviewer: REVISE then APPROVE.
      const reviewerOutputs = [APPROVED_TEXT, REVISE_TEXT_IMPL, APPROVED_TEXT];
      let rIdx = 0;
      let dIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun("the plan");
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          const body = dIdx === 0 ? "// followup v1\n" : "// followup v2 with tests\n";
          writeFileSync(path.join(cwd, "feat.ts"), body);
          spawnSync("git", ["add", "feat.ts"], { cwd });
          dIdx += 1;
          return fakeRun("dev prose");
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamFollowup({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          title: "Add Coverage",
          parentPlan: parentSlug,
          allowDirty: true,
          verifyCommand: false,
        },
        { repoRoot: root },
      );
      expect(result.approved).toBe(true);
      expect(result.rounds.impl).toBe(2);

      // Impl reviewer prompts are now SUMMARY-based: dev finalText
      // ("dev prose") + diff stat (referencing feat.ts), NOT the raw
      // diff content. Round-1 prompt has a "Review the implementation
      // of this followup" lead-in; round-2 verify-fixes prompt has an
      // "ORIGINAL IMPLEMENTATION SUMMARY" anchor section. Both contain
      // "feat.ts" via the stat, which is the safest filter.
      const implReviewerCalls = captured.filter(
        (c) =>
          c.member.role === "reviewer" &&
          (c.task.task.includes("Review the implementation of this followup") ||
            c.task.task.includes("ORIGINAL IMPLEMENTATION SUMMARY")),
      );
      expect(implReviewerCalls).toHaveLength(2);
      // Both rounds: stat references feat.ts, narrative present, raw
      // diff body absent.
      expect(implReviewerCalls[0].task.task).toContain("dev prose");
      expect(implReviewerCalls[0].task.task).toContain("feat.ts");
      expect(implReviewerCalls[0].task.task).not.toContain("// followup v1");
      expect(implReviewerCalls[1].task.task).toContain("dev prose");
      expect(implReviewerCalls[1].task.task).not.toContain("// followup v2 with tests");
    } finally {
      dispose();
    }
  });
});

describe("M12 sf_team_followup writes its own plan folder (post-overlay refactor)", () => {
  it("creates ai_plan/<date>-followup-<slug>/task-plan.md and does NOT mutate the parent's pr-description", async () => {
    const { root, parentSlug, dispose } = makeRepoWithParentPlan();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "planner") return fakeRun("# Followup Plan\n");
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, "x.ts"), "// x\n");
          spawnSync("git", ["add", "x.ts"], { cwd });
          return fakeRun("dev");
        }
        return fakeRun(APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamFollowup({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          title: "Polish UX",
          parentPlan: parentSlug,
          allowDirty: true,
          verifyCommand: false,
        },
        { repoRoot: root },
      );
      expect(result.approved).toBe(true);
      // Followup now writes its own plan folder; slug carries the
      // followup- prefix.
      expect(result.slug).toMatch(/^\d{4}-\d{2}-\d{2}-followup-polish-ux$/);

      const fs = await import("node:fs");
      // task-plan.md lives under the followup's own folder.
      const followupFolder = planFolderPath(root, result.slug);
      expect(fs.existsSync(path.join(followupFolder, "task-plan.md"))).toBe(true);
      // No overlay file in the parent's folder.
      const parentEntries = fs.readdirSync(planFolderPath(root, parentSlug));
      expect(parentEntries.some((n) => /^followup-/.test(n))).toBe(false);
      // Parent pr-description must be untouched (no `## Follow-ups`
      // injection any more).
      const parentPrBody = fs.readFileSync(
        path.join(planFolderPath(root, parentSlug), "pr-description.md"),
        "utf8",
      );
      expect(parentPrBody).not.toMatch(/## Follow-ups/);
      expect(parentPrBody).toContain("# Parent");
    } finally {
      dispose();
    }
  });
});
