import { randomUUID } from "node:crypto";

import type { WorkflowReporter } from "@pi-stef/agent-workflows";

import { applyAgentControlDecision, type WorktreeDiscardSummary } from "../agent-control";
import {
  BatchValidationError,
  decideSteeringInstruction,
  decideSteeringInstructions,
  isDecisionSnapshotStale,
  isDestructiveDecision,
  validateBatchDecisions,
  type SteeringBatchDeciderInput,
  type SteeringDeciderInput,
} from "../decider/index";
import { buildSteeringSnapshot } from "../snapshot";
import { appendSteeringPlanNote } from "../guidance-plan-notes";
import type { SteeringStore } from "../store";
import type {
  ActiveAgentRecord,
  ActiveAgentState,
  RunningAgentControl,
  SteeringAgentAction,
  SteeringDecision,
  SteeringDrainReason,
  SteeringDrainResult,
  SteeringGuidance,
  SteeringPauseState,
  SteeringWorkflowSnapshot,
} from "../types";
import type { SteeringWorkflowKind } from "../path-safety";
import type { TranscriptHandle } from "../../orchestrator/transcript";

export type SteeringDecideFn = (input: SteeringDeciderInput) => Promise<SteeringDecision>;
export type SteeringBatchDecideFn = (input: SteeringBatchDeciderInput) => Promise<SteeringDecision[]>;
export type SteeringPlanDecisionFn = NonNullable<SteeringDrainOptions["applyPlanDecision"]>;

export interface SteeringDrainOptions {
  workflowId: string;
  workflowKind: SteeringWorkflowKind;
  store: SteeringStore;
  repoRoot?: string;
  /** Plan folder path (e.g. `<repoRoot>/ai_plan/<slug>`). When set, accepted apply-to-future instructions append a `## Steering Notes` bullet to `milestone-plan.md` and `final-transcript.md`. */
  planFolderPath?: string;
  reporter?: WorkflowReporter;
  transcript?: TranscriptHandle;
  /**
   * Legacy single-instruction decider hook. Used by drainOnce when
   * `decideBatch` is not provided: each pending instruction is decided in
   * turn under the shared snapshot, then strictly validated as a batch.
   * Existing tests pass through this hook.
   */
  decide?: SteeringDecideFn;
  /**
   * Batch decider hook. When provided, drainOnce passes every pending
   * instruction through a single call so the model can coordinate the
   * set; the strict batch validator (count + id-set + no duplicates) is
   * always run against the result.
   */
  decideBatch?: SteeringBatchDecideFn;
  confirmDestructiveAction?: (summary: WorktreeDiscardSummary) => Promise<boolean>;
  applyPlanDecision?: (input: {
    instruction: import("../types").SteeringInstruction;
    decision: SteeringDecision;
  }) => Promise<{
    status: "applied" | "rejected" | "requires-user-confirmation";
    summary: string;
  }>;
}

export interface SteeringOrchestratorContext {
  enabled: boolean;
  workflowId: string;
  store: SteeringStore;
  drain(reason: SteeringDrainReason): Promise<SteeringDrainResult>;
  wake(reason: "explicit-steer-wake"): void;
  setDecider(decide: SteeringDecideFn): void;
  setBatchDecider(decideBatch: SteeringBatchDecideFn): void;
  setPlanDecisionApplier(apply: SteeringPlanDecisionFn): void;
  registerAgent(record: ActiveAgentRecord, control: RunningAgentControl): Promise<void>;
  updateAgent(id: string, patch: Partial<ActiveAgentRecord>): Promise<void>;
  unregisterAgent(id: string, finalState: ActiveAgentState): Promise<void>;
  snapshot(): Promise<SteeringWorkflowSnapshot>;
  /** Read the current latched pauseState (null when not paused). */
  readPauseState(): Promise<SteeringPauseState | null>;
  /** Persist a new pauseState, or null to clear the latch. Atomic. */
  setPauseState(state: SteeringPauseState | null): Promise<void>;
  /** Shorthand for `setPauseState(null)`. */
  clearPause(): Promise<void>;
}

