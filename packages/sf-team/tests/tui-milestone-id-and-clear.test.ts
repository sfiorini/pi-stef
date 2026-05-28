import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { renderAgentCards } from "../src/tui/agent-card";
import { clearAgents, emptyState, upsertAgent, type AgentCard } from "../src/tui/state";

const T_NOW = 1_700_000_000_000; // fixed wall-clock for deterministic elapsed
const STARTED_60S_AGO = T_NOW - 60_000;

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    id: "developer-M1",
    role: "developer",
    model: "anthropic/claude-sonnet-4-6",
    state: "running",
    startedAtMs: STARTED_60S_AGO,
    ...over,
  };
}

describe("renderAgentCards renders the milestone id", () => {
  it("renders `· M1` for round=1 (no round suffix on first round) when milestoneId is set", () => {
    const state = upsertAgent(emptyState(), card({ milestoneId: "M1", round: 1 }));
    const lines = renderAgentCards(state, { now: T_NOW, useColor: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/developer \(anthropic\/claude-sonnet-4-6\) \[1m00s\] · M1$/);
  });

  it("renders the story id beside the milestone for parallel story agents", () => {
    const state = upsertAgent(emptyState(), {
      ...card({ milestoneId: "M1", round: 1 }),
      storyId: "S-101",
    } as AgentCard);
    const lines = renderAgentCards(state, { now: T_NOW, useColor: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/developer \(anthropic\/claude-sonnet-4-6\) \[1m00s\] · M1 - S101$/);
  });

  it("round=1 is suppressed regardless of milestoneId (round suffix only appears for N > 1)", () => {
    // Round 1 is the implicit default — showing `· round 1` adds noise
    // for both plan-phase singletons and impl-phase milestone-bound
    // agents. The round counter only surfaces when it actually conveys
    // information (the agent has been re-spawned).
    const noMilestone = upsertAgent(emptyState(), card({ id: "planner", role: "planner", round: 1 }));
    expect(renderAgentCards(noMilestone, { now: T_NOW, useColor: false })[0]).not.toMatch(/round/);

    const withMilestone = upsertAgent(emptyState(), card({ milestoneId: "M2", round: 1 }));
    const withMilestoneHead = renderAgentCards(withMilestone, { now: T_NOW, useColor: false })[0];
    expect(withMilestoneHead).toMatch(/· M2$/);
    expect(withMilestoneHead).not.toMatch(/round/);
  });

  it("non-milestone agent at round=3 renders `· round 3` (review-loop revision, not failure-retry)", () => {
    const state = upsertAgent(emptyState(), card({ id: "planner", role: "planner", round: 3 }));
    const head = renderAgentCards(state, { now: T_NOW, useColor: false })[0];
    // Round 3 of the planner-reviewer loop is a normal revise round —
    // the user explicitly asked for "round" wording, not "attempt"
    // (which incorrectly implied a failure-retry).
    expect(head).toMatch(/planner \(anthropic\/claude-sonnet-4-6\) \[1m00s\] · round 3$/);
    expect(head).not.toMatch(/M\d+/);
    expect(head).not.toMatch(/attempt/);
  });

  it("milestoneId + round=2: shows the milestone AND the round", () => {
    const state = upsertAgent(emptyState(), card({ milestoneId: "M3", round: 2 }));
    const head = renderAgentCards(state, { now: T_NOW, useColor: false })[0];
    expect(head).toMatch(/· M3 · round 2$/);
  });
});

describe("clearAgents preserves non-agent widget state", () => {
  it("drops every agent card", () => {
    let state = upsertAgent(emptyState(), card({ id: "a", role: "developer" }));
    state = upsertAgent(state, card({ id: "b", role: "reviewer" }));
    expect(state.agents).toHaveLength(2);
    const cleared = clearAgents(state);
    expect(cleared.agents).toEqual([]);
  });

  it("preserves milestones, resume, lockState (only agents reset)", () => {
    const seeded = {
      ...emptyState(),
      milestones: [
        { id: "M1", title: "First", completed: 0, inDev: 1, total: 3 },
      ],
      resume: { show: true, text: "Resumed previous run" },
      lockState: { holderPid: 1234, sinceIso: "2026-05-02T00:00:00Z" },
    };
    const stateWithAgent = upsertAgent(seeded, card({ id: "x" }));
    const cleared = clearAgents(stateWithAgent);
    expect(cleared.agents).toEqual([]);
    expect(cleared.milestones).toEqual(seeded.milestones);
    expect(cleared.resume).toEqual(seeded.resume);
    expect(cleared.lockState).toEqual(seeded.lockState);
  });

  it("is idempotent: clearAgents on a state with no agents returns the same state reference", () => {
    const s = emptyState();
    expect(clearAgents(s)).toBe(s); // identity short-circuit when nothing to drop
  });
});

describe("orchestrator end-to-end: bodyCtx.clearAgents() empties the widget; subscribeAgent stamps milestoneId", () => {
  function makeRepo(): { root: string; dispose: () => void } {
    const root = mkdtempSync(path.join(tmpdir(), "tui-clear-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
    spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
    return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("subscribeAgent(member, id, { milestoneId, storyId }) records milestone/story labels on the card; clearAgents drops both", async () => {
    const { runOrchestrator } = await import("../src/orchestrator/run");
    const { root, dispose } = makeRepo();
    try {
      const widgetSnapshots: string[][] = [];
      const ui = {
        select: async () => undefined,
        input: async () => "x",
        confirm: async () => true,
        notify: () => undefined,
        setWidget: (_key: string, lines: unknown) => {
          if (Array.isArray(lines)) widgetSnapshots.push(lines as string[]);
        },
      } as never;
      await runOrchestrator(
        { repoRoot: root, slug: "clear-test", toolName: "sf_team_implement", useWorktree: true, ui },
        async (bodyCtx) => {
          // M1: dev + reviewer both stamped with milestoneId.
          bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "developer-M1-S101", { milestoneId: "M1", storyId: "S-101" });
          bodyCtx.subscribeAgent({ role: "reviewer", model: "r" }, "reviewer-M1", { milestoneId: "M1" });
          // Snapshot WHILE M1 cards are present — must include "· M1" lines.
          const m1 = widgetSnapshots[widgetSnapshots.length - 1];
          expect(m1.some((l) => /developer.*· M1 - S101/.test(l))).toBe(true);
          expect(m1.some((l) => /reviewer.*· M1/.test(l))).toBe(true);

          // Boundary: clear before M2.
          bodyCtx.clearAgents();
          const cleared = widgetSnapshots[widgetSnapshots.length - 1];
          // No agent lines: the renderer's empty-state placeholder appears.
          expect(cleared.some((l) => l.includes("(no active agents)"))).toBe(true);
          expect(cleared.some((l) => /developer.*M1/.test(l))).toBe(false);
          expect(cleared.some((l) => /reviewer.*M1/.test(l))).toBe(false);

          // M2: only M2 cards visible after subscribing.
          bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "developer-M2", { milestoneId: "M2" });
          const m2 = widgetSnapshots[widgetSnapshots.length - 1];
          expect(m2.some((l) => /developer.*· M2/.test(l))).toBe(true);
          // Critically: no leftover M1 lines.
          expect(m2.some((l) => /· M1/.test(l))).toBe(false);
          return "ok";
        },
      );
    } finally {
      dispose();
    }
  });
});
