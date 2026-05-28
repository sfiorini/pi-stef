import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  composeMilestoneBrief,
  composeMilestoneRevise,
  composeStoryBrief,
  createSfTeamImplement,
} from "../src/tools/implement";
import { planFolderPath } from "../src/plan/paths";
import type { ParsedMilestone, ParsedStory } from "../src/plan/tracker";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

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

const REVISE_TEXT = `## Summary
need work
## Findings
### P0
- needs better tests
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: REVISE`;

const PROMPT_GUARDRAIL_PATTERNS = [
  /rg --files/,
  /current working directory/i,
  /repo\/worktree root/i,
  /do not search above `\.`/i,
  /\/Users/,
] as const;

function expectRepoScopedToolGuardrails(prompt: string): void {
  for (const pattern of PROMPT_GUARDRAIL_PATTERNS) {
    expect(prompt).toMatch(pattern);
  }
}

function makeRepoWithPlanFolder(): {
  root: string;
  slug: string;
  dispose: () => void;
} {
  const root = mkdtempSync(path.join(tmpdir(), "ct-impl-rf-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const slug = "2026-05-01-impl-rf";
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  // Two-milestone plan with one pending story each.
  writeFileSync(
    path.join(folder, "milestone-plan.md"),
    `# Plan\n\n## M0\n- S-001: bootstrap\n\n## M1\n- S-101: feature\n`,
  );
  writeFileSync(
    path.join(folder, "continuation-runbook.md"),
    "# Runbook\n",
  );
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M0: bootstrap

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | bootstrap | pending | |

**Approval Status:** pending

### M1: feature

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | feature | pending | |

**Approval Status:** pending
`,
  );
  return { root, slug, dispose: () => rmSync(root, { recursive: true, force: true }) };
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

describe("M11 sf_team_implement D1 mode revise-forwarding (S-B03)", () => {
  it("developer prompts keep cursor-backed tool use scoped to the current repo/worktree", () => {
    const milestone: ParsedMilestone = {
      id: "M0",
      title: "Guardrails",
      approvalStatus: undefined,
      stories: [{ id: "S-001", description: "change one file", status: "pending", notes: "" }],
    };
    const story: ParsedStory = milestone.stories[0];
    const plan = "## M0: Guardrails\nImplementation details.";

    expectRepoScopedToolGuardrails(composeMilestoneBrief(milestone, plan));
    expectRepoScopedToolGuardrails(composeStoryBrief(milestone, story, ["src/a.ts"], plan));

    const revise = composeMilestoneRevise("M0", "diff --git a/src/a.ts b/src/a.ts", {
      findings: { P0: [], P1: [], P2: ["fix src/a.ts"], P3: [] },
    }, { cwd: "/tmp/sf-team-worktree" });
    expectRepoScopedToolGuardrails(revise);
    expect(revise).toContain("/tmp/sf-team-worktree");
  });

  it("forces REVISE on M0 round 1 → developer re-spawned with prior diff context; second reviewer sees v2 staged diff", async () => {
    const { root, slug, dispose } = makeRepoWithPlanFolder();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      // Plan: M0 reviewer round 1 = REVISE, round 2 = APPROVE; M1 reviewer = APPROVE.
      const reviewerOutputs = [REVISE_TEXT, APPROVED_TEXT, APPROVED_TEXT];
      let rIdx = 0;
      let dIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          const file = path.join(cwd, "feat.ts");
          // Round 0 (M0 first impl) and round 1 (M0 revise) write different content
          // so the staged diff differs round-over-round. Round 2+ are M1's developer.
          const body =
            dIdx === 0
              ? "// M0 v1\n"
              : dIdx === 1
              ? "// M0 v2 — addresses findings\n"
              : "// M1\n";
          writeFileSync(file, body);
          spawnSync("git", ["add", "feat.ts"], { cwd });
          dIdx += 1;
          return fakeRun("dev prose");
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          slug,
          mode: "single-milestone",
          useWorktree: false,
          verifyCommand: false,
          shouldContinue: () => true,
        },
        { repoRoot: root },
      );
      expect(result.milestones).toHaveLength(2);
      expect(result.milestones[0]).toMatchObject({ id: "M0", approved: true, rounds: 2 });
      expect(result.milestones[1]).toMatchObject({ id: "M1", approved: true });

      // Reviewer payloads are SUMMARY-based (dev finalText + diff stat),
      // not raw diff. The dev's finalText is "dev prose" (set by fakeRun).
      // Round 1 prompt: contains "dev prose" and "feat.ts" in the stat.
      // Round 2 prompt: contains the round-1 originalImplSummary verbatim
      // ("dev prose") AND the round-2 currentFixSummary (also "dev prose")
      // — both rounds share the narrative because the test mock returns
      // the same string. Crucially neither prompt embeds the raw file
      // contents `// M0 v1` / `// M0 v2`.
      const reviewerCalls = captured.filter((c) => c.member.role === "reviewer");
      expect(reviewerCalls.length).toBeGreaterThanOrEqual(3);
      expect(reviewerCalls[0].task.task).toContain("dev prose");
      expect(reviewerCalls[0].task.task).toContain("feat.ts");
      expect(reviewerCalls[0].task.task).not.toContain("// M0 v1");
      expect(reviewerCalls[0].task.task).not.toContain("// M0 v2");
      expect(reviewerCalls[1].task.task).toContain("dev prose");
      expect(reviewerCalls[1].task.task).not.toContain("// M0 v1");
      expect(reviewerCalls[1].task.task).not.toContain("// M0 v2");

      // Developer revise still receives the actual prior diff (the user
      // explicitly kept the developer prompts unchanged).
      const developerCalls = captured.filter((c) => c.member.role === "developer");
      expect(developerCalls[1].task.task).toMatch(/M0/);
      expect(developerCalls[1].task.task).toContain("// M0 v1");
    } finally {
      dispose();
    }
  });

  it("D1 user-gate: shouldContinue=false stops after first approved milestone", async () => {
    const { root, slug, dispose } = makeRepoWithPlanFolder();
    try {
      let dIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          writeFileSync(path.join(task.cwd ?? root, `f${dIdx}.ts`), `// ${dIdx}\n`);
          spawnSync("git", ["add", "."], { cwd: task.cwd ?? root });
          dIdx += 1;
          return fakeRun("dev");
        }
        return fakeRun(APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const shouldContinue = vi.fn(() => false);
      const result = await tool(
        { slug, mode: "single-milestone", useWorktree: false, verifyCommand: false, shouldContinue },
        { repoRoot: root },
      );
      expect(result.milestones).toHaveLength(1);
      expect(result.milestones[0].id).toBe("M0");
      expect(shouldContinue).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });
});