/**
 * Thrown when a drain set `pauseState` and the orchestrator reached a safe
 * boundary check with no interactive UI available. The workflow exits
 * cleanly; state.json carries the pauseState; next resume reads it and
 * either prompts (UI available) or rethrows.
 */
export class PausedSteeringError extends Error {
  readonly code = "STEER_PAUSED";
  readonly pauseState: SteeringPauseState;
  constructor(pauseState: SteeringPauseState) {
    super(
      `STEER_PAUSED: steering ${pauseState.kind} latch at safe boundary; instructions=[${pauseState.instructionIds.join(", ")}]`,
    );
    this.name = "PausedSteeringError";
    this.pauseState = pauseState;
  }
}

export function createSteeringDrain(options: SteeringDrainOptions): (reason: SteeringDrainReason) => Promise<SteeringDrainResult> {
  let draining = false;
  return async (reason) => {
    if (draining) {
      return {
        processedInstructionIds: [],
        appliedDecisionIds: [],
        pausedForConfirmation: false,
        errors: [],
      };
    }
    draining = true;
    try {
      return await drainOnce(options, reason);
    } finally {
      draining = false;
    }
  };
}

export function createSteeringOrchestratorContext(options: SteeringDrainOptions): SteeringOrchestratorContext {
  const controls = new Map<string, RunningAgentControl>();
  const drainOptions = { ...options, controls };
  const drain = createSteeringDrain(drainOptions);
  return {
    enabled: true,
    workflowId: options.workflowId,
    store: options.store,
    drain,
    wake(_reason) {
      void drain("explicit-steer-wake");
    },
    setDecider(decide) {
      drainOptions.decide = decide;
    },
    setBatchDecider(decideBatch) {
      drainOptions.decideBatch = decideBatch;
    },
    setPlanDecisionApplier(apply) {
      drainOptions.applyPlanDecision = apply;
    },
    async readPauseState() {
      return await options.store.readPauseState();
    },
    async setPauseState(state) {
      await options.store.setPauseState(state);
    },
    async clearPause() {
      await options.store.setPauseState(null);
    },
    async registerAgent(record, control) {
      controls.set(record.id, control);
      await options.store.upsertActiveAgents([record]);
    },
    async updateAgent(id, patch) {
      await options.store.patchActiveAgent(id, patch);
    },
    async unregisterAgent(id, finalState) {
      await options.store.patchActiveAgent(id, { state: finalState, lastEventAt: new Date().toISOString() });
      controls.delete(id);
    },
    snapshot() {
      return buildSteeringSnapshot({
        workflowId: options.workflowId,
        workflowKind: options.workflowKind,
        store: options.store,
      });
    },
  };
}

