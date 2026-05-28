import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolvePlanSteeringRoot } from "../src/steering/path-safety";
import { createSteeringStore } from "../src/steering/store";
import { applyAgentControlDecision, combineAbortSignals, composeRestartPrompt } from "../src/steering/agent-control";
import type { ActiveAgentRecord, RunningAgentControl, SteeringDecision, SteeringInstruction } from "../src/steering/types";
import { makeSpawnHelper } from "../src/tools/shared";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

function agent(id: string): ActiveAgentRecord {
  return {
    id,
    role: "developer",
    label: `Developer ${id}`,
    workflowId: "workflow-1",
    startedAt: "2026-05-17T00:00:00.000Z",
    state: "running",
    promptSummary: "Implement the original story",
    promptHash: `hash-${id}`,
    worktreePath: "/tmp/story-worktree",
  };
}

function instruction(): SteeringInstruction {
  return {
    id: "instruction-1",
    workflowId: "workflow-1",
    receivedAt: "2026-05-17T00:00:01.000Z",
    source: "tool",
    text: "Use the narrower implementation.",
    priority: "urgent",
    status: "queued",
  };
}

function decision(kind: SteeringDecision["kind"], patch: Partial<SteeringDecision> = {}): SteeringDecision {
  return {
    id: "decision-1",
    instructionId: "instruction-1",
    decidedAt: "2026-05-17T00:00:02.000Z",
    kind,
    summary: "Apply active-agent control.",
    rationale: "The active developer is affected.",
    planPatchRequired: false,
    targetAgents: [],
    abortAgents: [],
    discardAgentChanges: [],
    affectedMilestones: [],
    affectedStories: [],
    affectedFiles: [],
    risks: [],
    activeAgentsVersion: 1,
    referencedAgentStates: { "agent-1": "running" },
    referencedPlanHashes: {},
    requiresConfirmation: false,
    ...patch,
  };
}

function fakeRun(state: AgentRun["state"], finalText = ""): AgentRun {
  return {
    state,
    pid: 123,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: state === "completed" ? 0 : null,
    finalText,
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    stderrTail: "",
    reason: state === "aborted" ? "restart requested" : undefined,
  };
}

async function mkStore() {
  const planRoot = await mkdtemp(path.join(os.tmpdir(), "sf-team-agent-control-"));
  return createSteeringStore({ rootDir: resolvePlanSteeringRoot(planRoot), expectedRoot: planRoot });
}

