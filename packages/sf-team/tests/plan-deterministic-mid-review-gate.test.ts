import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { resolveDefaults } from "../src/config/load";
import { slugify } from "../src/plan/slug";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { validPlanText } from "./helpers/valid-plan";

// Plan body with a deterministic write-set CONFLICT: M0-W1 schedules S-001
// and S-002 in parallel, but both writeSets point at the same file. The
// deterministic conflict check at `src/plan/execution-strategy.ts:480`
// throws "Unsafe write set conflict ... both include ...".
function conflictPlanText(label: string): string {
  return validPlanText(label).replace(
    /```json\n[\s\S]*?\n```/,
    `\`\`\`json
{
  "version": 1,
  "maxParallelMilestones": 1,
  "maxParallelStoriesPerMilestone": 2,
  "milestoneWaves": [
    { "id": "W1", "milestones": ["M0"], "maxParallel": 1 },
    { "id": "W2", "milestones": ["M1"], "dependsOn": ["W1"], "maxParallel": 1 }
  ],
  "stories": {
    "M0": {
      "maxParallelStories": 2,
      "storyWaves": [
        {
          "id": "M0-W1",
          "stories": ["S-001", "S-002"],
          "maxParallel": 2,
          "writeSets": {
            "S-001": ["packages/sf-team/src/${label}-shared.ts"],
            "S-002": ["packages/sf-team/src/${label}-shared.ts"]
          }
        }
      ]
    },
    "M1": {
      "storyWaves": [
        {
          "id": "M1-W1",
          "stories": ["S-101"],
          "writeSets": {
            "S-101": ["packages/sf-team/src/${label}-core.ts"]
          }
        }
      ]
    }
  }
}
\`\`\``,
  );
}

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

const REVISE_BODY = `## Summary
needs work
## Findings
### P0
- need more detail
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: REVISE`;

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-gate-"));
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

