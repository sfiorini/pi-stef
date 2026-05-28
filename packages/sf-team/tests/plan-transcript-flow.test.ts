import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { resolveDefaults } from "../src/config/load";
import { EXECUTION_STRATEGY_FILE } from "../src/plan/paths";
import { slugify } from "../src/plan/slug";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { validPlanText } from "./helpers/valid-plan";

const REVISE_BODY = `## Summary
fix me
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

const RESEARCHER_BODY = JSON.stringify({
  knownFacts: ["repo uses pnpm"],
  ambiguities: ["which port?"],
  openQuestions: [{ id: "q1", kind: "input", title: "Port?" }],
  external: [],
  notes: "n",
});

function legacyArrayStrategyPlan(label: string): string {
  return validPlanText(label).replace(
    /```json\n[\s\S]*?\n```/,
    `\`\`\`json
{
  "version": 1,
  "maxParallelMilestones": 2,
  "maxParallelStoriesPerMilestone": 2,
  "milestoneWaves": [
    ["M0"],
    ["M1"]
  ],
  "milestones": {
    "M0": {
      "dependsOn": [],
      "stories": [
        {
          "wave": 1,
          "ids": ["S-001"],
          "dependsOn": [],
          "writeSets": ["packages/sf-team/src/${label}-bootstrap.ts"]
        },
        {
          "wave": 2,
          "ids": ["S-002"],
          "dependsOn": ["S-001"],
          "writeSets": ["packages/sf-team/tests/${label}-bootstrap.test.ts"]
        }
      ]
    },
    "M1": {
      "dependsOn": ["M0"],
      "stories": [
        {
          "wave": 1,
          "ids": ["S-101"],
          "dependsOn": [],
          "writeSets": ["packages/sf-team/src/${label}-core.ts"]
        }
      ]
    }
  }
}
\`\`\``,
  );
}

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-trans-"));
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

