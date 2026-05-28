import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createSteeringDrain } from "../src/steering/drain";
import { resolvePlanSteeringRoot } from "../src/steering/path-safety";
import { buildSteeringSnapshot } from "../src/steering/snapshot";
import { createSteeringStore } from "../src/steering/store";
import type { SteeringDecision } from "../src/steering/types";

async function mkStore() {
  const planRoot = await mkdtemp(path.join(os.tmpdir(), "sf-team-drain-"));
  return createSteeringStore({ rootDir: resolvePlanSteeringRoot(planRoot), expectedRoot: planRoot });
}

function decision(instructionId: string, version: number): SteeringDecision {
  return {
    id: `decision-${instructionId}`,
    instructionId,
    decidedAt: "2026-05-17T00:00:01.000Z",
    kind: "apply-to-future",
    summary: "Apply future context",
    rationale: "No active child needs control.",
    planPatchRequired: false,
    targetAgents: [],
    abortAgents: [],
    discardAgentChanges: [],
    affectedMilestones: [],
    affectedStories: [],
    affectedFiles: [],
    risks: [],
    activeAgentsVersion: version,
    referencedAgentStates: {},
    referencedPlanHashes: {},
    requiresConfirmation: false,
  };
}

describe("steering drain", () => {
  it("marks queued instructions applied after persisting decisions", async () => {
    const store = await mkStore();
    const instruction = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "Update next prompt.",
      priority: "normal",
    });
    const drain = createSteeringDrain({
      workflowId: "workflow-1",
      workflowKind: "implement",
      store,
      decide: async ({ snapshot }) => decision(instruction.id, snapshot.activeAgentsVersion),
    });

    const result = await drain("before-agent-spawn");

    expect(result).toMatchObject({
      processedInstructionIds: [instruction.id],
      appliedDecisionIds: [`decision-${instruction.id}`],
      pausedForConfirmation: false,
    });
    expect(await store.listInstructions()).toMatchObject([{ id: instruction.id, status: "applied" }]);
    expect(await store.listDecisions()).toMatchObject([{ instructionId: instruction.id }]);
    expect(await store.listAppliedInstructions()).toMatchObject([
      { instructionId: instruction.id, decisionId: `decision-${instruction.id}` },
    ]);
  });

  it("requeues decisions whose referenced active-agent state changed", async () => {
    const store = await mkStore();
    await store.upsertActiveAgents([
      {
        id: "agent-1",
        role: "developer",
        label: "Developer",
        workflowId: "workflow-1",
        startedAt: "2026-05-17T00:00:00.000Z",
        state: "running",
        promptSummary: "Do work",
        promptHash: "hash",
      },
    ]);
    const instruction = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "Restart the developer.",
      priority: "urgent",
    });
    const drain = createSteeringDrain({
      workflowId: "workflow-1",
      workflowKind: "implement",
      store,
      decide: async ({ snapshot }) => {
        await store.patchActiveAgent("agent-1", { state: "completed" });
        return {
          ...decision(instruction.id, snapshot.activeAgentsVersion),
          referencedAgentStates: { "agent-1": "running" },
        };
      },
    });

    const result = await drain("explicit-steer-wake");

    expect(result.processedInstructionIds).toEqual([instruction.id]);
    expect(await store.listInstructions()).toMatchObject([{ id: instruction.id, status: "queued" }]);
    expect(await store.listAgentActions()).toMatchObject([
      {
        instructionId: instruction.id,
        decisionId: `decision-${instruction.id}`,
        actionKind: "noop",
        status: "skipped",
        summary: "Skipped stale steering decision; requeued instruction for a fresh decision.",
      },
    ]);
  });

  it("applies decisions when only active-agent heartbeat version changed", async () => {
    const store = await mkStore();
    await store.upsertActiveAgents([
      {
        id: "agent-1",
        role: "developer",
        label: "Developer",
        workflowId: "workflow-1",
        startedAt: "2026-05-17T00:00:00.000Z",
        state: "running",
        promptSummary: "Do work",
        promptHash: "hash",
      },
    ]);
    const instruction = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "Apply this while the child is still running.",
      priority: "normal",
    });
    const drain = createSteeringDrain({
      workflowId: "workflow-1",
      workflowKind: "implement",
      store,
      decide: async ({ snapshot }) => {
        await store.patchActiveAgent("agent-1", { lastEventAt: "2026-05-17T00:00:05.000Z" });
        return {
          ...decision(instruction.id, snapshot.activeAgentsVersion),
          referencedAgentStates: { "agent-1": "running" },
        };
      },
    });

    const result = await drain("child-active-tick");

    expect(result.appliedDecisionIds).toEqual([`decision-${instruction.id}`]);
    expect(await store.listInstructions()).toMatchObject([{ id: instruction.id, status: "applied" }]);
    expect(await store.listAgentActions()).toMatchObject([
      {
        instructionId: instruction.id,
        decisionId: `decision-${instruction.id}`,
        actionKind: "noop",
        status: "completed",
      },
    ]);
  });

  it("pauses instructions that require confirmation", async () => {
    const store = await mkStore();
    const instruction = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "Discard the active worktree.",
      priority: "urgent",
    });
    const drain = createSteeringDrain({
      workflowId: "workflow-1",
      workflowKind: "implement",
      store,
      decide: async ({ snapshot }) => ({
        ...decision(instruction.id, snapshot.activeAgentsVersion),
        kind: "discard-running-agent-changes",
        discardAgentChanges: ["agent-1"],
        requiresConfirmation: true,
      }),
    });

    const result = await drain("before-story-complete");

    expect(result.pausedForConfirmation).toBe(true);
    expect(await store.listInstructions()).toMatchObject([{ id: instruction.id, status: "requires-user-confirmation" }]);
  });

  it("records failed decisions to transcript", async () => {
    const store = await mkStore();
    const instruction = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "This will fail.",
      priority: "normal",
    });
    const records: Array<{ label: string; status?: string; body: string }> = [];
    const drain = createSteeringDrain({
      workflowId: "workflow-1",
      workflowKind: "implement",
      store,
      transcript: {
        setPhase: () => undefined,
        folder: () => "/tmp",
        record: async (entry) => {
          records.push({ label: entry.label, status: entry.status, body: entry.body });
          return "/tmp/transcript.md";
        },
      },
      decide: async () => {
        const error = new Error("bad decision") as Error & { code?: string; rawDecision?: unknown };
        error.code = "STEER_UNKNOWN_ACTION_SHAPE";
        error.rawDecision = { actions: [{ type: "rewrite_plan" }] };
        throw error;
      },
    });

    const result = await drain("before-agent-spawn");

    expect(result.errors).toEqual([{ instructionId: instruction.id, message: "bad decision" }]);
    expect(records.map((record) => record.label)).toEqual([
      "steering-instruction-received",
      "steering-decision-failed",
    ]);
    expect(records[1].status).toBe("FAILED");
    expect(records[1].label).toBe("steering-decision-failed");
    // M4: per-instruction audit body is a structured JSON blob containing
    // the instruction, error details, and (when present) the sanitized
    // raw output. We assert the message is reachable rather than
    // expecting the legacy plain-text body.
    expect(records[1].body).toContain("bad decision");
    const failedSnapshot = JSON.parse(await readFile(path.join(store.rootDir, "snapshots", `${instruction.id}-failed.json`), "utf8"));
    expect(failedSnapshot).toMatchObject({
      instructionId: instruction.id,
      errorCode: "STEER_UNKNOWN_ACTION_SHAPE",
      errorMessage: "bad decision",
      rawDecision: { actions: [{ type: "rewrite_plan" }] },
      before: { workflowId: "workflow-1" },
    });
  });
});

describe("steering snapshot", () => {
  it("includes active-agent version and states", async () => {
    const store = await mkStore();
    await store.upsertActiveAgents([
      {
        id: "agent-1",
        role: "developer",
        label: "Developer",
        workflowId: "workflow-1",
        startedAt: "2026-05-17T00:00:00.000Z",
        state: "running",
        promptSummary: "Do work",
        promptHash: "hash",
      },
    ]);

    const snapshot = await buildSteeringSnapshot({
      workflowId: "workflow-1",
      workflowKind: "implement",
      store,
      currentMilestoneId: "M1",
      currentStoryId: "S-101",
    });

    expect(snapshot).toMatchObject({
      activeAgentsVersion: 1,
      referencedAgentStates: { "agent-1": "running" },
      currentMilestoneId: "M1",
      currentStoryId: "S-101",
    });
  });
});
