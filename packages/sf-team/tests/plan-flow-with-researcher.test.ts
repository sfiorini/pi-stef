import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { createSfTeamAuto } from "../src/tools/auto";
import { resolveDefaults } from "../src/config/load";
import { slugify } from "../src/plan/slug";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { validPlanText } from "./helpers/valid-plan";

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

const RESEARCHER_BODY = JSON.stringify({
  knownFacts: ["repo uses pnpm"],
  ambiguities: [],
  openQuestions: [{ id: "q1", kind: "input", title: "What port?" }],
  external: [],
});

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-research-"));
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

describe("sf_team_plan flow with researcher", () => {
  it("invokes researcher → planner → reviewer in that order; planner brief contains researcher findings + user answer", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const ui = {
        select: async () => undefined,
        input: async (_t: string) => "8080",
        confirm: async () => true,
        notify: () => undefined,
      } as never;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("draft-body"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool({ title: "Healthz", brief: "Add /healthz" }, { repoRoot: root, ui });
      expect(result.approved).toBe(true);

      // Spawn ordering: researcher → planner → reviewer.
      const order = captured.map((c) => c.member.role);
      expect(order[0]).toBe("researcher");
      expect(order[1]).toBe("planner");
      expect(order[2]).toBe("reviewer");

      // Planner brief contains researcher findings + the user's answer.
      const plannerCall = captured.find((c) => c.member.role === "planner")!;
      expect(plannerCall.task.task).toContain("repo uses pnpm");
      expect(plannerCall.task.task).toContain("8080"); // user's answer
      expect(plannerCall.task.task).toContain("Add /healthz"); // original brief
    } finally {
      dispose();
    }
  });

  it("respects analysisOverride: null to skip researcher", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        captured.push({ member });
        if (member.role === "planner") return fakeRun(validPlanText("draft-no-researcher"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool({ title: "Skip", analysisOverride: null, answersOverride: {} }, { repoRoot: root });
      expect(captured.find((c) => c.member.role === "researcher")).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("auto policy skips researcher for self-contained briefs and records the decision", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task?: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun(validPlanText("self-contained"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          title: "Self Contained",
          brief: "Acceptance Criteria:\n- [ ] Add the flag.\n\nUse brief as-is.",
        },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "auto" } } as never) },
      );

      expect(captured.some((c) => c.member.role === "researcher")).toBe(false);
      expect(captured.find((c) => c.member.role === "planner")?.task?.task).toContain("Add the flag");
      expect(result.researcherDecision).toMatchObject({ policy: "auto", action: "skipped" });
      expect(result.agentSettings.planner).toMatchObject({ model: "claude-sonnet-4-6", thinking: "medium", heartbeatMs: 300_000 });
      expect(result.agentSettings.planner.source).toEqual({
        model: "resolved-config",
        thinking: "resolved-config",
        heartbeatMs: "resolved-config",
      });

      const transcriptDir = path.join(root, "ai_plan", slugify("Self Contained"), "transcript", "planning");
      const decisionFile = readdirSync(transcriptDir).find((name) => name.includes("system-researcher-decision-SKIPPED"));
      expect(decisionFile).toBeDefined();
      expect(readFileSync(path.join(transcriptDir, decisionFile!), "utf8")).toContain("use brief as-is");
    } finally {
      dispose();
    }
  });

  it("agent setting source is field-level for partial input overrides", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun(validPlanText("partial-source"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        {
          title: "Partial Source",
          brief: "Acceptance Criteria:\n- [ ] Ship it.",
          planner: { role: "planner", model: "custom-planner" },
        },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "never" } } as never) },
      );

      expect(result.agentSettings.planner).toMatchObject({
        model: "custom-planner",
        thinking: "medium",
        heartbeatMs: 300_000,
      });
      expect(result.agentSettings.planner.source).toEqual({
        model: "input",
        thinking: "resolved-config",
        heartbeatMs: "resolved-config",
      });
    } finally {
      dispose();
    }
  });

  it("auto policy treats a bare file name as a self-contained signal", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: TeamMember[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        captured.push(member);
        if (member.role === "planner") return fakeRun(validPlanText("bare-file-skip"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Bare File", brief: "Update README.md with the new command." },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "auto" } } as never) },
      );

      expect(captured.some((m) => m.role === "researcher")).toBe(false);
      expect(result.researcherDecision).toMatchObject({ policy: "auto", action: "skipped" });
      expect(result.researcherDecision.signals).toContain("file path");
    } finally {
      dispose();
    }
  });

  it("always policy uses researcher even when an explicit skip phrase is present", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: TeamMember[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        captured.push(member);
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("always-research"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Always Research", brief: "skip researcher\nAcceptance Criteria:\n- [ ] Ship it." },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "always" } } as never) },
      );

      expect(captured[0].role).toBe("researcher");
      expect(result.researcherDecision).toMatchObject({ policy: "always", action: "used" });
    } finally {
      dispose();
    }
  });

  it("never policy skips researcher even when external refs are present", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: TeamMember[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        captured.push(member);
        if (member.role === "planner") return fakeRun(validPlanText("never-research"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Never Research", brief: "See https://example.com/spec before planning." },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "never" } } as never) },
      );

      expect(captured.some((m) => m.role === "researcher")).toBe(false);
      expect(result.researcherDecision).toMatchObject({ policy: "never", action: "skipped" });
    } finally {
      dispose();
    }
  });

  it("auto policy uses researcher when scanRefs finds an external reference", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: TeamMember[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        captured.push(member);
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") return fakeRun(validPlanText("ref-research"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Ref Research", brief: "Acceptance Criteria:\n- [ ] Follow PROJ-123." },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { researcher: "auto" } } as never) },
      );

      expect(captured[0].role).toBe("researcher");
      expect(result.researcherDecision).toMatchObject({ policy: "auto", action: "used" });
    } finally {
      dispose();
    }
  });
});

describe("sf_team_auto runs researcher exactly once", () => {
  it("counts spawnAgent({role:researcher}) === 1 across the full chain", async () => {
    const { root, dispose } = makeRepo();
    try {
      const counts: Record<string, number> = {};
      const spawnAgent = vi.fn(async (member: TeamMember, _task: AgentTask) => {
        counts[member.role] = (counts[member.role] ?? 0) + 1;
        if (member.role === "researcher") return fakeRun(RESEARCHER_BODY);
        if (member.role === "planner") {
          // Plan body must include at least one milestone so implement has something to do.
          return fakeRun(validPlanText("auto-plan"));
        }
        if (member.role === "developer") {
          // Stage a real change so impl-review has a non-empty diff.
          // Note: developer cwd is the worktree (set by implement.ts).
          // We can't guess that path here, so the developer write is harmless;
          // we instead rely on the test stub providing it via cwdForDeveloper-style logic.
          // For this assertion we only care about COUNTS, so accept whatever happens downstream.
          return fakeRun("dev done");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamAuto({ spawnAgent: spawnAgent as never, runReviewLoop });
      const ui = { select: async () => undefined, input: async () => "8080", confirm: async () => true, notify: () => undefined } as never;
      // Auto may fail at the implement stage because the dev stub doesn't stage a real change;
      // we only care that researcher was called exactly once before any failure.
      try {
        await tool(
          { title: "Auto Healthz", brief: "Add /healthz", verifyCommand: false },
          { repoRoot: root, ui },
        );
      } catch {
        // expected — implement may bail when the developer stages nothing
      }
      expect(counts.researcher ?? 0).toBe(1);
    } finally {
      dispose();
    }
  });
});