describe("steering agent control", () => {
  it("combines root and per-agent abort signals", () => {
    const root = new AbortController();
    const child = new AbortController();
    const combined = combineAbortSignals([root.signal, child.signal]);

    expect(combined?.aborted).toBe(false);
    child.abort("stop child");
    expect(combined?.aborted).toBe(true);
    expect(combined?.reason).toBe("stop child");
  });

  it("aborts only targeted running agents", async () => {
    const store = await mkStore();
    await store.upsertActiveAgents([agent("agent-1"), agent("agent-2")]);
    const abortOne = vi.fn(async () => undefined);
    const abortTwo = vi.fn(async () => undefined);
    const controls = new Map<string, RunningAgentControl>([
      ["agent-1", { abort: abortOne, restart: vi.fn(), waitForExit: vi.fn(), describe: () => agent("agent-1") }],
      ["agent-2", { abort: abortTwo, restart: vi.fn(), waitForExit: vi.fn(), describe: () => agent("agent-2") }],
    ]);

    const result = await applyAgentControlDecision({
      decision: decision("stop-running-agents", { abortAgents: ["agent-1"] }),
      instruction: instruction(),
      controls,
      store,
    });

    expect(result.status).toBe("applied");
    expect(abortOne).toHaveBeenCalledWith("Apply active-agent control.");
    expect(abortTwo).not.toHaveBeenCalled();
  });

  it("passes raw steering instructions to the controlled restart hook", async () => {
    const store = await mkStore();
    await store.upsertActiveAgents([agent("agent-1")]);
    const restart = vi.fn(async (_prompt: string) => undefined);
    const controls = new Map<string, RunningAgentControl>([
      ["agent-1", { abort: vi.fn(), restart, waitForExit: vi.fn(), describe: () => agent("agent-1") }],
    ]);

    const result = await applyAgentControlDecision({
      decision: decision("restart-running-agents", { targetAgents: ["agent-1"] }),
      instruction: instruction(),
      controls,
      store,
    });

    expect(result.status).toBe("applied");
    expect(restart).toHaveBeenCalledWith("Use the narrower implementation.");
  });

  it("passes amended decider guidance to the controlled restart hook when present", async () => {
    const store = await mkStore();
    await store.upsertActiveAgents([agent("agent-1")]);
    const restart = vi.fn(async (_prompt: string) => undefined);
    const controls = new Map<string, RunningAgentControl>([
      ["agent-1", { abort: vi.fn(), restart, waitForExit: vi.fn(), describe: () => agent("agent-1") }],
    ]);

    const result = await applyAgentControlDecision({
      decision: decision("restart-running-agents", {
        targetAgents: ["agent-1"],
        amendedUserFacingPlanText: "Use the Figma MCP tool before reviewing the plan.",
      }),
      instruction: instruction(),
      controls,
      store,
    });

    expect(result.status).toBe("applied");
    expect(restart).toHaveBeenCalledWith("Use the Figma MCP tool before reviewing the plan.");
  });

  it("prefers target-specific restart guidance over global plan guidance", async () => {
    const store = await mkStore();
    await store.upsertActiveAgents([agent("agent-1"), agent("agent-2")]);
    const restartOne = vi.fn(async (_prompt: string) => undefined);
    const restartTwo = vi.fn(async (_prompt: string) => undefined);
    const controls = new Map<string, RunningAgentControl>([
      ["agent-1", { abort: vi.fn(), restart: restartOne, waitForExit: vi.fn(), describe: () => agent("agent-1") }],
      ["agent-2", { abort: vi.fn(), restart: restartTwo, waitForExit: vi.fn(), describe: () => agent("agent-2") }],
    ]);

    const result = await applyAgentControlDecision({
      decision: decision("restart-running-agents", {
        targetAgents: ["agent-1", "agent-2"],
        amendedUserFacingPlanText: "Global plan guidance for affected future work.",
        agentRestartInstructions: {
          "agent-1": "Specific restart guidance for agent one.",
        },
      }),
      instruction: instruction(),
      controls,
      store,
    });

    expect(result.status).toBe("applied");
    expect(restartOne).toHaveBeenCalledWith("Specific restart guidance for agent one.");
    expect(restartTwo).toHaveBeenCalledWith("Global plan guidance for affected future work.");
  });

  it("keeps queue-for-safe-boundary as a non-destructive no-op", async () => {
    const store = await mkStore();
    const result = await applyAgentControlDecision({
      decision: decision("queue-for-safe-boundary"),
      instruction: instruction(),
      controls: new Map(),
      store,
    });

    expect(result).toMatchObject({
      status: "applied",
      actions: [{ actionKind: "queue-for-safe-boundary", status: "completed" }],
    });
  });

  it("builds restart prompts with the required context sections", () => {
    const prompt = composeRestartPrompt({
      originalTaskSummary: "Original summary",
      steeringInstruction: "New instruction",
      priorPartialStatus: "Prior status",
    });

    expect(prompt).toContain("Original task summary:\nOriginal summary");
    expect(prompt).toContain("New steering instruction:\nNew instruction");
    expect(prompt).toContain("Prior partial status:\nPrior status");
  });

  it("makeSpawnHelper restarts a controlled child without aborting the root workflow", async () => {
    const member: TeamMember = { role: "developer", model: "test-model" };
    const store = await mkStore();
    const controls = new Map<string, RunningAgentControl>();
    const updates: Array<{ id: string; patch: Partial<ActiveAgentRecord> }> = [];
    const unregistered: Array<{ id: string; state: string }> = [];
    const spawnAgent = vi.fn(async (_member: TeamMember, task: AgentTask, opts?: { onSpawn?: (info: { pid?: number; startedAtMs: number }) => void; onEvent?: (event: { kind: "stderr"; text: string }) => void }) => {
      opts?.onSpawn?.({ pid: 100 + spawnAgent.mock.calls.length, startedAtMs: Date.now() });
      opts?.onEvent?.({ kind: "stderr", text: "working" });
      if (spawnAgent.mock.calls.length === 1) {
        await applyAgentControlDecision({
          decision: decision("restart-running-agents", {
            targetAgents: ["developer-S-101"],
            referencedAgentStates: { "developer-S-101": "running" },
          }),
          instruction: { ...instruction(), text: "Use a smaller patch." },
          controls,
          store,
        });
        expect(task.signal?.aborted).toBe(true);
        return fakeRun("aborted");
      }
      return fakeRun("completed", "done after restart");
    });
    const sp = makeSpawnHelper(
      {
        spawnAgent: spawnAgent as never,
        runReviewLoop: vi.fn() as never,
        fetchJiraContext: vi.fn() as never,
      },
      {
        steering: {
          workflowId: "workflow-1",
          async registerAgent(record, c) {
            controls.set(record.id, c);
            await store.upsertActiveAgents([record]);
          },
          async updateAgent(id, patch) {
            updates.push({ id, patch });
            await store.patchActiveAgent(id, patch);
          },
          async unregisterAgent(id, state) {
            unregistered.push({ id, state });
            await store.patchActiveAgent(id, { state, lastEventAt: new Date().toISOString() });
            controls.delete(id);
          },
        },
        subscribeAgent: () => ({
          agentId: "developer-S-101",
          spawnKey: "developer-S-101#1",
          onEvent: () => undefined,
        }),
      },
    );

    const originalTask = [
      "Implement story S-101.",
      "x".repeat(650),
      "MUST_KEEP_FULL_JIRA_FIGMA_CONTEXT",
    ].join("\n");

    const text = await sp.spawnText(
      member,
      { task: originalTask, cwd: "/tmp/story", signal: new AbortController().signal },
      "developer failed",
      "developer-S-101",
      { milestoneId: "M1", storyId: "S-101" },
    );

    expect(text).toBe("done after restart");
    expect(spawnAgent).toHaveBeenCalledTimes(2);
    const restartedTask = (spawnAgent.mock.calls[1][1] as AgentTask).task;
    expect(restartedTask).toContain("New steering instruction:\nUse a smaller patch.");
    expect(restartedTask).toContain("MUST_KEEP_FULL_JIRA_FIGMA_CONTEXT");
    expect(restartedTask.match(/Restart this agent run/g) ?? []).toHaveLength(1);
    expect(updates.some((entry) => entry.patch.pid !== undefined)).toBe(true);
    expect(unregistered.at(-1)).toEqual({ id: "developer-S-101", state: "completed" });
  });
});
