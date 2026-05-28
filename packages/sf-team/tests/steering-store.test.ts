import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePlanSteeringRoot, resolveRunSteeringRoot } from "../src/steering/path-safety";
import { createSteeringStore } from "../src/steering/store";
import type { ActiveAgentRecord, SteeringDecision } from "../src/steering/types";

async function mkTempRoot(name: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return await mkdtemp(path.join(os.tmpdir(), `sf-team-${name}-`));
}

function agent(id: string): ActiveAgentRecord {
  return {
    id,
    role: "developer",
    label: `Developer ${id}`,
    workflowId: "workflow-1",
    startedAt: "2026-05-17T00:00:00.000Z",
    state: "running",
    promptSummary: "Implement a story",
    promptHash: `hash-${id}`,
  };
}

function decision(id: string, instructionId: string): SteeringDecision {
  return {
    id,
    instructionId,
    decidedAt: "2026-05-17T00:00:01.000Z",
    kind: "apply-to-future",
    summary: "Apply future guidance",
    rationale: "The instruction only affects future prompts.",
    planPatchRequired: false,
    targetAgents: [],
    abortAgents: [],
    discardAgentChanges: [],
    affectedMilestones: [],
    affectedStories: [],
    affectedFiles: [],
    risks: [],
    activeAgentsVersion: 0,
    referencedAgentStates: {},
    referencedPlanHashes: {},
    requiresConfirmation: false,
  };
}

describe("steering path safety", () => {
  it("resolves plan and run steering paths inside their expected roots", async () => {
    const planRoot = await mkTempRoot("plan-root");
    const runtimeRoot = await mkTempRoot("runtime-root");

    expect(resolvePlanSteeringRoot(planRoot)).toBe(path.join(planRoot, ".fh-workflow", "steering"));
    expect(resolveRunSteeringRoot(runtimeRoot, "fhw_task_20260517000000_abcdef12")).toBe(
      path.join(runtimeRoot, ".sf-team", "runs", "fhw_task_20260517000000_abcdef12", "steering"),
    );
  });

  it("rejects traversal while resolving run steering paths", async () => {
    const runtimeRoot = await mkTempRoot("runtime-root");

    expect(() => resolveRunSteeringRoot(runtimeRoot, "../outside")).toThrow(/Invalid steering run id/);
  });

  it("rejects store roots outside the expected workflow root", async () => {
    const expectedRoot = await mkTempRoot("expected-root");
    const outsideRoot = await mkTempRoot("outside-root");

    expect(() => createSteeringStore({ rootDir: outsideRoot, expectedRoot })).toThrow(/outside expected root/);
  });
});

describe("steering store", () => {
  it("appends and reloads instructions, decisions, and active-agent state", async () => {
    const planRoot = await mkTempRoot("store-root");
    const rootDir = resolvePlanSteeringRoot(planRoot);
    const store = createSteeringStore({ rootDir, expectedRoot: planRoot });

    const instruction = await store.appendInstruction({
      workflowId: "workflow-1",
      planSlug: "plan-a",
      source: "tool",
      text: "Prefer a narrower implementation.",
      priority: "normal",
    });
    await store.updateInstructionStatus(instruction.id, "analyzing");
    await store.updateInstructionStatus(instruction.id, "analyzing");
    await store.appendDecision(decision("decision-1", instruction.id));
    await store.appendAppliedInstruction({
      instructionId: instruction.id,
      decisionId: "decision-1",
      appliedAt: "2026-05-17T00:00:02.000Z",
    });
    await store.appendAppliedInstruction({
      instructionId: instruction.id,
      decisionId: "decision-1-duplicate",
      appliedAt: "2026-05-17T00:00:03.000Z",
    });
    await store.writeActiveAgents([agent("agent-1")]);

    const reloaded = createSteeringStore({ rootDir, expectedRoot: planRoot });
    expect(await reloaded.listInstructions()).toMatchObject([{ id: instruction.id, status: "analyzing" }]);
    expect(await reloaded.listDecisions()).toMatchObject([{ id: "decision-1", instructionId: instruction.id }]);
    expect(await reloaded.listAppliedInstructions()).toEqual([
      {
        instructionId: instruction.id,
        decisionId: "decision-1",
        appliedAt: "2026-05-17T00:00:02.000Z",
      },
    ]);
    expect(await reloaded.readActiveAgents()).toMatchObject([{ id: "agent-1", state: "running" }]);
  });

  it("replaces active-agent state when writeActiveAgents is used", async () => {
    const planRoot = await mkTempRoot("replace-root");
    const store = createSteeringStore({ rootDir: resolvePlanSteeringRoot(planRoot), expectedRoot: planRoot });

    await store.writeActiveAgents([agent("agent-1"), agent("agent-2")]);
    await store.writeActiveAgents([agent("agent-2")]);

    expect(await store.readActiveAgents()).toMatchObject([{ id: "agent-2" }]);
  });

  it("tolerates malformed JSONL entries while reading valid instructions", async () => {
    const planRoot = await mkTempRoot("malformed-root");
    const rootDir = resolvePlanSteeringRoot(planRoot);
    const store = createSteeringStore({ rootDir, expectedRoot: planRoot });
    const instruction = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "Valid instruction",
      priority: "normal",
    });

    await writeFile(path.join(rootDir, "inbox.jsonl"), "\nnot-json\n", { flag: "a" });

    expect(await store.listInstructions()).toMatchObject([{ id: instruction.id, text: "Valid instruction" }]);
  });

  it("rejects oversized instructions before appending", async () => {
    const planRoot = await mkTempRoot("length-root");
    const store = createSteeringStore({
      rootDir: resolvePlanSteeringRoot(planRoot),
      expectedRoot: planRoot,
      config: { maxInstructionChars: 5 },
    });

    await expect(
      store.appendInstruction({
        workflowId: "workflow-1",
        source: "tool",
        text: "too long",
        priority: "normal",
      }),
    ).rejects.toThrow(/exceeds maximum/);

    expect(await store.listInstructions()).toEqual([]);
  });

  it("preserves concurrent active-agent registrations", async () => {
    const planRoot = await mkTempRoot("concurrent-root");
    const rootDir = resolvePlanSteeringRoot(planRoot);
    const store = createSteeringStore({ rootDir, expectedRoot: planRoot });

    await Promise.all([
      store.upsertActiveAgents([agent("agent-1")]),
      store.upsertActiveAgents([agent("agent-2")]),
      store.upsertActiveAgents([agent("agent-2")]),
    ]);

    const records = await store.readActiveAgents();
    expect(records.map((record) => record.id).sort()).toEqual(["agent-1", "agent-2"]);

    const raw = JSON.parse(await readFile(path.join(rootDir, "active-agents.json"), "utf8")) as { version: number };
    expect(raw.version).toBe(3);
  });

  it("removes active agents by id", async () => {
    const planRoot = await mkTempRoot("remove-root");
    const rootDir = resolvePlanSteeringRoot(planRoot);
    const store = createSteeringStore({ rootDir, expectedRoot: planRoot });

    await store.upsertActiveAgents([agent("agent-1"), agent("agent-2")]);
    await store.removeActiveAgents(["agent-1"]);

    expect(await store.readActiveAgents()).toMatchObject([{ id: "agent-2" }]);
    const raw = JSON.parse(await readFile(path.join(rootDir, "active-agents.json"), "utf8")) as { version: number };
    expect(raw.version).toBe(2);
  });
});