async function drainOnce(
  options: SteeringDrainOptions & { controls?: Map<string, RunningAgentControl> },
  reason: SteeringDrainReason,
): Promise<SteeringDrainResult> {
  const pending = sortPendingInstructions(
    await options.store.listInstructions({ statuses: ["queued", "partially-applied"] }),
  );
  const result: SteeringDrainResult = {
    processedInstructionIds: [],
    appliedDecisionIds: [],
    pausedForConfirmation: false,
    errors: [],
  };
  if (pending.length === 0) return result;

  // ──────────────────────────────────────────────────────────────────────
  // Phase 1: one snapshot + one batch decide across all pending.
  // ──────────────────────────────────────────────────────────────────────
  for (const instruction of pending) {
    await options.store.updateInstructionStatus(instruction.id, "analyzing");
    options.reporter?.message(
      `sf-team steering: analyzing instruction ${instruction.id} (${reason})`,
      { level: "info" },
    );
    await options.transcript?.record({
      role: "system",
      label: "steering-instruction-received",
      status: "OK",
      body: instruction.text,
      meta: { instructionId: instruction.id, reason },
    });
    result.processedInstructionIds.push(instruction.id);
  }

  const sharedSnapshot = await buildSteeringSnapshot({
    workflowId: options.workflowId,
    workflowKind: options.workflowKind,
    store: options.store,
  });
  for (const instruction of pending) {
    await options.store.writeSnapshot(`${instruction.id}-before.json`, sharedSnapshot);
  }

  let batchDecisions: SteeringDecision[];
  try {
    batchDecisions = await invokeBatchDecider(options, pending, sharedSnapshot);
  } catch (err) {
    await handleBatchDeciderFailure(options, pending, sharedSnapshot, err, result, reason);
    return result;
  }

  // Map decision back to its instruction by instructionId (validated).
  const decisionByInstructionId = new Map(batchDecisions.map((d) => [d.instructionId, d]));
  for (const decision of batchDecisions) {
    await options.store.appendDecision(decision);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Phase 2: Stage A — apply non-destructive decisions under shared snapshot.
  // ──────────────────────────────────────────────────────────────────────
  const destructive: Array<{ instruction: import("../types").SteeringInstruction; batchDecision: SteeringDecision }> = [];
  for (const instruction of pending) {
    const decision = decisionByInstructionId.get(instruction.id);
    if (!decision) continue; // unreachable after batch validation
    if (isDestructiveDecision(decision)) {
      destructive.push({ instruction, batchDecision: decision });
      continue;
    }
    await applyDecisionPipeline(options, reason, instruction, decision, sharedSnapshot, result);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Phase 3: Stage B — for each destructive instruction, fresh snapshot +
  // fresh batch decide call (single-instruction batch) + confirmation gate.
  // Break the loop on first requires-user-confirmation; remaining
  // destructive instructions stay queued.
  // ──────────────────────────────────────────────────────────────────────
  let pausedIndex: number | undefined;
  for (let idx = 0; idx < destructive.length; idx += 1) {
    const { instruction } = destructive[idx];
    const freshSnapshot = await buildSteeringSnapshot({
      workflowId: options.workflowId,
      workflowKind: options.workflowKind,
      store: options.store,
    });
    await options.store.writeSnapshot(`${instruction.id}-before.json`, freshSnapshot);
    let freshDecision: SteeringDecision;
    try {
      const fresh = await invokeBatchDecider(options, [instruction], freshSnapshot);
      freshDecision = fresh[0] ?? destructive[idx].batchDecision;
      // Always persist the fresh decision; even if its id collides with
      // the batch decision, the body may differ (kind, targets, etc.) and
      // the audit ledger should reflect the most recent decision applied.
      await options.store.appendDecision(freshDecision);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await failInstruction(options, instruction, sharedSnapshot, err, message, result, reason);
      continue;
    }
    const paused = await applyDecisionPipeline(
      options,
      reason,
      instruction,
      freshDecision,
      freshSnapshot,
      result,
    );
    if (paused) {
      // Halt the destructive loop on first confirmation; the rest are
      // returned to "queued" so the next drain after clearPause() picks
      // them up with fresh snapshots.
      pausedIndex = idx;
      break;
    }
  }

  if (pausedIndex !== undefined) {
    for (let idx = pausedIndex + 1; idx < destructive.length; idx += 1) {
      await options.store
        .updateInstructionStatus(destructive[idx].instruction.id, "queued")
        .catch(() => undefined);
    }
  }

  return result;
}

function sortPendingInstructions<T extends { priority: "normal" | "urgent"; receivedAt: string }>(
  pending: readonly T[],
): T[] {
  return [...pending].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "urgent" ? -1 : 1;
    return a.receivedAt.localeCompare(b.receivedAt);
  });
}

