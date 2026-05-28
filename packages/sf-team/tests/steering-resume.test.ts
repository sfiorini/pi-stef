import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePlanSteeringRoot } from "../src/steering/path-safety";
import { reconcileSteeringResume } from "../src/steering/resume";
import { createSteeringStore } from "../src/steering/store";

describe("steering resume reconciliation", () => {
  it("marks persisted running agents as failed when no live process remains", async () => {
    const planRoot = await mkdtemp(path.join(os.tmpdir(), "sf-team-resume-"));
    const store = createSteeringStore({ rootDir: resolvePlanSteeringRoot(planRoot), expectedRoot: planRoot });
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
        pid: 999999,
      },
    ]);

    await reconcileSteeringResume(store, { isProcessAlive: () => false });

    expect(await store.readActiveAgents()).toMatchObject([
      { id: "agent-1", state: "failed", lastEventAt: "resume-no-live-process" },
    ]);
  });

  it("requeues orphaned analyzing and partially-applied instructions without an applied ledger entry", async () => {
    const planRoot = await mkdtemp(path.join(os.tmpdir(), "sf-team-resume-"));
    const store = createSteeringStore({ rootDir: resolvePlanSteeringRoot(planRoot), expectedRoot: planRoot });
    const analyzing = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "Instruction interrupted during analysis.",
      priority: "normal",
    });
    const partial = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "Instruction interrupted during application.",
      priority: "normal",
    });
    await store.updateInstructionStatus(analyzing.id, "analyzing");
    await store.updateInstructionStatus(partial.id, "partially-applied");

    await reconcileSteeringResume(store, { isProcessAlive: () => true });

    expect(await store.listInstructions()).toMatchObject([
      { id: analyzing.id, status: "queued" },
      { id: partial.id, status: "queued" },
    ]);
  });

  it("marks interrupted instructions applied when the applied ledger already contains them", async () => {
    const planRoot = await mkdtemp(path.join(os.tmpdir(), "sf-team-resume-"));
    const store = createSteeringStore({ rootDir: resolvePlanSteeringRoot(planRoot), expectedRoot: planRoot });
    const partial = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "Instruction applied before status write.",
      priority: "normal",
    });
    const analyzing = await store.appendInstruction({
      workflowId: "workflow-1",
      source: "tool",
      text: "Instruction applied before resume.",
      priority: "normal",
    });
    await store.updateInstructionStatus(partial.id, "partially-applied");
    await store.updateInstructionStatus(analyzing.id, "analyzing");
    await store.appendAppliedInstruction({
      instructionId: partial.id,
      decisionId: "decision-partial",
      appliedAt: "2026-05-17T00:00:02.000Z",
    });
    await store.appendAppliedInstruction({
      instructionId: analyzing.id,
      decisionId: "decision-analyzing",
      appliedAt: "2026-05-17T00:00:03.000Z",
    });

    await reconcileSteeringResume(store, { isProcessAlive: () => true });

    expect(await store.listInstructions()).toMatchObject([
      { id: partial.id, status: "applied" },
      { id: analyzing.id, status: "applied" },
    ]);
  });
});
