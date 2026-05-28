import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { resolveDefaults } from "../src/config/load";
import { MaxReviewRoundsError, ReviewerEmptyVerdictError, RevisionUnchangedError } from "../src/review/loop";
import { runLoopWithPartialOutput } from "../src/tools/shared";
import { slugify } from "../src/plan/slug";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { validPlanText } from "./helpers/valid-plan";

const REVISE_BODY = `## Summary
fix
## Findings
### P0
- planner did not address the architectural concern
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: REVISE`;

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-plan-partial-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi");
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

describe("audit fix #1: max-rounds writes last-draft.md + last-review.md", () => {
  it("writes both files under ai_plan/<slug>/ and re-throws with the paths in the message", async () => {
    const { root, dispose } = makeRepo();
    try {
      let plannerCount = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, _task: AgentTask) => {
        if (member.role === "planner") {
          plannerCount += 1;
          return fakeRun(validPlanText(`revision-${plannerCount}`));
        }
        return fakeRun(REVISE_BODY);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      let caught: unknown;
      try {
        await tool(
          { title: "Stuck Plan", brief: "hi", maxRounds: 2 },
          { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "full" } } as never) },
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MaxReviewRoundsError);
      const folder = path.join(root, "ai_plan", slugify("Stuck Plan"));
      const draftBody = readFileSync(path.join(folder, "last-draft.md"), "utf8");
      const reviewBody = readFileSync(path.join(folder, "last-review.md"), "utf8");
      // Final draft was the second revision (round-2 input came from planner round 2).
      // The mock planner returns validPlanText(`revision-${plannerCount}`); label embedded.
      expect(draftBody).toMatch(/revision-2/);
      // Raw reviewer text is the FULL body, not just findings.
      expect(reviewBody).toContain("VERDICT: REVISE");
      expect(reviewBody).toContain("planner did not address the architectural concern");
      // Friendlier error message names the paths.
      expect((caught as Error).message).toContain("last-draft.md=");
      expect((caught as Error).message).toContain("last-review.md=");
      expect((caught as Error).message).not.toContain("WRITE FAILED");
    } finally {
      dispose();
    }
  });

  it("writes last-draft.md + last-review.md on RevisionUnchangedError too (planner reverted)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const reviewerVerdict: { verdictText: string; verdict: { summary: string; findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] }; verdict: "REVISE" } } = {
        verdictText: REVISE_BODY,
        verdict: { summary: "fix", findings: { P0: ["arch"], P1: [], P2: [], P3: [] }, verdict: "REVISE" },
      };
      const slug = slugify("Stuck Plan");
      const fakeRunLoop = async () => {
        // Force the byte-equal revision condition on round 1.
        throw new RevisionUnchangedError(1, {
          lastPayload: "draft v1",
          lastVerdictText: reviewerVerdict.verdictText,
          lastVerdict: reviewerVerdict.verdict,
        });
      };
      let caught: unknown;
      try {
        await runLoopWithPartialOutput(
          fakeRunLoop as never,
          { initialPayload: "draft v1", reviewer: (async () => reviewerVerdict) as never, revise: (async () => "draft v1") as never, maxRounds: 5 },
          { repoRoot: root, slug },
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RevisionUnchangedError);
      const folder = path.join(root, "ai_plan", slug);
      const draftBody = readFileSync(path.join(folder, "last-draft.md"), "utf8");
      const reviewBody = readFileSync(path.join(folder, "last-review.md"), "utf8");
      expect(draftBody).toBe("draft v1");
      expect(reviewBody).toContain("VERDICT: REVISE");
      expect((caught as Error).message).toContain("last-draft.md=");
      expect((caught as Error).message).toContain("last-review.md=");
    } finally {
      dispose();
    }
  });

  it("WRITE FAILED is reported in the error message when the artifact write fails", async () => {
    // Force mkdir failure by using a repoRoot that points at an existing FILE,
    // not a directory — `mkdir(folder, { recursive: true })` will fail with ENOTDIR.
    const root = mkdtempSync(path.join(tmpdir(), "ct-wf-"));
    try {
      const filePath = path.join(root, "blocker");
      writeFileSync(filePath, "not a dir");
      const slug = "x";
      const reviewerVerdict = { verdictText: REVISE_BODY, verdict: { summary: "fix", findings: { P0: ["arch"], P1: [], P2: [], P3: [] }, verdict: "REVISE" as const } };
      const fakeRunLoop = async () => {
        throw new MaxReviewRoundsError("runReviewLoop: max 1 rounds reached without approval", {
          lastVerdict: reviewerVerdict.verdict,
          lastVerdictText: reviewerVerdict.verdictText,
          lastPayload: "draft body",
          history: [{ round: 1, verdict: reviewerVerdict.verdict }],
        });
      };
      let caught: unknown;
      try {
        // repoRoot = `filePath` (a regular file). planFolderPath joins ai_plan/<slug>/
        // onto a non-directory base; mkdir(recursive:true) returns ENOTDIR. Both
        // writes fail → message reports WRITE FAILED for each.
        await runLoopWithPartialOutput(
          fakeRunLoop as never,
          { initialPayload: "draft body", reviewer: (async () => reviewerVerdict) as never, revise: (async () => "draft body") as never, maxRounds: 1 },
          { repoRoot: filePath, slug },
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MaxReviewRoundsError);
      const msg = (caught as Error).message;
      // Both write paths surface WRITE FAILED markers (mkdir of a non-dir parent fails).
      expect(msg).toContain("last-draft.md=(WRITE FAILED:");
      expect(msg).toContain("last-review.md=(WRITE FAILED:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes last-draft.md + last-review.md on ReviewerEmptyVerdictError too (reviewer flaked)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = slugify("Empty Reviewer");
      const reviewerVerdict: { verdictText: string; verdict: { summary: string; findings: { P0: string[]; P1: string[]; P2: string[]; P3: string[] }; verdict: "REVISE" } } = {
        verdictText: REVISE_BODY,
        verdict: { summary: "fix", findings: { P0: ["arch"], P1: [], P2: [], P3: [] }, verdict: "REVISE" },
      };
      const fakeRunLoop = async () => {
        // M3-style failure: round 2 reviewer was empty after round 1 REVISE.
        throw new ReviewerEmptyVerdictError(2, {
          lastPayload: "draft v2 (revised in response to round 1 findings)",
          priorVerdictText: REVISE_BODY,
        });
      };
      let caught: unknown;
      try {
        await runLoopWithPartialOutput(
          fakeRunLoop as never,
          { initialPayload: "draft v1", reviewer: (async () => reviewerVerdict) as never, revise: (async () => "draft v2") as never, maxRounds: 5 },
          { repoRoot: root, slug },
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ReviewerEmptyVerdictError);
      const folder = path.join(root, "ai_plan", slug);
      const draftBody = readFileSync(path.join(folder, "last-draft.md"), "utf8");
      const reviewBody = readFileSync(path.join(folder, "last-review.md"), "utf8");
      // last-draft.md captures the payload the empty round was meant to review
      // (the revised one), so the user can see what was on the table when the
      // reviewer flaked.
      expect(draftBody).toBe("draft v2 (revised in response to round 1 findings)");
      // last-review.md captures the PRIOR round's verdict (the empty round
      // produced nothing), so the user has at least the round-1 findings.
      expect(reviewBody).toContain("VERDICT: REVISE");
      expect((caught as Error).message).toContain("last-draft.md=");
      expect((caught as Error).message).toContain("last-review.md=");
      // The error message itself names the failure mode clearly so the user
      // does NOT think it was a byte-equal-payload bug.
      expect((caught as Error).message).toContain("reviewer returned empty output");
    } finally {
      dispose();
    }
  });

  it("ReviewerEmptyVerdictError on round 1 (no prior verdict): last-review.md falls back to a placeholder, not silently empty", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = slugify("Empty Reviewer Round1");
      const fakeRunLoop = async () => {
        throw new ReviewerEmptyVerdictError(1, {
          lastPayload: "draft v1 (initial)",
          priorVerdictText: undefined,
        });
      };
      let caught: unknown;
      try {
        await runLoopWithPartialOutput(
          fakeRunLoop as never,
          { initialPayload: "draft v1", reviewer: (async () => ({ verdictText: "", verdict: { summary: "", findings: { P0: [], P1: [], P2: [], P3: [] }, verdict: "UNKNOWN" } })) as never, revise: (async () => "x") as never, maxRounds: 5 },
          { repoRoot: root, slug },
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ReviewerEmptyVerdictError);
      const folder = path.join(root, "ai_plan", slug);
      const reviewBody = readFileSync(path.join(folder, "last-review.md"), "utf8");
      // Placeholder explicitly notes the round-1 case so the user reading
      // last-review.md is not confused by a blank file.
      expect(reviewBody).toMatch(/no prior round/i);
    } finally {
      dispose();
    }
  });

  it("does NOT write last-draft / last-review on the happy path (approved)", async () => {
    const APPROVED = `## Summary\nok\n## Findings\n### P0\n- None.\n### P1\n- None.\n### P2\n- None.\n### P3\n- None.\n## Verdict\nVERDICT: APPROVED`;
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        return fakeRun(member.role === "planner" ? validPlanText("happy") : APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool({ title: "Happy", maxRounds: 5 }, { repoRoot: root });
      expect(result.approved).toBe(true);
      const folder = path.join(root, "ai_plan", slugify("Happy"));
      expect(() => readFileSync(path.join(folder, "last-draft.md"))).toThrow();
      expect(() => readFileSync(path.join(folder, "last-review.md"))).toThrow();
    } finally {
      dispose();
    }
  });
});
