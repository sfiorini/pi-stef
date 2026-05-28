import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { createSfTeamTask } from "../src/tools/task";
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

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-qa-"));
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

describe("audit fix #3: sf_team_plan asks the user when brief is empty AND ctx.ui is present", () => {
  it("calls ctx.ui.input twice (Brief + Constraints) and concatenates the answers into the planner brief", async () => {
    const { root, dispose } = makeRepo();
    try {
      const inputCalls: { title: string; placeholder?: string }[] = [];
      const ui = {
        select: async () => undefined,
        input: async (title: string, placeholder?: string) => {
          inputCalls.push({ title, placeholder });
          if (inputCalls.length === 1) return "Add SSO login flow";
          return "use existing IdP, ship by Friday";
        },
        confirm: async () => true,
        notify: () => undefined,
      } as never;

      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        return fakeRun(member.role === "planner" ? validPlanText("qa-empty") : APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool({ title: "SSO" }, { repoRoot: root, ui });
      expect(result.approved).toBe(true);
      expect(inputCalls).toHaveLength(2);
      expect(inputCalls[0].title).toMatch(/accomplish/i);
      expect(inputCalls[1].title).toMatch(/constraints/i);
      const plannerCall = captured.find((c) => c.member.role === "planner");
      expect(plannerCall?.task.task).toContain("Add SSO login flow");
      expect(plannerCall?.task.task).toContain("use existing IdP");
    } finally {
      dispose();
    }
  });

  it("does NOT prompt when brief is non-empty", async () => {
    const { root, dispose } = makeRepo();
    try {
      const inputCalls: string[] = [];
      const ui = {
        select: async () => undefined,
        input: async (title: string) => { inputCalls.push(title); return "x"; },
        confirm: async () => true,
        notify: () => undefined,
      } as never;
      const spawnAgent = vi.fn(async (member: TeamMember) => fakeRun(member.role === "planner" ? validPlanText("qa-draft") : APPROVED));
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool({ title: "SSO", brief: "Replace cookie auth with SAML SSO and audit-log every login event" }, { repoRoot: root, ui });
      expect(result.approved).toBe(true);
      expect(inputCalls).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("does NOT prompt when ctx.ui is absent (headless mode)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) => fakeRun(member.role === "planner" ? validPlanText("qa-draft") : APPROVED));
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool({ title: "SSO" }, { repoRoot: root });
      expect(result.approved).toBe(true);
    } finally {
      dispose();
    }
  });

  it("sf_team_task also asks via ctx.ui.input when brief is empty", async () => {
    const { root, dispose } = makeRepo();
    try {
      const inputCalls: string[] = [];
      const ui = {
        select: async () => undefined,
        input: async (title: string) => {
          inputCalls.push(title);
          return inputCalls.length === 1 ? "Add /healthz route" : "ts only";
        },
        confirm: async () => true,
        notify: () => undefined,
      } as never;

      const captured: { member: TeamMember; task: AgentTask }[] = [];
      let pIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") {
          pIdx += 1;
          return fakeRun(validPlanText(`task-plan-${pIdx}`));
        }
        if (member.role === "developer") {
          // Stage a real change so impl-review has a non-empty diff.
          const target = path.join(root, "dev.ts");
          writeFileSync(target, `// touch\n`);
          spawnSync("git", ["add", "dev.ts"], { cwd: root });
          return fakeRun("dev done");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Healthz", verifyCommand: false, allowDirty: true },
        { repoRoot: root, ui },
      );
      expect(result.approved).toBe(true);
      expect(inputCalls).toHaveLength(2);
      expect(inputCalls[0]).toMatch(/this task/i);
      expect(inputCalls[1]).toMatch(/constraints/i);
      const plannerCall = captured.find((c) => c.member.role === "planner");
      expect(plannerCall?.task.task).toContain("Add /healthz route");
      expect(plannerCall?.task.task).toContain("ts only");
    } finally {
      dispose();
    }
  });
});