describe("M11 sf_team_implement records milestone approval back to story-tracker (P2 fix)", () => {
  it("after a milestone commits, its stories flip to completed in the tracker", async () => {
    const { root, slug, dispose } = makeRepoWithPlanFolder();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, "x.ts"), "// x\n");
          spawnSync("git", ["add", "x.ts"], { cwd });
          return fakeRun("dev");
        }
        return fakeRun(APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      // Stop after M0 so we can verify the partial-progress tracker update.
      const result = await tool(
        {
          slug,
          mode: "single-milestone",
          useWorktree: false,
          verifyCommand: false,
          shouldContinue: () => false,
        },
        { repoRoot: root },
      );
      expect(result.milestones[0]).toMatchObject({ id: "M0", approved: true });
      // Read the tracker AFTER the run; M0's S-001 should now be completed.
      const { parseStoryTracker } = await import("../src/plan/tracker");
      const re = await parseStoryTracker(root, slug);
      const m0 = re.milestones.find((m) => m.id === "M0")!;
      expect(m0.stories[0]).toMatchObject({ id: "S-001", status: "completed" });
      // M1's stories remain pending (we stopped via shouldContinue).
      const m1 = re.milestones.find((m) => m.id === "M1")!;
      expect(m1.stories[0]).toMatchObject({ id: "S-101", status: "pending" });
      // M0's approvalStatus is updated; M1's is not.
      expect(m0.approvalStatus).toMatch(/approved/);
      expect(m1.approvalStatus).not.toMatch(/approved/);
    } finally {
      dispose();
    }
  });
});

describe("M11 sf_team_implement D2 mode revise-forwarding (S-B04)", () => {
  it("D2 runs through milestones without gates; per-milestone revise still re-feeds the new staged diff", async () => {
    const { root, slug, dispose } = makeRepoWithPlanFolder();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      // M0 reviewer round 1 = REVISE, round 2 = APPROVE; M1 reviewer = APPROVE.
      const reviewerOutputs = [REVISE_TEXT, APPROVED_TEXT, APPROVED_TEXT];
      let rIdx = 0;
      let dIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          const body =
            dIdx === 0 ? "// d2 M0 v1\n" : dIdx === 1 ? "// d2 M0 v2\n" : "// d2 M1\n";
          writeFileSync(path.join(cwd, "x.ts"), body);
          spawnSync("git", ["add", "x.ts"], { cwd });
          dIdx += 1;
          return fakeRun("dev prose");
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]);
      });
      // M2 acceptance: in D2 mode, no inter-milestone gate fires when
      // `pauseBetweenMilestones=false` (the default for sf_team_auto and
      // therefore the value the auto wrapper forwards). Use a UI spy to
      // assert no confirm was invoked.
      const ui = {
        confirm: vi.fn(async () => true),
        select: async () => undefined,
        input: async () => "",
        notify: () => undefined,
      } as never;
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          slug,
          mode: "all-milestones",
          useWorktree: false,
          verifyCommand: false,
          pauseBetweenMilestones: false,
        },
        { repoRoot: root, ui },
      );
      expect(result.mode).toBe("all-milestones");
      expect(result.milestones).toHaveLength(2);
      // No inter-milestone gate fired (the production D2/auto behavior).
      expect((ui as { confirm: ReturnType<typeof vi.fn> }).confirm).not.toHaveBeenCalled();
      // M0 round 2 reviewer call must see the SUMMARY (dev finalText +
      // diff stat referencing x.ts), NOT the raw diff content. The
      // round-2 prompt contains the round-1 originalImplSummary verbatim
      // plus the round-2 currentFixSummary, both referencing x.ts via the
      // diff stat — neither embeds the raw `// d2 M0 v2` content.
      const revs = captured.filter((c) => c.member.role === "reviewer");
      expect(revs[1].task.task).toContain("dev prose");
      expect(revs[1].task.task).toContain("x.ts");
      expect(revs[1].task.task).not.toContain("// d2 M0 v2");
      expect(revs[1].task.task).not.toContain("// d2 M0 v1");
    } finally {
      dispose();
    }
  });
});
