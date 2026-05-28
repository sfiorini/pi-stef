import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { applyPlanPatch, PlanPatchError } from "../src/plan/patch";
import { resolveDefaults } from "../src/config/load";
import { createSfTeamPlan } from "../src/tools/plan";
import { slugify } from "../src/plan/slug";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { validPlanText } from "./helpers/valid-plan";

const REVISE_TEXT = `## Summary
fix
## Findings
### P0
- Architecture lacks detail.
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
  const root = mkdtempSync(path.join(tmpdir(), "ct-plan-patch-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "x");
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

describe("plan patch application", () => {
  it("replaces a repeated milestone Stories section through hierarchical targeting", () => {
    const prior = validPlanText("patch");
    const { plan, applied, metrics } = applyPlanPatch(prior, {
      operations: [
        {
          op: "replace_section",
          target: { milestoneId: "M1", section: "Stories" },
          body: "- **S-101 — Add patched thing.** Patched story body.\n",
        },
      ],
    });

    expect(plan).toContain("- **S-101 — Add patched thing.** Patched story body.");
    expect(plan).toContain("- **S-001 — First story for patch.** Body prose for patch.");
    expect(applied).toHaveLength(1);
    expect(applied[0].target).toMatchObject({ milestoneId: "M1", section: "Stories" });
    expect(metrics.patchApplied).toBe(true);
  });

  // Test B coverage (explicit section: "Stories" alongside storyId) — regression
  // anchor for the path the planner WAS using before the patch validator over-strict
  // bug was fixed. Kept passing across the fix.
  it("replaces a single story without touching neighboring stories", () => {
    const prior = validPlanText("story");
    const { plan } = applyPlanPatch(prior, {
      operations: [
        {
          op: "replace_section",
          target: { milestoneId: "M0", section: "Stories", storyId: "S-002" },
          body: "- **S-002 — Patched second story.** Replacement body.\n",
        },
      ],
    });

    expect(plan).toContain("S-001 — First story for story");
    expect(plan).toContain("S-002 — Patched second story");
    expect(plan).not.toContain("S-002 — Second story for story");
  });

  // Test A — load-bearing. The planner naturally emits storyId targets WITHOUT
  // an explicit section. The validator+resolver must accept that shape AND only
  // replace the targeted story body — sibling stories, the milestone wrapper,
  // and other milestones must remain untouched. This test fails today (validator
  // rejects) AND would still fail if only resolveTarget were relaxed without
  // also patching resolveMilestoneTarget (which would resolve to the whole
  // milestone range and destroy S-001 and the description).
  it("auto-infers section=Stories for storyId targets and replaces only the targeted story", () => {
    const prior = validPlanText("auto-infer");
    const { plan } = applyPlanPatch(prior, {
      operations: [
        {
          op: "replace_section",
          target: { milestoneId: "M0", storyId: "S-002" },
          body: "- **S-002 — Replaced body only.** New text.\n",
        },
      ],
    });
    expect(plan).toContain("S-002 — Replaced body only");
    // Sibling story untouched.
    expect(plan).toMatch(/-\s+\*\*S-001\b/);
    // Milestone M0 wrapper preserved (heading + description).
    expect(plan).toMatch(/^### M0:/m);
    expect(plan).toContain("**Description:** Initial scaffolding for auto-infer.");
    // Other milestone (M1) untouched, including its story.
    expect(plan).toMatch(/^### M1:/m);
    expect(plan).toMatch(/-\s+\*\*S-101\b/);
  });

  // Test C — storyId target without milestoneId is unresolvable; reject with
  // the new specific error message so the planner gets actionable feedback if
  // it ever drops the milestoneId.
  it("rejects storyId target without milestoneId", () => {
    const prior = validPlanText("missing-milestone");
    expect(() =>
      applyPlanPatch(prior, {
        operations: [
          { op: "replace_section", target: { storyId: "S-001" }, body: "- **S-001 — x.** y.\n" },
        ],
      }),
    ).toThrow(/storyId targets require milestoneId/);
  });

  // Test D — storyId combined with a non-Stories section is a structural
  // contradiction (stories live only inside the Stories sub-section). Reject
  // with the new specific error message.
  it("rejects storyId combined with a non-Stories section", () => {
    const prior = validPlanText("wrong-section");
    expect(() =>
      applyPlanPatch(prior, {
        operations: [
          {
            op: "replace_section",
            target: { milestoneId: "M0", section: "Description", storyId: "S-001" },
            body: "- **S-001 — x.** y.\n",
          },
        ],
      }),
    ).toThrow(/storyId targets must use section=Stories/);
  });

  it("supports exact-anchor replace and rejects duplicate anchors", () => {
    const prior = validPlanText("anchor");
    const { plan } = applyPlanPatch(prior, {
      operations: [
        {
          op: "replace_within_section",
          target: { topLevelHeading: "Architecture" },
          anchor: "sample architecture text",
          body: "patched architecture text",
        },
      ],
    });
    expect(plan).toContain("patched architecture text");

    expect(() =>
      applyPlanPatch("## Architecture\nsame same\n", {
        operations: [
          {
            op: "replace_within_section",
            target: { topLevelHeading: "Architecture" },
            anchor: "same",
            body: "different",
          },
        ],
      }),
    ).toThrow(PlanPatchError);
  });

  it("rejects missing targets and no-op patches before review advances", () => {
    expect(() =>
      applyPlanPatch(validPlanText("missing"), {
        operations: [{ op: "append_to_section", target: { milestoneId: "M9", section: "Stories" }, body: "- x\n" }],
      }),
    ).toThrow(PlanPatchError);

    expect(() => applyPlanPatch(validPlanText("noop"), { operations: [] })).toThrow(PlanPatchError);
  });

  it("preserves CRLF line endings after a targeted replace", () => {
    const prior = validPlanText("crlf").replace(/\n/g, "\r\n");
    const { plan } = applyPlanPatch(prior, {
      operations: [{ op: "append_to_section", target: { topLevelHeading: "Risks" }, body: "- Added risk.\r\n" }],
    });
    expect(plan).toContain("\r\n");
    expect(plan).not.toContain("\r\r\n");
  });

  it("supports insert-after and delete operations", () => {
    const prior = validPlanText("ops");
    const { plan } = applyPlanPatch(prior, {
      operations: [
        { op: "insert_after_section", target: { topLevelHeading: "Goal" }, body: "## Background\nInserted context.\n\n" },
        { op: "delete_section", target: { topLevelHeading: "Risks" } },
      ],
    });

    expect(plan).toContain("## Background\nInserted context.");
    expect(plan).not.toContain("## Risks");
  });
});

describe("sf_team_plan patch revisions", () => {
  it("planner returns a patch, TypeScript applies it, and reviewer round 2 sees the full applied plan", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const patch = JSON.stringify({
        operations: [
          {
            op: "replace_within_section",
            target: { topLevelHeading: "Architecture" },
            anchor: "sample architecture text",
            body: "patched architecture detail",
          },
        ],
      });
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner" && captured.filter((c) => c.member.role === "planner").length === 1) {
          return fakeRun(validPlanText("patch-v1"));
        }
        if (member.role === "planner") return fakeRun(patch);
        const reviewerCalls = captured.filter((c) => c.member.role === "reviewer").length;
        return fakeRun(reviewerCalls === 1 ? REVISE_TEXT : APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Patch Plan", brief: "Acceptance Criteria:\n- [ ] Patch only.", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "patch", researcher: "never" } } as never) },
      );

      expect(result.finalPlan).toContain("patched architecture detail");
      expect(result.revisionMetrics.at(-1)).toMatchObject({ mode: "patch", patchApplied: true, fallbackUsed: false });
      const reviewerRound2 = captured.filter((c) => c.member.role === "reviewer")[1];
      expect(reviewerRound2.task.task).toContain("patched architecture detail");

      const transcriptDir = path.join(root, "ai_plan", slugify("Patch Plan"), "transcript", "planning");
      const files = readdirSync(transcriptDir);
      expect(files.some((file) => file.includes("planner-revision-patch"))).toBe(true);
      expect(files.some((file) => file.includes("system-patch-applied"))).toBe(true);
      const finalRevision = files.find((file) => file.includes("planner-revision-round-1"))!;
      expect(readFileSync(path.join(transcriptDir, finalRevision), "utf8")).toContain("patched architecture detail");
    } finally {
      dispose();
    }
  });

  it("falls back to full rewrite on invalid patch output", async () => {
    const { root, dispose } = makeRepo();
    try {
      const plannerOutputs = [validPlanText("fallback-v1"), "not json", validPlanText("fallback-full")];
      let plannerIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun(plannerOutputs[Math.min(plannerIdx++, plannerOutputs.length - 1)]);
        return fakeRun(plannerIdx < 2 ? REVISE_TEXT : APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Fallback Plan", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "patch", researcher: "never" } } as never) },
      );

      expect(result.finalPlan).toContain("fallback-full");
      expect(result.revisionMetrics.at(-1)).toMatchObject({ fallbackUsed: true, patchApplied: false });
    } finally {
      dispose();
    }
  });

  it("falls back to full rewrite when patch application cannot resolve the target", async () => {
    const { root, dispose } = makeRepo();
    try {
      const missingTargetPatch = JSON.stringify({
        operations: [
          { op: "append_to_section", target: { milestoneId: "M9", section: "Stories" }, body: "- unreachable\n" },
        ],
      });
      const plannerOutputs = [validPlanText("missing-v1"), missingTargetPatch, validPlanText("missing-fallback")];
      let plannerIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun(plannerOutputs[Math.min(plannerIdx++, plannerOutputs.length - 1)]);
        return fakeRun(plannerIdx < 2 ? REVISE_TEXT : APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Missing Target Plan", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "patch", researcher: "never" } } as never) },
      );

      expect(result.finalPlan).toContain("missing-fallback");
      expect(result.revisionMetrics.at(-1)).toMatchObject({ fallbackUsed: true, patchApplied: false });
    } finally {
      dispose();
    }
  });

  it("uses the legacy full rewrite path when plan_revision is full", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const plannerOutputs = [validPlanText("full-v1"), validPlanText("full-v2")];
      let plannerIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun(plannerOutputs[Math.min(plannerIdx++, plannerOutputs.length - 1)]);
        return fakeRun(plannerIdx < 2 ? REVISE_TEXT : APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Full Revision Plan", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "full", researcher: "never" } } as never) },
      );

      expect(result.finalPlan).toContain("full-v2");
      expect(result.revisionMetrics.at(-1)).toMatchObject({ mode: "full", patchAttempted: false, fallbackUsed: false });
      expect(captured.filter((c) => c.member.role === "planner")).toHaveLength(2);

      const transcriptDir = path.join(root, "ai_plan", slugify("Full Revision Plan"), "transcript", "planning");
      const files = readdirSync(transcriptDir);
      expect(files.some((file) => file.includes("planner-revision-patch"))).toBe(false);
    } finally {
      dispose();
    }
  });
});