async function invokeBatchDecider(
  options: SteeringDrainOptions,
  instructions: import("../types").SteeringInstruction[],
  snapshot: SteeringWorkflowSnapshot,
): Promise<SteeringDecision[]> {
  if (options.decideBatch) {
    const decisions = await options.decideBatch({ instructions, snapshot });
    validateBatchDecisions(instructions, decisions);
    return decisions;
  }
  if (options.decide) {
    const decisions: SteeringDecision[] = [];
    for (const instruction of instructions) {
      decisions.push(await options.decide({ instruction, snapshot }));
    }
    validateBatchDecisions(instructions, decisions);
    return decisions;
  }
  return await decideSteeringInstructions({ instructions, snapshot });
}

async function handleBatchDeciderFailure(
  options: SteeringDrainOptions,
  pending: import("../types").SteeringInstruction[],
  snapshot: SteeringWorkflowSnapshot,
  err: unknown,
  result: SteeringDrainResult,
  reason: SteeringDrainReason,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const batchErrorId = err instanceof BatchValidationError ? randomUUID() : undefined;
  if (batchErrorId) {
    options.reporter?.message(
      `sf-team steering: steering-batch-validation-failed (${batchErrorId}): ${message}`,
      { level: "error" },
    );
    await options.transcript?.record({
      role: "system",
      label: "steering-batch-validation-failed",
      status: "FAILED",
      body: message,
      meta: {
        reason,
        batchErrorId,
        inputIds: (err as BatchValidationError).inputIds.join(","),
        outputIds: (err as BatchValidationError).outputIds.join(","),
      },
    });
  }
  for (const instruction of pending) {
    await failInstruction(options, instruction, snapshot, err, message, result, reason, batchErrorId);
  }
}

/**
 * Canonical failure recorder. All failure paths (decider parse failures,
 * batch validation failures, plan-applier failures, activation-step
 * failures) MUST funnel through here so:
 *   - the audit snapshot, transcript entry, and instruction status all
 *     agree;
 *   - any pending-activation guidance row is expired with reason
 *     "activation-aborted" so the derived-active predicate filters it out;
 *   - the orchestrator's latched pauseState is set, persisting through
 *     state.json so the next safe-boundary check halts the workflow.
 */
async function failInstruction(
  options: SteeringDrainOptions,
  instruction: import("../types").SteeringInstruction,
  snapshot: SteeringWorkflowSnapshot | undefined,
  err: unknown,
  message: string,
  result: SteeringDrainResult,
  reason: SteeringDrainReason,
  batchErrorId?: string,
): Promise<void> {
  const sanitizedRaw = sanitizeRawOutputForAudit(getErrorStringProperty(err, "rawOutput"));
  await options.store.writeSnapshot(`${instruction.id}-failed.json`, {
    instructionId: instruction.id,
    before: snapshot,
    rawDecision: getErrorProperty(err, "rawDecision"),
    rawOutput: sanitizedRaw,
    errorCode: getErrorStringProperty(err, "code"),
    errorMessage: message,
    batchErrorId,
  }).catch(() => undefined);
  await options.store
    .expireGuidanceForInstruction(instruction.id, "activation-aborted")
    .catch(() => undefined);
  await options.store.updateInstructionStatus(instruction.id, "failed");
  result.errors.push({ instructionId: instruction.id, message });
  options.reporter?.message(
    `sf-team steering: failed instruction ${instruction.id}: ${message}`,
    { level: "error" },
  );
  await emitSteeringAuditEntry(options.transcript, {
    label: "steering-decision-failed",
    status: "FAILED",
    instruction,
    reason,
    error: { message, code: getErrorStringProperty(err, "code"), rawOutput: sanitizedRaw },
    batchErrorId,
  });

  // Latch the pause. Subsequent failed instructions extend the
  // instructionIds list (no overwrite, no clear). Failure to persist the
  // latch is FATAL — the pause must survive so the next safe-boundary
  // check halts the workflow. Swallowing a failed setPauseState would
  // let the workflow keep marching past known-failed instructions.
  const current = await options.store.readPauseState();
  const nextIds = [
    ...(current?.kind === "failure" ? current.instructionIds : []),
    instruction.id,
  ];
  await options.store.setPauseState({
    kind: "failure",
    instructionIds: Array.from(new Set(nextIds)),
    rationale: current?.kind === "failure" ? current.rationale : message,
    batchErrorId: batchErrorId ?? current?.batchErrorId,
    latchedAt: current?.kind === "failure" ? current.latchedAt : new Date().toISOString(),
  });
}