describe("sf_team_plan transcript: every agent handoff is persisted", () => {
  it("two-round revise loop: transcript files cover researcher → draft → review-1-REVISE → revision-1 → review-2-APPROVED", async () => {
    const { root, dispose } = makeRepo();
    try {
      const ui = {
        select: async () => undefined,
        input: async () => "8080",
        confirm: async () => true,
        notify: () => undefined,
      } as never;
      let plannerIdx = 0;
      let reviewerIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, _t: AgentTask) => {
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") {
          plannerIdx += 1;
          return fakeRun(validPlanText(`planner-output-${plannerIdx}`));
        }
        // reviewer
        reviewerIdx += 1;
        return fakeRun(reviewerIdx === 1 ? REVISE_BODY : APPROVED_BODY);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Healthz", brief: "Add a healthz endpoint" },
        { repoRoot: root, ui, configDefaults: resolveDefaults({ performance: { plan_revision: "full" } } as never) },
      );
      expect(result.approved).toBe(true);

      const folder = path.join(root, "ai_plan", slugify("Healthz"), "transcript", "planning");
      const files = readdirSync(folder).sort();
      expect(files).toEqual([
        "0001-system-jira-context-SKIPPED.md",
        "0002-system-researcher-decision-USED.md",
        "0003-researcher-analysis-OK.md",
        "0004-planner-draft.md",
        "0005-reviewer-review-round-1-REVISE.md",
        "0006-planner-revision-round-1.md",
        "0007-reviewer-review-round-2-APPROVED.md",
      ]);

      // Each file body has the role/label header + the actual content.
      const review1 = readFileSync(path.join(folder, "0005-reviewer-review-round-1-REVISE.md"), "utf8");
      expect(review1).toMatch(/^# reviewer — review \(round 1\) — REVISE$/m);
      expect(review1).toContain("VERDICT: REVISE");

      const revision1 = readFileSync(path.join(folder, "0006-planner-revision-round-1.md"), "utf8");
      expect(revision1).toContain("planner-output-2"); // the revised draft (label embedded in validPlanText)

      const review2 = readFileSync(path.join(folder, "0007-reviewer-review-round-2-APPROVED.md"), "utf8");
      expect(review2).toContain("VERDICT: APPROVED");
    } finally {
      dispose();
    }
  });

  it("happy-path single round: only researcher → draft → review-1-APPROVED (no revisions)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const ui = {
        select: async () => undefined,
        input: async () => "8080",
        confirm: async () => true,
        notify: () => undefined,
      } as never;
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("clean-draft"));
        return fakeRun(APPROVED_BODY);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool({ title: "Quick", brief: "go" }, { repoRoot: root, ui });
      const files = readdirSync(path.join(root, "ai_plan", slugify("Quick"), "transcript", "planning")).sort();
      expect(files).toEqual([
        "0001-system-jira-context-SKIPPED.md",
        "0002-system-researcher-decision-USED.md",
        "0003-researcher-analysis-OK.md",
        "0004-planner-draft.md",
        "0005-reviewer-review-round-1-APPROVED.md",
      ]);
      const strategy = JSON.parse(
        readFileSync(path.join(root, "ai_plan", slugify("Quick"), EXECUTION_STRATEGY_FILE), "utf8"),
      );
      expect(strategy.milestoneWaves.map((w: { milestones: string[] }) => w.milestones)).toEqual([["M0"], ["M1"]]);
      expect(strategy.stories.M0.storyWaves.map((w: { stories: string[] }) => w.stories)).toEqual([["S-001"], ["S-002"]]);
    } finally {
      dispose();
    }
  });

  it("invalid in-plan execution strategy is fixed by deterministic pre-review revision before the first reviewer call", async () => {
    const { root, dispose } = makeRepo();
    try {
      const notify = vi.fn();
      let plannerIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") {
          plannerIdx += 1;
          return fakeRun(plannerIdx === 1 ? legacyArrayStrategyPlan("invalid-strategy") : validPlanText("strategy-repaired"));
        }
        return fakeRun(APPROVED_BODY);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Invalid Strategy Revision", brief: "Use the mocked planner output.", analysisOverride: null, answersOverride: {} },
        {
          repoRoot: root,
          ui: { notify } as never,
          configDefaults: resolveDefaults({ performance: { plan_revision: "full", researcher: "never" } } as never),
        },
      );
      expect(result.finalPlan).toContain("strategy-repaired");
      expect(plannerIdx).toBe(2);

      const slug = slugify("Invalid Strategy Revision");
      const transcriptDir = path.join(root, "ai_plan", slug, "transcript", "planning");
      const files = readdirSync(transcriptDir).sort();
      expect(files.some((f) => /system-deterministic-pre-review-REVISE\.md$/.test(f))).toBe(true);
      expect(files.some((f) => /planner-deterministic-pre-review-revision-round-0\.md$/.test(f))).toBe(true);
      expect(files.some((f) => /reviewer-review-round-1-APPROVED\.md$/.test(f))).toBe(true);
      expect(files.some((f) => /reviewer-review-round-1-REVISE\.md$/.test(f))).toBe(false);
      expect(files.some((f) => /strategy-validation-failed/.test(f))).toBe(false);

      const preflight = readFileSync(
        path.join(transcriptDir, files.find((f) => /system-deterministic-pre-review-REVISE\.md$/.test(f))!),
        "utf8",
      );
      expect(preflight).toMatch(/Execution strategy failed validation/i);
      expect(preflight).toMatch(/milestoneWaves\[0\]/);
      expect(notify).not.toHaveBeenCalledWith(expect.stringMatching(/failed validation/), "warning");
    } finally {
      dispose();
    }
  });

  it("invalid in-plan execution strategy writes a fallback artifact only after review retries are exhausted", async () => {
    const { root, dispose } = makeRepo();
    try {
      const notify = vi.fn();
      const invalidStrategyPlan = legacyArrayStrategyPlan("invalid-strategy");
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun(invalidStrategyPlan);
        return fakeRun(APPROVED_BODY);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { title: "Invalid Strategy", brief: "Use the mocked planner output.", analysisOverride: null, answersOverride: {}, maxRounds: 1 },
        {
          repoRoot: root,
          ui: { notify } as never,
          configDefaults: resolveDefaults({ performance: { researcher: "never" } } as never),
        },
      );
      const slug = slugify("Invalid Strategy");
      const transcriptDir = path.join(root, "ai_plan", slug, "transcript", "planning");
      const files = readdirSync(transcriptDir).sort();
      const validationFile = files.find((f) => /system-strategy-validation-fallback-after-retries-FAILED\.md$/.test(f));
      expect(validationFile, `expected strategy fallback transcript; got ${files.join(", ")}`).toBeDefined();
      const validationBody = readFileSync(path.join(transcriptDir, validationFile!), "utf8");
      expect(validationBody).toMatch(/still failed validation after review retries/i);
      expect(validationBody).toMatch(/milestoneWaves\[0\]/);
      expect(validationBody).toMatch(/"milestoneWaves"/);
      expect(validationBody).toMatch(/\[\s*"M0"\s*\]/);
      expect(notify).toHaveBeenCalledWith(expect.stringMatching(/failed validation/), "warning");

      const strategy = JSON.parse(readFileSync(path.join(root, "ai_plan", slug, EXECUTION_STRATEGY_FILE), "utf8"));
      expect(strategy.milestoneWaves.map((w: { milestones: string[] }) => w.milestones)).toEqual([["M0"], ["M1"]]);
      expect(strategy.maxParallelMilestones).toBe(1);
    } finally {
      dispose();
    }
  });

  it("P3-only one-more-pass: emits a system note marking the fixup pass and a planner-revision file", async () => {
    const APPROVED_WITH_P3 = APPROVED_BODY.replace(
      "### P3\n- None.",
      "### P3\n- Inconsistent heading style on M1",
    );
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun(validPlanText("p3-draft"));
        return fakeRun(APPROVED_WITH_P3);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { title: "P3", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "full", researcher: "never" } } as never) },
      );
      const folder = path.join(root, "ai_plan", slugify("P3"), "transcript", "planning");
      const files = readdirSync(folder).sort();
      // Order: researcher decision → planner-draft → reviewer round 1 (APPROVED with P3) → planner revision (P3 fixup) → system note.
      expect(files).toEqual([
        "0001-system-researcher-decision-SKIPPED.md",
        "0002-planner-draft.md",
        "0003-reviewer-review-round-1-APPROVED.md",
        "0004-planner-revision-round-1.md",
        "0005-system-p3-only-fixup-applied-OK.md",
      ]);
      const note = readFileSync(path.join(folder, "0005-system-p3-only-fixup-applied-OK.md"), "utf8");
      expect(note).toContain("Applied P3-only fixup pass");
      expect(note).toContain("1 cosmetic finding(s)");
    } finally {
      dispose();
    }
  });
});
