import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { renderAgentCards } from "../src/tui/agent-card";
import { applyAgentEvent } from "../src/tui/wiring";
import { emptyState, upsertAgent, type WidgetState } from "../src/tui/state";
import { createSfTeamPlan } from "../src/tools/plan";
import { resolveDefaults } from "../src/config/load";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { validPlanText } from "./helpers/valid-plan";

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
fix
## Findings
### P0
- needs detail
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: REVISE`;

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-tui-fix-"));
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

describe("Bug fix #1: timer freezes when agent reaches a terminal state", () => {
  it("agent_end stamps endedAtMs; subsequent renders read FROM endedAtMs, not now", () => {
    let state: WidgetState = upsertAgent(emptyState(), {
      id: "planner",
      role: "planner",
      model: "claude-opus-4-7",
      state: "running",
      startedAtMs: 1_000_000,
    });
    // Agent completes at 1m05s.
    const completeAt = 1_065_000;
    vi.spyOn(Date, "now").mockReturnValue(completeAt);
    state = applyAgentEvent(state, "planner", { kind: "stdout-json", raw: { type: "agent_end", messages: [] } });
    expect(state.agents[0].endedAtMs).toBe(completeAt);
    expect(state.agents[0].state).toBe("completed");

    // Render at three later times — elapsed must always read 1m05s.
    const lines5min = renderAgentCards(state, { now: 1_300_000 });
    const lines10min = renderAgentCards(state, { now: 1_600_000 });
    const lines30min = renderAgentCards(state, { now: 2_800_000 });
    expect(lines5min.join("\n")).toContain("[1m05s]");
    expect(lines10min.join("\n")).toContain("[1m05s]");
    expect(lines30min.join("\n")).toContain("[1m05s]");
    vi.restoreAllMocks();
  });

  it("running agent's elapsed timer DOES tick", () => {
    const state = upsertAgent(emptyState(), {
      id: "planner",
      role: "planner",
      model: "claude-opus-4-7",
      state: "running",
      startedAtMs: 1_000_000,
    });
    const lines = renderAgentCards(state, { now: 1_125_000 });
    expect(lines.join("\n")).toContain("[2m05s]");
  });

  it("orchestrator repaints running cards once per second even when no agent events arrive", async () => {
    const { runOrchestrator } = await import("../src/orchestrator/run");
    const { root, dispose } = makeRepo();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const updates: Array<{ state: WidgetState; now: number }> = [];
      let releaseRun: () => void = () => undefined;
      let markSubscribed: () => void = () => undefined;
      const releaseRunPromise = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      const subscribedPromise = new Promise<void>((resolve) => {
        markSubscribed = resolve;
      });
      const run = runOrchestrator(
        {
          repoRoot: root,
          slug: "timer-repaint",
          toolName: "sf_team_plan",
          useWorktree: true,
          tmuxManager: null,
          widget: {
            update: (state) => updates.push({ state: JSON.parse(JSON.stringify(state)), now: Date.now() }),
            dispose: vi.fn(),
          },
        },
        async (bodyCtx) => {
          bodyCtx.subscribeAgent({ role: "researcher", model: "x" }, "researcher");
          markSubscribed();
          await releaseRunPromise;
          return undefined;
        },
      );

      await subscribedPromise;
      expect(updates).toHaveLength(2);
      vi.setSystemTime(1_002_000);
      await vi.advanceTimersByTimeAsync(2_000);
      releaseRun();
      await run;

      expect(updates.length).toBeGreaterThanOrEqual(4);
      const runningTicks = updates.filter((update) => update.now > 1_000_000 && update.state.agents[0]?.state === "running");
      expect(runningTicks.length).toBeGreaterThanOrEqual(2);
      const renderedTicks = runningTicks.map((update) => renderAgentCards(update.state, { now: update.now, useColor: false }).join("\n"));
      expect(renderedTicks.some((line) => /\[[1-9]\d*s\]/.test(line))).toBe(true);
    } finally {
      vi.useRealTimers();
      dispose();
    }
  });

  it("stalled / aborted / failed states also freeze the timer", () => {
    const cases = [
      { event: { kind: "stalled", lastEventAtMs: 0 } as const, expected: "stalled" },
      { event: { kind: "aborted" } as const, expected: "aborted" },
      { event: { kind: "error", message: "boom" } as const, expected: "failed" },
    ];
    for (const c of cases) {
      let state: WidgetState = upsertAgent(emptyState(), {
        id: "planner",
        role: "planner",
        model: "x",
        state: "running",
        startedAtMs: 1_000_000,
      });
      vi.spyOn(Date, "now").mockReturnValue(1_030_000);
      state = applyAgentEvent(state, "planner", c.event);
      vi.restoreAllMocks();
      expect(state.agents[0].state).toBe(c.expected);
      expect(state.agents[0].endedAtMs).toBe(1_030_000);
      const lines = renderAgentCards(state, { now: 99_000_000 });
      expect(lines.join("\n")).toContain("[30s]");
    }
  });

  it("kill-on-agent_end: exit (signaled, exitCode=null) does NOT relabel an already-completed card to failed", () => {
    // After spawn.ts SIGTERMs pi on agent_end, the subprocess exits via
    // signal — `child.close` fires with exitCode=null, signal="SIGTERM".
    // Without the exit-branch terminal-state preservation, the trailing
    // `exit` event would relabel the card from `completed` (set on
    // agent_end) to `failed` (because null !== 0). Every successful
    // researcher / planner / reviewer / developer card would then
    // render ✗ failed in the widget.
    let state: WidgetState = upsertAgent(emptyState(), {
      id: "researcher",
      role: "researcher",
      model: "x",
      state: "running",
      startedAtMs: 1_000_000,
    });
    // agent_end → completed.
    vi.spyOn(Date, "now").mockReturnValue(1_065_000);
    state = applyAgentEvent(state, "researcher", { kind: "stdout-json", raw: { type: "agent_end", messages: [] } });
    expect(state.agents[0].state).toBe("completed");
    expect(state.agents[0].endedAtMs).toBe(1_065_000);

    // Trailing exit (signaled): exitCode=null because the kernel
    // delivered SIGTERM, not a clean exit code. MUST preserve completed.
    state = applyAgentEvent(state, "researcher", { kind: "exit", exitCode: null, signal: "SIGTERM" });
    expect(state.agents[0].state).toBe("completed");
    // endedAtMs is preserved at the agent_end time, not bumped by exit.
    expect(state.agents[0].endedAtMs).toBe(1_065_000);
    vi.restoreAllMocks();
  });

  it("exit (clean, exitCode=0) sets state=completed when no prior terminal event was seen", () => {
    // Without a prior agent_end, the exit branch is the authoritative
    // signal. Clean exit → completed; non-zero → failed.
    let state: WidgetState = upsertAgent(emptyState(), {
      id: "planner",
      role: "planner",
      model: "x",
      state: "running",
      startedAtMs: 1_000_000,
    });
    vi.spyOn(Date, "now").mockReturnValue(1_030_000);
    state = applyAgentEvent(state, "planner", { kind: "exit", exitCode: 0, signal: null });
    expect(state.agents[0].state).toBe("completed");

    let state2: WidgetState = upsertAgent(emptyState(), {
      id: "planner-2",
      role: "planner",
      model: "x",
      state: "running",
      startedAtMs: 1_000_000,
    });
    state2 = applyAgentEvent(state2, "planner-2", { kind: "exit", exitCode: 1, signal: null });
    expect(state2.agents[0].state).toBe("failed");
    vi.restoreAllMocks();
  });
});

describe("Bug fix #2: same-role re-spawns re-use one card and increment round", () => {
  it("planner+reviewer 3-round loop produces ONLY 2 cards (one per role), with round=3", async () => {
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

      let plannerCount = 0;
      let reviewerCount = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, _t: AgentTask) => {
        if (member.role === "planner") {
          plannerCount += 1;
          return fakeRun(validPlanText(`draft-${plannerCount}`));
        }
        if (member.role === "reviewer") {
          reviewerCount += 1;
          // round 1 + 2 → REVISE; round 3 → APPROVED
          return fakeRun(reviewerCount < 3 ? REVISE_BODY : APPROVED_BODY);
        }
        return fakeRun("noop");
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        { title: "loop", brief: "go", analysisOverride: null, answersOverride: {} },
        { repoRoot: root, ui, configDefaults: resolveDefaults({ performance: { plan_revision: "full", researcher: "never" } } as never) },
      );

      // Inspect the LAST setWidget render — which lines should it contain?
      const lastRender = setWidgetCalls[setWidgetCalls.length - 1].join("\n");
      // ONE planner line, ONE reviewer line — not 3+3.
      const plannerCards = lastRender.split("\n").filter((l) => l.includes("planner"));
      const reviewerCards = lastRender.split("\n").filter((l) => l.includes("reviewer"));
      expect(plannerCards).toHaveLength(1);
      expect(reviewerCards).toHaveLength(1);
      // Both cards show round 3 (planner: draft+rev1+rev2; reviewer: r1+r2+r3).
      // The user explicitly asked for "round" wording instead of the
      // previous "attempt" — round 3 of the planner-reviewer loop is a
      // normal revise round, not a failure-retry. Same wording as the
      // milestone-bound impl-phase loop.
      expect(plannerCards[0]).toContain("round 3");
      expect(reviewerCards[0]).toContain("round 3");
      expect(plannerCards[0]).not.toContain("attempt");
      expect(reviewerCards[0]).not.toContain("attempt");
    } finally {
      dispose();
    }
  });

  it("explicit agentId override is respected (per-milestone developer keeps separate cards)", async () => {
    // The orchestrator's subscribeAgent honors a caller-supplied id.
    // implement.ts can pass `developer-M3` to keep per-milestone tracking.
    // Direct test against the wiring contract:
    let state = emptyState();
    // Two registrations with different explicit ids → two cards.
    state = upsertAgent(state, { id: "developer-M0", role: "developer", model: "x", state: "running", round: 1 });
    state = upsertAgent(state, { id: "developer-M1", role: "developer", model: "x", state: "running", round: 1 });
    expect(state.agents).toHaveLength(2);
    expect(state.agents.map((a) => a.id)).toEqual(["developer-M0", "developer-M1"]);
  });

  it("widgetAgentId threads through makeSpawnHelper.spawnText(member, task, errorPrefix, agentId)", async () => {
    // Verify the full path: spawnText → subscribeAgent(member, agentId)
    // gets the explicit id, not the default member.role.
    const { makeSpawnHelper } = await import("../src/tools/shared");
    const calls: { member: TeamMember; agentId?: string }[] = [];
    const subscribeAgent = (member: TeamMember, agentId?: string) => {
      calls.push({ member, agentId });
      return { agentId: agentId ?? member.role, onEvent: () => undefined };
    };
    const fakeSpawnAgent = async (_m: TeamMember, _t: AgentTask) => fakeRun("ok");
    const sp = makeSpawnHelper({ spawnAgent: fakeSpawnAgent as never, runReviewLoop: undefined as never, fetchJiraContext: undefined as never }, { subscribeAgent });
    await sp.spawnText({ role: "developer", model: "x" }, { task: "do" }, "err", "developer-M3");
    expect(calls).toHaveLength(1);
    expect(calls[0].agentId).toBe("developer-M3");
  });

  it("late terminal event from an abandoned earlier round does NOT freeze the new round's card", async () => {
    // Simulate the race: subscribe round 1 (myRound=1), subscribe round 2
    // (myRound=2 → card.round becomes 2), THEN round-1's onEvent fires
    // with agent_end. The round-1 listener must be a no-op.
    const { runOrchestrator } = await import("../src/orchestrator/run");
    const { root, dispose } = makeRepo();
    try {
      const setWidgetCalls: Array<unknown[]> = [];
      const ui = {
        select: async () => undefined,
        input: async () => "x",
        confirm: async () => true,
        notify: () => undefined,
        setWidget: (_key: string, lines: unknown) => {
          if (Array.isArray(lines)) setWidgetCalls.push(lines);
        },
      } as never;
      let firstSub: { onEvent: (e: any) => void } | undefined;
      let secondSub: { onEvent: (e: any) => void } | undefined;
      await runOrchestrator(
        {
          repoRoot: root,
          slug: "race",
          toolName: "sf_team_plan",
          useWorktree: false,
          ui,
        },
        async (bodyCtx) => {
          // Round 1 subscription.
          firstSub = bodyCtx.subscribeAgent({ role: "planner", model: "x" });
          // Round 2 subscription — ROUND on the card is now 2.
          secondSub = bodyCtx.subscribeAgent({ role: "planner", model: "x" });
          // Late terminal event from round 1 — should be ignored by guard.
          firstSub.onEvent({ kind: "stdout-json", raw: { type: "agent_end", messages: [] } });
          return "done";
        },
      );
      // Inspect the LAST render: planner card must still show running (▶), not completed (✓).
      const last = setWidgetCalls[setWidgetCalls.length - 1] as string[];
      const plannerLine = last.find((l) => l.includes("planner"))!;
      expect(plannerLine).toMatch(/▶/); // still running
      expect(plannerLine).not.toMatch(/✓/);
    } finally {
      dispose();
    }
  });

  it("`exit` event stamps endedAtMs (additional terminal-path coverage)", () => {
    let state: WidgetState = upsertAgent(emptyState(), {
      id: "planner",
      role: "planner",
      model: "x",
      state: "running",
      startedAtMs: 1_000_000,
    });
    vi.spyOn(Date, "now").mockReturnValue(1_045_000);
    state = applyAgentEvent(state, "planner", { kind: "exit", exitCode: 0, signal: null });
    vi.restoreAllMocks();
    expect(state.agents[0].state).toBe("completed");
    expect(state.agents[0].endedAtMs).toBe(1_045_000);
    const lines = renderAgentCards(state, { now: 9_000_000 });
    expect(lines.join("\n")).toContain("[45s]");
  });
});