const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const ZERO_WIDTH_REGEX = /[​-‏‪-‮⁠-⁯﻿]/g;
const RAW_OUTPUT_AUDIT_CAP = 2000;
const TRUNCATION_MARKER = "…[truncated]";

function sanitizeRawOutputForAudit(rawOutput: string | undefined): string | undefined {
  if (typeof rawOutput !== "string") return rawOutput;
  const cleaned = rawOutput.replace(CONTROL_CHAR_REGEX, "").replace(ZERO_WIDTH_REGEX, "");
  if (cleaned.length <= RAW_OUTPUT_AUDIT_CAP) return cleaned;
  return `${cleaned.slice(0, RAW_OUTPUT_AUDIT_CAP)}${TRUNCATION_MARKER}`;
}

interface SteeringAuditEntry {
  label:
    | "steering-decision"
    | "steering-decision-failed"
    | "steering-batch-validation-failed"
    | "steering-plan-note-failed";
  status: "OK" | "FAILED" | "WARNED";
  instruction?: import("../types").SteeringInstruction;
  decision?: SteeringDecision;
  reason?: SteeringDrainReason;
  error?: { message: string; code?: string; rawOutput?: string };
  snapshotPath?: string;
  batchErrorId?: string;
}

/**
 * Single entry point for per-instruction transcript audit. Centralizes
 * sanitization + truncation of raw decider output BEFORE writing it to
 * the transcript so a long/binary blob can't bloat the audit.
 */
async function emitSteeringAuditEntry(
  transcript: SteeringDrainOptions["transcript"],
  entry: SteeringAuditEntry,
): Promise<void> {
  if (!transcript) return;
  const meta: Record<string, string | number | undefined> = {
    instructionId: entry.instruction?.id,
    decisionId: entry.decision?.id,
    reason: entry.reason,
    errorCode: entry.error?.code,
    batchErrorId: entry.batchErrorId,
    snapshotPath: entry.snapshotPath,
  };
  let body: string;
  if (entry.status === "OK" && entry.instruction && entry.decision) {
    const sanitizedRaw = sanitizeRawOutputForAudit(entry.decision.rawOutput);
    body = JSON.stringify({
      instruction: entry.instruction,
      decision: { ...entry.decision, rawOutput: sanitizedRaw },
    }, null, 2);
  } else if (entry.error) {
    const sanitizedRaw = sanitizeRawOutputForAudit(entry.error.rawOutput);
    body = JSON.stringify({
      instruction: entry.instruction,
      error: { ...entry.error, rawOutput: sanitizedRaw },
      batchErrorId: entry.batchErrorId,
    }, null, 2);
  } else {
    body = JSON.stringify(entry, null, 2);
  }
  await transcript.record({
    role: "system",
    label: entry.label,
    status: entry.status,
    body,
    meta,
  });
}

/**
 * Apply a single decision against the given snapshot, recording all the
 * usual transcript/audit side effects. Returns `true` iff the application
 * paused on confirmation (so the Stage-B caller can break its loop).
 */
