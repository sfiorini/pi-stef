import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSteeringDrain } from "../src/steering/drain";
import { createSteeringStore } from "../src/steering/store";
import type { SteeringDecision } from "../src/steering/types";

function makeApplyToFutureDecision(instructionId: string, snapshot: { activeAgentsVersion: number }): SteeringDecision {
  return {
    id: `decision-${instructionId}`,
    instructionId,
    decidedAt: "2026-05-19T00:00:00.000Z",
    kind: "apply-to-future",
    summary: "Apply to future.",
    rationale: "Non-destructive.",
    planPatchRequired: false,
    targetAgents: [],
    abortAgents: [],
    discardAgentChanges: [],
    affectedMilestones: [],
    affectedStories: [],
    affectedFiles: [],
    risks: [],
    activeAgentsVersion: snapshot.activeAgentsVersion,
    referencedAgentStates: {},
    referencedPlanHashes: {},
    requiresConfirmation: false,
    scopeKind: "workflow",
    guidanceText: "Future agents must mock the backend.",
  };
}

describe("drain: apply-to-future guidance ordering", () => {
  let rootDir: string;
  let planFolder: string;
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "drain-guidance-"));
    planFolder = path.join(repoRoot, "ai_plan", "demo-plan");
    rootDir = path.join(planFolder, "steering");
    await mkdir(rootDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("appends guidance (pending) → marks applied → activates → writes plan-note in that order", async () => {
    const store = createSteeringStore({ rootDir, expectedRoot: planFolder });
    const instruction = await store.appendInstruction({
      workflowId: "wf-1", source: "tool", text: "mock the backend", priority: "normal",
    });

    const drain = createSteeringDrain({
      workflowId: "wf-1",
      workflowKind: "task",
      store,
      repoRoot,
      planFolderPath: planFolder,
      decide: async (input) => makeApplyToFutureDecision(instruction.id, input.snapshot),
    });

    const result = await drain("workflow-start");
    expect(result.errors).toEqual([]);
    expect(result.appliedDecisionIds).toEqual([`decision-${instruction.id}`]);

    const inst = (await store.listInstructions())[0];
    expect(inst.status).toBe("applied");

    const guidance = await store.listActiveGuidance();
    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toMatchObject({
      instructionId: instruction.id,
      scope: { kind: "workflow" },
      text: "Future agents must mock the backend.",
      status: "active",
    });

    const planBody = await readFile(path.join(planFolder, "milestone-plan.md"), "utf8");
    expect(planBody).toContain("## Steering Notes");
    expect(planBody).toContain(`source: tool:${instruction.id}`);
  });

  it("plan-note write failure does NOT roll back guidance activation (best-effort)", async () => {
    const store = createSteeringStore({ rootDir, expectedRoot: planFolder });
    const instruction = await store.appendInstruction({
      workflowId: "wf-1", source: "tool", text: "x", priority: "normal",
    });

    // Use an invalid planFolderPath so the plan-note appender fails.
    const drain = createSteeringDrain({
      workflowId: "wf-1",
      workflowKind: "task",
      store,
      repoRoot,
      planFolderPath: "/tmp/outside-repo-root",
      decide: async (input) => makeApplyToFutureDecision(instruction.id, input.snapshot),
    });

    const result = await drain("workflow-start");
    expect(result.errors).toEqual([]); // best-effort: failure does not propagate
    expect(result.appliedDecisionIds).toEqual([`decision-${instruction.id}`]);

    const inst = (await store.listInstructions())[0];
    expect(inst.status).toBe("applied");

    const active = await store.listActiveGuidance();
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe("active");
  });

  it("on activation failure, expires pending-activation row with reason activation-aborted", async () => {
    const store = createSteeringStore({ rootDir, expectedRoot: planFolder });
    const instruction = await store.appendInstruction({
      workflowId: "wf-1", source: "tool", text: "x", priority: "normal",
    });

    // Wrap store so updateInstructionStatus throws when transitioning to "applied".
    let crashed = false;
    const wrappedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "updateInstructionStatus") {
          return async (id: string, status: string) => {
            if (!crashed && status === "applied") {
              crashed = true;
              throw new Error("simulated crash during status update");
            }
            return await target.updateInstructionStatus(id, status as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const drain = createSteeringDrain({
      workflowId: "wf-1",
      workflowKind: "task",
      store: wrappedStore,
      repoRoot,
      planFolderPath: planFolder,
      decide: async (input) => makeApplyToFutureDecision(instruction.id, input.snapshot),
    });

    const result = await drain("workflow-start");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].instructionId).toBe(instruction.id);

    const all = await store.listGuidance();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "expired", expireReason: "activation-aborted" });
  });
});