describe("sf_team_plan deterministic mid-review gate", () => {
  it("success path: gate fires after a reviewer-driven revision, planner self-revises once, gate-passed plan reaches the next reviewer round", async () => {
    const { root, dispose } = makeRepo();
    try {
      let plannerIdx = 0;
      let reviewerIdx = 0;
      const planner: { args: AgentTask[]; plans: string[] } = { args: [], plans: [] };
      const reviewerPayloads: string[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, t: AgentTask) => {
        if (member.role === "researcher") {
          // Researcher will be skipped by `performance.researcher: never`.
          return fakeRun("{}");
        }
        if (member.role === "planner") {
          plannerIdx += 1;
          planner.args.push(t);
          // Sequence:
          //   1. initial draft (no conflict) → passes pre-review gate
          //   2. round-1 revision (conflict introduced)
          //   3. gate's self-revision (conflict fixed)
          const out =
            plannerIdx === 1
              ? validPlanText("draft")
              : plannerIdx === 2
              ? conflictPlanText("conflict-introduced")
              : validPlanText("gate-fixed");
          planner.plans.push(out);
          return fakeRun(out);
        }
        // reviewer — capture the task body so we can assert WHICH plan it
        // received (gate-fixed vs conflicted) per impl-review round-1 P3.
        reviewerIdx += 1;
        reviewerPayloads.push(t.task);
        return fakeRun(reviewerIdx === 1 ? REVISE_BODY : APPROVED_BODY);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Gate Success", brief: "go", analysisOverride: null, answersOverride: {}, maxRounds: 2 },
        {
          repoRoot: root,
          ui: {
            select: async () => undefined,
            input: async () => "go",
            confirm: async () => true,
            notify: () => undefined,
          } as never,
          configDefaults: resolveDefaults({ performance: { plan_revision: "full", researcher: "never" } } as never),
        },
      );
      expect(result.approved).toBe(true);

      // Three planner spawns: draft + round-1 revision + gate self-revision.
      expect(plannerIdx).toBe(3);
      // Two reviewer spawns: round-1 REVISE + round-2 APPROVED. The gate
      // does NOT add a reviewer call.
      expect(reviewerIdx).toBe(2);

      const folder = path.join(root, "ai_plan", slugify("Gate Success"), "transcript", "planning");
      const files = readdirSync(folder).sort();
      // Gate transcript labels appear (round 1, success path). The
      // composer auto-appends `-round-N` to records that pass `round:`,
      // so the planner-revision file ends in `-revision-round-1.md`.
      expect(files.some((f) => /system-deterministic-mid-review-round-1-REVISE\.md$/.test(f))).toBe(true);
      expect(files.some((f) => /planner-deterministic-mid-review-round-1-revision-round-1\.md$/.test(f))).toBe(true);
      expect(files.some((f) => /system-deterministic-mid-review-round-1-OK-OK\.md$/.test(f))).toBe(true);
      // No "still-failing" label on the success path.
      expect(files.some((f) => /still-failing/.test(f))).toBe(false);
      // Reviewer round 1 REVISE recorded, round 2 APPROVED recorded.
      expect(files.some((f) => /reviewer-review-round-1-REVISE\.md$/.test(f))).toBe(true);
      expect(files.some((f) => /reviewer-review-round-2-APPROVED\.md$/.test(f))).toBe(true);

      // The pre-gate REVISE file mentions the conflict.
      const gateFinding = readFileSync(
        path.join(folder, files.find((f) => /system-deterministic-mid-review-round-1-REVISE\.md$/.test(f))!),
        "utf8",
      );
      expect(gateFinding).toMatch(/Unsafe write set conflict|conflict.*both include/i);

      // Reviewer round 2 receives the GATE-FIXED plan, NOT the conflicted
      // one (per impl-review round-1 P3). Two reviewer payloads total.
      expect(reviewerPayloads.length).toBe(2);
      expect(reviewerPayloads[0]).toContain("draft");
      expect(reviewerPayloads[1]).toContain("gate-fixed");
      expect(reviewerPayloads[1]).not.toContain("conflict-introduced");
    } finally {
      dispose();
    }
  });

  it("still-failing path: gate makes AT MOST ONE planner self-revision; if it still fails, the gate returns the still-bad plan and records a still-failing transcript entry", async () => {
    const { root, dispose } = makeRepo();
    try {
      let plannerIdx = 0;
      let reviewerIdx = 0;
      const reviewerPayloads: string[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, t: AgentTask) => {
        if (member.role === "researcher") return fakeRun("{}");
        if (member.role === "planner") {
          plannerIdx += 1;
          // Sequence:
          //   1. initial draft (clean) → pre-review gate passes
          //   2. round-1 revision (conflict introduced)
          //   3. gate's self-revision (STILL conflict — same body)
          //   ... no further planner calls. Gate is strictly non-recursive.
          if (plannerIdx === 1) return fakeRun(validPlanText("draft"));
          return fakeRun(conflictPlanText(`conflict-${plannerIdx}`));
        }
        // reviewer — capture payloads per impl-review round-1 P3.
        reviewerIdx += 1;
        reviewerPayloads.push(t.task);
        return fakeRun(reviewerIdx === 1 ? REVISE_BODY : APPROVED_BODY);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      // With maxRounds=2:
      //   - round 1: reviewer REVISE → revise() called → spawn 2 → gate
      //     fires → spawn 3 (still conflict) → gate records still-failing
      //     and returns the still-bad plan to the reviewer.
      //   - round 2: reviewer APPROVES the still-bad plan (per stub) →
      //     the existing post-approval strategy gate detects the conflict
      //     but rounds are exhausted (roundNum >= maxRounds), so the
      //     APPROVED verdict stays and the workflow continues with a
      //     fallback artifact + warning. No further planner calls.
      await tool(
        { title: "Gate StillFailing", brief: "go", analysisOverride: null, answersOverride: {}, maxRounds: 2 },
        {
          repoRoot: root,
          ui: {
            select: async () => undefined,
            input: async () => "go",
            confirm: async () => true,
            notify: () => undefined,
          } as never,
          configDefaults: resolveDefaults({ performance: { plan_revision: "full", researcher: "never" } } as never),
        },
      );

      // Three planner spawns: draft + round-1 revision + gate self-revision.
      // CRITICAL: the gate must NOT call the planner a fourth time even
      // though the self-revision left the conflict in place.
      expect(plannerIdx).toBe(3);
      // Reviewer round 2 still runs (the gate handed the still-bad plan to
      // it), so reviewer is called twice in total (or one — depends on whether
      // the legacy post-approval strategy gate then kicks in; we just assert
      // the planner cap held).
      expect(reviewerIdx).toBeGreaterThanOrEqual(1);

      const folder = path.join(root, "ai_plan", slugify("Gate StillFailing"), "transcript", "planning");
      const files = readdirSync(folder).sort();
      expect(files.some((f) => /system-deterministic-mid-review-round-1-REVISE\.md$/.test(f))).toBe(true);
      expect(files.some((f) => /planner-deterministic-mid-review-round-1-revision-round-1\.md$/.test(f))).toBe(true);
      // Still-failing label present, OK label absent. The composer
      // appends `-REVISE` to records with status: "REVISE", so the
      // still-failing file's full suffix is `-still-failing-REVISE.md`.
      expect(files.some((f) => /system-deterministic-mid-review-round-1-still-failing-REVISE\.md$/.test(f))).toBe(true);
      expect(files.some((f) => /system-deterministic-mid-review-round-1-OK-OK\.md$/.test(f))).toBe(false);

      // Reviewer round 2 receives the STILL-BAD plan (per impl-review
      // round-1 P3) — the gate is observable but did NOT magically
      // produce a clean plan, and it did NOT silently drop the plan.
      expect(reviewerPayloads.length).toBe(2);
      expect(reviewerPayloads[0]).toContain("draft");
      expect(reviewerPayloads[1]).toMatch(/conflict-\d+/);
    } finally {
      dispose();
    }
  });
});