async function applyDecisionPipeline(
  options: SteeringDrainOptions & { controls?: Map<string, RunningAgentControl> },
  reason: SteeringDrainReason,
  instruction: import("../types").SteeringInstruction,
  decision: SteeringDecision,
  snapshot: SteeringWorkflowSnapshot,
  result: SteeringDrainResult,
): Promise<boolean> {
  try {
    const after = await buildSteeringSnapshot({
      workflowId: options.workflowId,
      workflowKind: options.workflowKind,
      store: options.store,
    });
    await options.store.writeSnapshot(`${instruction.id}-after.json`, after);

    // Defense-in-depth stale check: even for non-destructive decisions the
    // snapshot referenced in the batch may have moved by the time we get
    // here. Stale decisions get requeued without applying.
    if (isDecisionSnapshotStale(decision, after)) {
      await options.store.updateInstructionStatus(instruction.id, "queued");
      await recordAction(
        options.store,
        instruction.id,
        decision.id,
        "noop",
        "Skipped stale steering decision; requeued instruction for a fresh decision.",
        "skipped",
      );
      options.reporter?.message(
        `sf-team steering: requeued stale decision ${decision.id}`,
        { level: "warning" },
      );
      return false;
    }

    await options.store.updateInstructionStatus(instruction.id, "partially-applied");
    const planApplication = requiresPlanApplication(decision) && options.applyPlanDecision
      ? await options.applyPlanDecision({ instruction, decision })
      : undefined;
    if (planApplication?.status === "requires-user-confirmation") {
      await options.store.updateInstructionStatus(instruction.id, "requires-user-confirmation");
      result.pausedForConfirmation = true;
      await recordAction(
        options.store,
        instruction.id,
        decision.id,
        "confirm",
        planApplication.summary,
        "skipped",
      );
      options.reporter?.message(
        `sf-team steering: waiting for plan confirmation for ${decision.id}`,
        { level: "warning" },
      );
      await latchConfirmationPause(options, instruction, planApplication.summary);
      return true;
    }
    if (planApplication?.status === "rejected") {
      await options.store.updateInstructionStatus(instruction.id, "rejected");
      await recordAction(
        options.store,
        instruction.id,
        decision.id,
        decision.kind,
        planApplication.summary,
        "skipped",
      );
      options.reporter?.message(
        `sf-team steering: rejected plan decision ${decision.id}`,
        { level: "warning" },
      );
      return false;
    }

    const application = await applyAgentControlDecision({
      decision: planApplication?.status === "applied" ? { ...decision, requiresConfirmation: false } : decision,
      instruction,
      controls: options.controls ?? new Map(),
      store: options.store,
      repoRoot: options.repoRoot,
      confirmDestructiveAction: options.confirmDestructiveAction,
    });
    for (const action of application.actions) {
      await recordAction(
        options.store,
        instruction.id,
        decision.id,
        action.actionKind,
        action.summary,
        action.status,
        action.targetId,
      );
    }

    if (application.status === "requires-user-confirmation") {
      await options.store.updateInstructionStatus(instruction.id, "requires-user-confirmation");
      result.pausedForConfirmation = true;
      options.reporter?.message(
        `sf-team steering: waiting for confirmation for ${decision.id}`,
        { level: "warning" },
      );
      await latchConfirmationPause(
        options,
        instruction,
        `Awaiting user confirmation for ${decision.kind} (${decision.summary})`,
      );
      return true;
    }
    if (application.status === "rejected") {
      await options.store.updateInstructionStatus(instruction.id, "rejected");
      options.reporter?.message(
        `sf-team steering: rejected decision ${decision.id}`,
        { level: "warning" },
      );
      return false;
    }

    let pendingGuidance: SteeringGuidance | undefined;
    try {
      if (decision.kind === "apply-to-future" && decision.guidanceText) {
        pendingGuidance = await options.store.appendGuidance({
          instructionId: instruction.id,
          workflowId: options.workflowId,
          scope: {
            kind: decision.scopeKind ?? "workflow",
            target: decision.scopeTarget,
          },
          text: decision.guidanceText,
          source: instruction.source,
        });
      }
      await recordAppliedInstruction(options.store, instruction.id, decision.id);
      await options.store.updateInstructionStatus(instruction.id, "applied");
      if (pendingGuidance) {
        await options.store.activateGuidance(pendingGuidance.id);
      }
    } catch (activationErr) {
      if (pendingGuidance) {
        await options.store
          .expireGuidance(pendingGuidance.id, "activation-aborted")
          .catch(() => undefined);
      }
      throw activationErr;
    }

    result.appliedDecisionIds.push(decision.id);

    // M2-followup: surface a sf_team_steer-prefixed notification on the
    // applied transition. The original `sf_team_steer: queued instruction
    // <id> ...` receipt is emitted at ingestion (register.ts) and never
    // updated; without this line the user has no chat-side signal that
    // their instruction actually landed. Placement is AFTER the entire
    // activation try/catch unwinds AND after `appliedDecisionIds.push` so
    // the message never fires on the path where `updateInstructionStatus
    // ("applied")` briefly succeeded but `activateGuidance` threw and the
    // outer catch routed through `failInstruction` (instruction ends
    // `failed`).
    options.reporter?.message(
      `sf_team_steer: applied instruction ${instruction.id}`,
      { level: "info" },
    );

    if (pendingGuidance && options.planFolderPath && options.repoRoot) {
      try {
        await appendSteeringPlanNote({
          planFolderPath: options.planFolderPath,
          repoRoot: options.repoRoot,
          guidance: { ...pendingGuidance, status: "active" },
        });
      } catch (planNoteErr) {
        const msg = planNoteErr instanceof Error ? planNoteErr.message : String(planNoteErr);
        options.reporter?.message(
          `sf-team steering: steering-plan-note-failed for ${instruction.id}: ${msg}`,
          { level: "warning" },
        );
        await options.transcript?.record({
          role: "system",
          label: "steering-plan-note-failed",
          status: "WARNED",
          body: msg,
          meta: { instructionId: instruction.id, decisionId: decision.id, reason },
        });
      }
    }

    await emitSteeringAuditEntry(options.transcript, {
      label: "steering-decision",
      status: "OK",
      instruction,
      decision,
      reason,
    });
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failInstruction(options, instruction, snapshot, err, message, result, reason);
    return false;
  }
}