/**
 * Stub WorkflowReporter that records every `reporter.message(text, opts)`
 * call as an entry on the `calls` array. The drain emits one
 * `sf-team steering: analyzing instruction ...` message before applying
 * (drain/index.ts:201) plus additional reporter messages on various
 * branches, so these tests filter the recorded calls for the literal
 * `sf_team_steer: applied instruction ` prefix and assert on the filtered
 * subset — never on total call count.
 */
function makeStubReporter() {
  const calls: Array<{ text: string; opts?: { level?: string } }> = [];
  const reporter = {
    message(text: string, opts?: { level?: string }): string {
      calls.push({ text, opts });
      return "stub";
    },
    clearMessage(): void {},
    dispose(): void {},
  } as unknown as import("@pi-stef/agent-workflows").WorkflowReporter;
  return { reporter, calls } as const;
}

function appliedMessagesFor(
  calls: Array<{ text: string; opts?: { level?: string } }>,
  _instructionId: string,
): Array<{ text: string; opts?: { level?: string } }> {
  return calls.filter((c) => c.text.startsWith("sf_team_steer: applied instruction "));
}

describe("drain: sf_team_steer applied notification", () => {
  let rootDir: string;
  let planFolder: string;
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "drain-applied-notify-"));
    planFolder = path.join(repoRoot, "ai_plan", "demo-plan");
    rootDir = path.join(planFolder, "steering");
    await mkdir(rootDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("positive — apply-to-future success emits exactly one sf_team_steer: applied instruction <id> at info level", async () => {
    const store = createSteeringStore({ rootDir, expectedRoot: planFolder });
    const instruction = await store.appendInstruction({
      workflowId: "wf-1", source: "tool", text: "mock the backend", priority: "normal",
    });
    const { reporter, calls } = makeStubReporter();
    const drain = createSteeringDrain({
      workflowId: "wf-1",
      workflowKind: "task",
      store,
      repoRoot,
      planFolderPath: planFolder,
      reporter,
      decide: async (input) => makeApplyToFutureDecision(instruction.id, input.snapshot),
    });

    const result = await drain("workflow-start");
    expect(result.errors).toEqual([]);
    expect(result.appliedDecisionIds).toEqual([`decision-${instruction.id}`]);

    const applied = appliedMessagesFor(calls, instruction.id);
    expect(applied).toHaveLength(1);
    // Exact-equality (toEqual): a `(apply-to-future)` suffix would fail.
    expect(applied[0].text).toEqual(`sf_team_steer: applied instruction ${instruction.id}`);
    expect(applied[0].opts).toEqual({ level: "info" });
  });

  it("negative — stale-snapshot requeue does NOT emit the applied notification", async () => {
    const store = createSteeringStore({ rootDir, expectedRoot: planFolder });
    const instruction = await store.appendInstruction({
      workflowId: "wf-1", source: "tool", text: "x", priority: "normal",
    });
    const { reporter, calls } = makeStubReporter();
    const drain = createSteeringDrain({
      workflowId: "wf-1",
      workflowKind: "task",
      store,
      repoRoot,
      planFolderPath: planFolder,
      reporter,
      // Make isDecisionSnapshotStale(decision, after) return true by giving
      // the decision a referencedPlanHashes entry the snapshot does not
      // carry: `{"foo": "stale"}` vs the snapshot's `{}`.
      decide: async (input) => ({
        ...makeApplyToFutureDecision(instruction.id, input.snapshot),
        referencedPlanHashes: { foo: "stale" },
      }),
    });

    const result = await drain("workflow-start");
    expect(result.appliedDecisionIds).toEqual([]); // not applied
    expect(appliedMessagesFor(calls, instruction.id)).toEqual([]);
    // Instruction is requeued.
    const inst = (await store.listInstructions())[0];
    expect(inst.status).toBe("queued");
  });

  it("negative — paused-for-confirmation does NOT emit the applied notification", async () => {
    const store = createSteeringStore({ rootDir, expectedRoot: planFolder });
    const instruction = await store.appendInstruction({
      workflowId: "wf-1", source: "tool", text: "x", priority: "normal",
    });
    const { reporter, calls } = makeStubReporter();
    const drain = createSteeringDrain({
      workflowId: "wf-1",
      workflowKind: "task",
      store,
      repoRoot,
      planFolderPath: planFolder,
      reporter,
      // Decider returns amend-plan so the plan-applier path is taken.
      decide: async (input) => ({
        ...makeApplyToFutureDecision(instruction.id, input.snapshot),
        kind: "amend-plan",
        planPatchRequired: true,
      }),
      // Plan-applier returns requires-user-confirmation → drain latches
      // pause and returns without applying.
      applyPlanDecision: async () => ({
        status: "requires-user-confirmation",
        summary: "waiting for user approval",
      }),
    });

    const result = await drain("workflow-start");
    expect(result.pausedForConfirmation).toBe(true);
    expect(result.appliedDecisionIds).toEqual([]);
    expect(appliedMessagesFor(calls, instruction.id)).toEqual([]);
  });

  it("negative — activation-throw (activateGuidance fails) does NOT emit the applied notification", async () => {
    const store = createSteeringStore({ rootDir, expectedRoot: planFolder });
    const instruction = await store.appendInstruction({
      workflowId: "wf-1", source: "tool", text: "x", priority: "normal",
    });
    // Wrap the store so `activateGuidance` throws. This is the exact
    // regression guard: a buggy implementation that emits the
    // notification right after `updateInstructionStatus("applied")`
    // (instead of after the entire activation try/catch unwinds + the
    // appliedDecisionIds push succeeds) would fire the notification here
    // even though the outer catch then routes through failInstruction
    // and the instruction ends `failed`. The correct placement guards
    // against this.
    const wrappedStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "activateGuidance") {
          return async () => {
            throw new Error("simulated activateGuidance failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const { reporter, calls } = makeStubReporter();
    const drain = createSteeringDrain({
      workflowId: "wf-1",
      workflowKind: "task",
      store: wrappedStore,
      repoRoot,
      planFolderPath: planFolder,
      reporter,
      decide: async (input) => makeApplyToFutureDecision(instruction.id, input.snapshot),
    });

    const result = await drain("workflow-start");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].instructionId).toBe(instruction.id);
    // Crucial assertion: zero applied notifications even though
    // `updateInstructionStatus("applied")` briefly transitioned the row.
    expect(appliedMessagesFor(calls, instruction.id)).toEqual([]);
  });

  it("negative — rejected via plan-applier does NOT emit the applied notification", async () => {
    const store = createSteeringStore({ rootDir, expectedRoot: planFolder });
    const instruction = await store.appendInstruction({
      workflowId: "wf-1", source: "tool", text: "x", priority: "normal",
    });
    const { reporter, calls } = makeStubReporter();
    const drain = createSteeringDrain({
      workflowId: "wf-1",
      workflowKind: "task",
      store,
      repoRoot,
      planFolderPath: planFolder,
      reporter,
      decide: async (input) => ({
        ...makeApplyToFutureDecision(instruction.id, input.snapshot),
        kind: "amend-plan",
        planPatchRequired: true,
      }),
      applyPlanDecision: async () => ({
        status: "rejected",
        summary: "plan amendment rejected",
      }),
    });

    const result = await drain("workflow-start");
    expect(result.appliedDecisionIds).toEqual([]);
    expect(appliedMessagesFor(calls, instruction.id)).toEqual([]);
    const inst = (await store.listInstructions())[0];
    expect(inst.status).toBe("rejected");
  });
});
