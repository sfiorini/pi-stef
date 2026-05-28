import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamAuto } from "../src/tools/auto";
import { createSfTeamPlan } from "../src/tools/plan";
import { EmptyPlanError } from "../src/orchestrator/empty-plan-error";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

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

const REFUSAL_PROSE =
  "The sf-team plan-folder lock is currently held by another live `pi` process (PID 40957) on this machine, so I can't draft a new plan into `ai_plan/` right now without colliding with it.\n\nWhich would you like?";

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "auto-empty-prop-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("S-105: sf_team_auto propagates EmptyPlanError from sf_team_plan", () => {
  it("EmptyPlanError thrown by sf_team_plan is NOT swallowed by sf_team_auto; it reaches the caller", async () => {
    const { root, dispose } = makeRepo();
    try {
      // Mock planner returns refusal prose; reviewer (an LLM) format-approves
      // it. sf_team_plan's structural validators must reject post-approval
      // and throw EmptyPlanError; sf_team_auto must propagate.
      const spawnAgent = vi.fn(async (member: TeamMember, _task: AgentTask) =>
        fakeRun(member.role === "planner" ? REFUSAL_PROSE : APPROVED),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const planTool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const implementTool = vi.fn(async () => ({
        slug: "x",
        mode: "all-milestones" as const,
        milestones: [],
      }));

      // Build an auto tool that uses our captured plan tool. createSfTeamAuto's
      // factory wires its own internal tools; for this test we use the
      // factory-default and inject our spawnAgent dependency. The plan tool
      // will throw inside the auto wrapper.
      const auto = createSfTeamAuto({ spawnAgent: spawnAgent as never, runReviewLoop });

      let caught: unknown;
      try {
        await auto({ title: "Refusal Test", brief: "go", analysisOverride: null, answersOverride: {} } as never, {
          repoRoot: root,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EmptyPlanError);
      expect((caught as EmptyPlanError).reason).toBe("no-milestones");
      expect(implementTool).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("sf_team_plan calls ctx.ui.notify with an error before throwing (S-104)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) =>
        fakeRun(member.role === "planner" ? REFUSAL_PROSE : APPROVED),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const planTool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const ui = {
        notify: vi.fn(),
        confirm: async () => true,
        select: async () => undefined,
        input: async () => "",
      } as never;
      let err: unknown;
      try {
        await planTool(
          { title: "Refusal", brief: "go", analysisOverride: null, answersOverride: {} },
          { repoRoot: root, ui },
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EmptyPlanError);
      expect((ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledTimes(1);
      const call = (ui as { notify: ReturnType<typeof vi.fn> }).notify.mock.calls[0];
      expect(call[0]).toMatch(/empty\/refusal plan/i);
      expect(call[0]).toContain("diagnostics");
      expect(call[1]).toBe("error");
    } finally {
      dispose();
    }
  });

  it("validation failure writes a transcript entry under transcript/ as system/validation-failed (S-104)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { slugify } = await import("../src/plan/slug");
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) =>
        fakeRun(member.role === "planner" ? REFUSAL_PROSE : APPROVED),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const planTool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      let err: unknown;
      try {
        await planTool(
          { title: "Refusal Transcript", brief: "go", analysisOverride: null, answersOverride: {} },
          { repoRoot: root },
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EmptyPlanError);
      const slug = slugify("Refusal Transcript");
      const transcriptDir = path.join(root, "ai_plan", slug, "transcript", "planning");
      const files = readdirSync(transcriptDir);
      const validationEntry = files.find((f) => /system-validation-failed-FAILED\.md$/.test(f));
      expect(validationEntry, `expected a system-validation-failed-FAILED.md file under ${transcriptDir}; got ${files.join(", ")}`).toBeDefined();
      const body = readFileSync(path.join(transcriptDir, validationEntry!), "utf8");
      // The rejected raw payload is preserved.
      expect(body).toContain("PID 40957");
      // Reason is captured in metadata.
      expect(body).toContain("reason");
    } finally {
      dispose();
    }
  });

  it("EmptyPlanError reason is one of the three documented values", async () => {
    const { root, dispose } = makeRepo();
    try {
      const tooShort = "x"; // < 200 chars
      const spawnAgent = vi.fn(async (member: TeamMember) =>
        fakeRun(member.role === "planner" ? tooShort : APPROVED),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const planTool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      let err: unknown;
      try {
        await planTool({ title: "Short", brief: "go", analysisOverride: null, answersOverride: {} }, { repoRoot: root });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EmptyPlanError);
      expect(["no-milestones", "no-stories", "too-short"]).toContain((err as EmptyPlanError).reason);
      expect((err as EmptyPlanError).reason).toBe("too-short");
    } finally {
      dispose();
    }
  });
});