async function latchConfirmationPause(
  options: SteeringDrainOptions,
  instruction: import("../types").SteeringInstruction,
  rationale: string,
): Promise<void> {
  const current = await options.store.readPauseState();
  // Don't downgrade a failure latch to a confirmation latch.
  if (current?.kind === "failure") return;
  const nextIds = [
    ...(current?.kind === "confirmation" ? current.instructionIds : []),
    instruction.id,
  ];
  // Fail-closed: a failed setPauseState means the safe-boundary check
  // would not halt; surface the error so the caller knows the latch did
  // not stick.
  await options.store.setPauseState({
    kind: "confirmation",
    instructionIds: Array.from(new Set(nextIds)),
    rationale: current?.kind === "confirmation" ? current.rationale : rationale,
    latchedAt: current?.kind === "confirmation" ? current.latchedAt : new Date().toISOString(),
  });
}

function getErrorProperty(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function getErrorStringProperty(error: unknown, key: string): string | undefined {
  const value = getErrorProperty(error, key);
  return typeof value === "string" ? value : undefined;
}

function requiresPlanApplication(decision: SteeringDecision): boolean {
  return decision.kind === "amend-plan"
    || decision.kind === "backtrack-completed-work"
    || decision.planPatchRequired;
}

async function recordAppliedInstruction(
  store: SteeringStore,
  instructionId: string,
  decisionId: string,
): Promise<void> {
  const applied = await store.listAppliedInstructions();
  if (applied.some((entry) => entry.instructionId === instructionId)) return;
  await store.appendAppliedInstruction({
    instructionId,
    decisionId,
    appliedAt: new Date().toISOString(),
  });
}

async function recordAction(
  store: SteeringStore,
  instructionId: string,
  decisionId: string,
  actionKind: SteeringAgentAction["actionKind"],
  summary: string,
  status: SteeringAgentAction["status"] = "completed",
  targetId?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await store.appendAgentAction({
    id: randomUUID(),
    instructionId,
    decisionId,
    actionKind,
    targetId,
    startedAt: now,
    completedAt: now,
    status,
    summary,
  });
}
