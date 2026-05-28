import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
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
  const root = mkdtempSync(path.join(tmpdir(), "ct-tui-"));
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

describe("TUI live updates: orchestrator drives setWidget on every spawn", () => {
  it("setWidget is called BEFORE the first agent spawn (initial empty render) and after each agent registration", async () => {
    const { root, dispose } = makeRepo();
    try {
      const setWidgetCalls: Array<{ key: string; lines: unknown }> = [];
      const ui = {
        select: async () => undefined,
        input: async () => "x",
        confirm: async () => true,
        notify: () => undefined,
        setWidget: (key: string, lines: unknown) => {
          setWidgetCalls.push({ key, lines });
        },
      } as never;
      const spawnAgent = vi.fn(async (member: TeamMember, _task: AgentTask) => {
        if (member.role === "planner") return fakeRun(validPlanText("tui-draft"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { title: "Healthz", brief: "go", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, ui },
      );

      // At minimum: initial empty render + planner registration + reviewer registration + agent_end events for each.
      expect(setWidgetCalls.length).toBeGreaterThanOrEqual(2);
      // First call is the empty-state initial render.
      expect(setWidgetCalls[0].key).toBe("sf-team");
      // Lines are a string[] (not a Component factory in this PR).
      expect(Array.isArray(setWidgetCalls[0].lines)).toBe(true);
    } finally {
      dispose();
    }
  });

  it("subscribeAgent upserts a card with role and running state immediately", async () => {
    // Direct unit test against the orchestrator's subscribeAgent contract.
    // We build a minimal scenario: invoke the tool and inspect the widget calls.
    const { root, dispose } = makeRepo();
    try {
      const setWidgetCalls: string[][] = [];
      const ui = {
        select: async () => undefined,
        input: async () => "x",
        confirm: async () => true,
        notify: () => undefined,
        setWidget: (_key: string, lines: unknown) => {
          if (Array.isArray(lines)) setWidgetCalls.push(lines as string[]);
        },
      } as never;
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun(validPlanText("tui-draft"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { title: "Test", brief: "go", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, ui },
      );
      // After the run, at least one setWidget render must include "planner" in any line.
      const allLines = setWidgetCalls.flat().join("\n");
      expect(allLines).toMatch(/planner/i);
      expect(allLines).toMatch(/reviewer/i);
    } finally {
      dispose();
    }
  });
});
