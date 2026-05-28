import { randomUUID } from "node:crypto";

import type { SpawnAgentReturning } from "../../tools/shared";
import type { TeamMember } from "../../runtime/types";
import type {
  SteeringInstruction,
  SteeringDecision,
  SteeringDecisionKind,
  SteeringGuidanceScopeKind,
  SteeringWorkflowSnapshot,
} from "../types";
import { truncateGuidanceText } from "../guidance-sanitize";
import {
  DECISION_KINDS,
  extractJsonObject,
  isRecord,
  normalizeDeciderOutput,
  UnsupportedActionShapeError,
  type NormalizedDecision,
} from "./normalize";

export interface SteeringDeciderInput {
  instruction: SteeringInstruction;
  snapshot: SteeringWorkflowSnapshot;
}

export interface SteeringBatchDeciderInput {
  instructions: SteeringInstruction[];
  snapshot: SteeringWorkflowSnapshot;
}

export interface SteeringDeciderOptions {
  sp?: SpawnAgentReturning;
  member?: TeamMember;
  cwd?: string;
  signal?: AbortSignal;
}

export class BatchValidationError extends Error {
  readonly code = "STEER_BATCH_VALIDATION_FAILED";
  readonly inputIds: string[];
  readonly outputIds: string[];
  readonly rawOutput?: string;
  constructor(
    message: string,
    detail: { inputIds: string[]; outputIds: string[]; rawOutput?: string },
  ) {
    super(message);
    this.name = "BatchValidationError";
    this.inputIds = detail.inputIds;
    this.outputIds = detail.outputIds;
    this.rawOutput = detail.rawOutput;
  }
}

/**
 * Batch decider entry point. The drain consolidates all pending steering
 * instructions into ONE call so the model sees them as a coordinated set,
 * and the strict validator below rejects any malformed output (count
 * mismatch, missing id, extra id, duplicate id) — the drain then routes
 * those failures through recordFailure per instruction with a shared
 * batchErrorId so the audit transcript shows one batch-error header and
 * one per-instruction sub-entry.
 *
 * When a separate batch-aware spawn isn't configured, the implementation
 * falls back to N single-instruction `decideSteeringInstruction` calls
 * under the shared snapshot — semantically equivalent for non-destructive
 * sets and preserves existing test hooks.
 */
export async function decideSteeringInstructions(
  input: SteeringBatchDeciderInput,
  options: SteeringDeciderOptions = {},
): Promise<SteeringDecision[]> {
  if (input.instructions.length === 0) return [];

  // Backward-compat: single-instruction batches delegate to the legacy
  // decideSteeringInstruction path so they inherit the strict-parse →
  // normalize → contract-validate fallback behavior (and the existing
  // shorthand-tolerant production behavior). Stage B of the drain also
  // benefits since each destructive instruction is re-decided as a
  // length-1 batch.
  if (input.instructions.length === 1) {
    const decision = await decideSteeringInstruction(
      { instruction: input.instructions[0], snapshot: input.snapshot },
      options,
    );
    validateBatchDecisions(input.instructions, [decision]);
    return [decision];
  }

  // Real batch LLM call: when a steering-decider spawn is configured we
  // send all pending instructions in a SINGLE prompt asking for
  // `{decisions: [...]}` and validate the response as one batch. This is
  // the "one coordinated decision" path the milestone requires.
  if (options.sp && options.member) {
    let rawOutput: string;
    try {
      rawOutput = await options.sp.spawnText(
        options.member,
        {
          task: composeSteeringBatchDeciderPrompt(input),
          cwd: options.cwd,
          signal: options.signal,
        },
        "steering decider failed",
        "steering-decider",
        { registerActiveAgent: false },
      );
    } catch (err) {
      // Spawn-level failure: surface as a single batch error so the drain
      // marks all instructions failed with the same batchErrorId.
      const message = err instanceof Error ? err.message : String(err);
      throw new BatchValidationError(
        `STEER_BATCH_VALIDATION_FAILED: spawn failed: ${message}`,
        { inputIds: input.instructions.map((i) => i.id), outputIds: [] },
      );
    }
    let decisions: SteeringDecision[];
    try {
      decisions = parseBatchDeciderOutput(rawOutput);
    } catch (err) {
      if (err instanceof BatchValidationError) {
        (err as { rawOutput?: string }).rawOutput = rawOutput;
        throw err;
      }
      throw new BatchValidationError(
        `STEER_BATCH_VALIDATION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        { inputIds: input.instructions.map((i) => i.id), outputIds: [], rawOutput },
      );
    }
    validateBatchDecisions(input.instructions, decisions, rawOutput);
    // Capture raw batch output on every decision so the audit transcript
    // can surface the model output that produced each applied decision.
    for (const d of decisions) d.rawOutput = rawOutput;
    return decisions;
  }

  // Fallback path (no spawn configured): single-instruction decider per
  // input. Used by the defaultDecision-only path (e.g. tests that do not
  // configure a member). Strict validation still applies.
  const decisions: SteeringDecision[] = [];
  for (const instruction of input.instructions) {
    decisions.push(
      await decideSteeringInstruction({ instruction, snapshot: input.snapshot }, options),
    );
  }
  validateBatchDecisions(input.instructions, decisions);
  return decisions;
}

function composeSteeringBatchDeciderPrompt(input: SteeringBatchDeciderInput): string {
  return [
    "You are the sf-team steering-decider. The user submitted multiple steering instructions concurrently. Return ONE JSON object of shape:",
    "  { \"decisions\": [<SteeringDecision>, ...] }",
    "with EXACTLY one SteeringDecision per input instruction, in the same order. Each decision's `instructionId` MUST match one of the input instructionIds; no duplicates, no extras, no missing.",
    "",
    "Apply the same per-decision contract as the single-instruction prompt: when kind=apply-to-future, set guidanceText (required) and scopeKind (default \"workflow\"). For scopeKind in {milestone, story, role}, scopeTarget is required.",
    "",
    "Never authorize destructive filesystem changes by yourself. Set requiresConfirmation=true for destructive decisions.",
    "",
    "Instructions:",
    JSON.stringify(input.instructions, null, 2),
    "",
    "Workflow snapshot:",
    JSON.stringify(input.snapshot, null, 2),
  ].join("\n");
}

function parseBatchDeciderOutput(rawOutput: string): SteeringDecision[] {
  const jsonText = extractJsonObject(rawOutput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Unable to parse steering batch decider JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed)) throw new Error("Steering batch decider output is not an object");
  const candidates = parsed.decisions;
  if (!Array.isArray(candidates)) {
    throw new Error("Steering batch decider output is missing `decisions: []`");
  }
  const out: SteeringDecision[] = [];
  for (const candidate of candidates) {
    out.push(parseSteeringDecision(JSON.stringify(candidate)));
  }
  return out;
}

export function validateBatchDecisions(
  instructions: SteeringInstruction[],
  decisions: SteeringDecision[],
  rawOutput?: string,
): void {
  const inputIds = instructions.map((i) => i.id);
  const outputIds = decisions.map((d) => d.instructionId);
  if (instructions.length !== decisions.length) {
    throw new BatchValidationError(
      `STEER_BATCH_VALIDATION_FAILED: expected ${instructions.length} decision(s), got ${decisions.length}`,
      { inputIds, outputIds, rawOutput },
    );
  }
  const inputSet = new Set(inputIds);
  const seenOutput = new Set<string>();
  for (const id of outputIds) {
    if (!inputSet.has(id)) {
      throw new BatchValidationError(
        `STEER_BATCH_VALIDATION_FAILED: decision references unknown instructionId ${id}`,
        { inputIds, outputIds, rawOutput },
      );
    }
    if (seenOutput.has(id)) {
      throw new BatchValidationError(
        `STEER_BATCH_VALIDATION_FAILED: duplicate decision for instructionId ${id}`,
        { inputIds, outputIds, rawOutput },
      );
    }
    seenOutput.add(id);
  }
  for (const id of inputIds) {
    if (!seenOutput.has(id)) {
      throw new BatchValidationError(
        `STEER_BATCH_VALIDATION_FAILED: missing decision for instructionId ${id}`,
        { inputIds, outputIds, rawOutput },
      );
    }
  }
}

export const DESTRUCTIVE_KINDS: ReadonlySet<SteeringDecisionKind> = new Set([
  "discard-running-agent-changes",
  "stop-running-agents",
  "restart-running-agents",
  "backtrack-completed-work",
]);

export function isDestructiveDecision(decision: SteeringDecision): boolean {
  return DESTRUCTIVE_KINDS.has(decision.kind);
}

export async function decideSteeringInstruction(
  input: SteeringDeciderInput,
  options: SteeringDeciderOptions = {},
): Promise<SteeringDecision> {
  if (options.sp && options.member) {
    const output = await options.sp.spawnText(
      options.member,
      {
        task: composeSteeringDeciderPrompt(input),
        cwd: options.cwd,
        signal: options.signal,
      },
      "steering decider failed",
      "steering-decider",
      { registerActiveAgent: false },
    );
    try {
      const parsed = parseSteeringDecision(output);
      parsed.rawOutput = output;
      return parsed;
    } catch (strictErr) {
      // Strict-validation failures for apply-to-future contract must NOT
      // fall back to normalization. Otherwise a missing guidanceText /
      // scopeTarget / invalid scopeKind would be papered over and the
      // resulting guidance row would be invisible to the injection
      // filter (and the user would have no visible feedback).
      if (isApplyToFutureContractError(strictErr)) {
        (strictErr as { rawOutput?: string }).rawOutput = output;
        throw strictErr;
      }
      try {
        const normalized = normalizeDeciderOutput(output);
        const decision = buildDecisionFromNormalized(normalized, input);
        validateApplyToFutureContract(decision);
        decision.rawOutput = output;
        return decision;
      } catch (normErr) {
        // Surface the raw output on whichever error we end up throwing so
        // recordFailure can persist it for the audit transcript.
        (normErr as { rawOutput?: string }).rawOutput = output;
        if (normErr instanceof UnsupportedActionShapeError) throw normErr;
        if (isApplyToFutureContractError(normErr)) throw normErr;
        (strictErr as { rawOutput?: string }).rawOutput = output;
        throw strictErr;
      }
    }
  }
  return defaultDecision(input.instruction, input.snapshot);
}

function isApplyToFutureContractError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === "STEER_MISSING_GUIDANCE_TEXT"
    || code === "STEER_INVALID_SCOPE_KIND"
    || code === "STEER_MISSING_SCOPE_TARGET";
}

function validateApplyToFutureContract(decision: SteeringDecision): void {
  if (decision.kind !== "apply-to-future") return;
  if (!decision.guidanceText || decision.guidanceText.trim().length === 0) {
    const err = new Error(
      "STEER_MISSING_GUIDANCE_TEXT: apply-to-future decision requires non-empty guidanceText",
    ) as Error & { code: string };
    err.code = "STEER_MISSING_GUIDANCE_TEXT";
    throw err;
  }
  const scopeKind = decision.scopeKind ?? "workflow";
  if (!["workflow", "milestone", "story", "role"].includes(scopeKind)) {
    const err = new Error(
      `STEER_INVALID_SCOPE_KIND: scopeKind must be one of workflow|milestone|story|role, got ${scopeKind}`,
    ) as Error & { code: string };
    err.code = "STEER_INVALID_SCOPE_KIND";
    throw err;
  }
  if (scopeKind !== "workflow"
    && (!decision.scopeTarget || decision.scopeTarget.trim().length === 0)) {
    const err = new Error(
      `STEER_MISSING_SCOPE_TARGET: apply-to-future scopeKind="${scopeKind}" requires non-empty scopeTarget`,
    ) as Error & { code: string };
    err.code = "STEER_MISSING_SCOPE_TARGET";
    throw err;
  }
}

export function parseSteeringDecision(text: string): SteeringDecision {
  const jsonText = extractJsonObject(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `Unable to parse steering decision JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateDecision(parsed);
}

export function isDecisionSnapshotStale(
  decision: SteeringDecision,
  snapshot: SteeringWorkflowSnapshot,
): boolean {
  for (const [key, hash] of Object.entries(decision.referencedPlanHashes)) {
    if (snapshot.referencedPlanHashes[key] !== hash) return true;
  }
  for (const [agentId, state] of Object.entries(decision.referencedAgentStates)) {
    if (snapshot.referencedAgentStates[agentId] !== state) return true;
  }
  return false;
}

function defaultDecision(
  instruction: SteeringInstruction,
  snapshot: SteeringWorkflowSnapshot,
): SteeringDecision {
  return makeDecision({
    instruction,
    snapshot,
    kind: "apply-to-future",
    summary: "Apply steering instruction to future prompts.",
    rationale:
      "No structured decider spawn was configured for this drain; defaulting to non-destructive future guidance.",
    requiresConfirmation: false,
    scopeKind: "workflow",
    guidanceText: truncateGuidanceText(instruction.text),
  });
}

function buildDecisionFromNormalized(
  normalized: NormalizedDecision,
  input: SteeringDeciderInput,
): SteeringDecision {
  const isApplyToFuture = normalized.kind === "apply-to-future";
  const scopeKind: SteeringGuidanceScopeKind | undefined = isApplyToFuture
    ? (normalized.scopeKind ?? "workflow")
    : undefined;
  const guidanceText = isApplyToFuture
    ? truncateGuidanceText(
      normalized.guidanceText
        ?? normalized.summary
        ?? input.instruction.text
        ?? "",
    )
    : undefined;
  return makeDecision({
    instruction: input.instruction,
    snapshot: input.snapshot,
    kind: normalized.kind,
    summary:
      normalized.summary
      ?? input.instruction.text
      ?? "Apply multi-action steering plan.",
    rationale:
      normalized.rationale
      ?? `The spawned steering decider returned shorthand decision "${normalized.kind}".`,
    requiresConfirmation: normalized.requiresConfirmation,
    targetAgents: normalized.targetAgents,
    abortAgents: normalized.abortAgents,
    discardAgentChanges: normalized.discardAgentChanges,
    planPatchRequired: normalized.planPatchRequired,
    amendedUserFacingPlanText: normalized.amendedUserFacingPlanText,
    agentRestartInstructions: normalized.agentRestartInstructions,
    risks: normalized.risks,
    scopeKind,
    scopeTarget: isApplyToFuture && scopeKind !== "workflow" ? normalized.scopeTarget : undefined,
    guidanceText: guidanceText && guidanceText.length > 0 ? guidanceText : undefined,
  });
}

function makeDecision(input: {
  instruction: SteeringInstruction;
  snapshot: SteeringWorkflowSnapshot;
  kind: SteeringDecisionKind;
  summary: string;
  rationale: string;
  requiresConfirmation: boolean;
  targetAgents?: string[];
  abortAgents?: string[];
  discardAgentChanges?: string[];
  planPatchRequired?: boolean;
  amendedUserFacingPlanText?: string;
  agentRestartInstructions?: Record<string, string>;
  risks?: string[];
  scopeKind?: SteeringGuidanceScopeKind;
  scopeTarget?: string;
  guidanceText?: string;
}): SteeringDecision {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    instructionId: input.instruction.id,
    decidedAt: now,
    kind: input.kind,
    summary: input.summary,
    rationale: input.rationale,
    planPatchRequired:
      input.planPatchRequired
      ?? (input.kind === "amend-plan" || input.kind === "backtrack-completed-work"),
    targetAgents: input.targetAgents ?? [],
    abortAgents: input.abortAgents ?? [],
    discardAgentChanges: input.discardAgentChanges ?? [],
    affectedMilestones: [],
    affectedStories: [],
    affectedFiles: [],
    amendedUserFacingPlanText: input.amendedUserFacingPlanText,
    agentRestartInstructions: input.agentRestartInstructions,
    risks: input.risks ?? [],
    activeAgentsVersion: input.snapshot.activeAgentsVersion,
    referencedAgentStates: input.snapshot.referencedAgentStates,
    referencedPlanHashes: input.snapshot.referencedPlanHashes,
    requiresConfirmation: input.requiresConfirmation,
    scopeKind: input.scopeKind,
    scopeTarget: input.scopeTarget,
    guidanceText: input.guidanceText,
  };
}

function composeSteeringDeciderPrompt(input: SteeringDeciderInput): string {
  return [
    "You are the sf-team steering-decider. Return only one JSON object matching the SteeringDecision contract.",
    "",
    "Instruction:",
    JSON.stringify(input.instruction, null, 2),
    "",
    "Workflow snapshot:",
    JSON.stringify(input.snapshot, null, 2),
    "",
    "Never authorize destructive filesystem changes by yourself. Set requiresConfirmation=true for destructive decisions.",
    "",
    "When `kind` === \"apply-to-future\":",
    "  - `guidanceText` is REQUIRED: a short, self-contained instruction that future agents will see verbatim, prefixed by `[steering <source>:<instructionId>]`.",
    "  - `scopeKind` is optional; defaults to \"workflow\" when omitted. Allowed values: \"workflow\", \"milestone\", \"story\", \"role\".",
    "  - For scopeKind ∈ {\"milestone\", \"story\", \"role\"}, `scopeTarget` is REQUIRED (e.g. milestone id, story id, or role name).",
  ].join("\n");
}

function validateDecision(value: unknown): SteeringDecision {
  if (!isRecord(value)) throw new Error("Unable to parse steering decision JSON: expected object");
  const kind = value.kind;
  if (typeof kind !== "string" || !DECISION_KINDS.has(kind as SteeringDecisionKind)) {
    throw new Error(`Unable to parse steering decision JSON: invalid kind ${String(kind)}`);
  }
  const requiredStrings = ["id", "instructionId", "decidedAt", "summary", "rationale"];
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`Unable to parse steering decision JSON: missing ${key}`);
    }
  }
  const requiredArrays = [
    "targetAgents",
    "abortAgents",
    "discardAgentChanges",
    "affectedMilestones",
    "affectedStories",
    "affectedFiles",
    "risks",
  ];
  for (const key of requiredArrays) {
    if (!Array.isArray(value[key])) throw new Error(`Unable to parse steering decision JSON: missing ${key}`);
  }
  if (typeof value.planPatchRequired !== "boolean")
    throw new Error("Unable to parse steering decision JSON: missing planPatchRequired");
  if (typeof value.requiresConfirmation !== "boolean")
    throw new Error("Unable to parse steering decision JSON: missing requiresConfirmation");
  if (typeof value.activeAgentsVersion !== "number")
    throw new Error("Unable to parse steering decision JSON: missing activeAgentsVersion");
  if (!isRecord(value.referencedAgentStates))
    throw new Error("Unable to parse steering decision JSON: missing referencedAgentStates");
  if (!isRecord(value.referencedPlanHashes))
    throw new Error("Unable to parse steering decision JSON: missing referencedPlanHashes");

  // Scope + guidance validation for apply-to-future decisions.
  if (kind === "apply-to-future") {
    const incomingScope = (value as { scopeKind?: unknown }).scopeKind;
    let scopeKind: SteeringGuidanceScopeKind = "workflow";
    if (incomingScope !== undefined) {
      if (typeof incomingScope !== "string"
        || !["workflow", "milestone", "story", "role"].includes(incomingScope)) {
        const err = new Error(
          `STEER_INVALID_SCOPE_KIND: scopeKind must be one of workflow|milestone|story|role, got ${String(incomingScope)}`,
        ) as Error & { code: string };
        err.code = "STEER_INVALID_SCOPE_KIND";
        throw err;
      }
      scopeKind = incomingScope as SteeringGuidanceScopeKind;
    }
    (value as { scopeKind: SteeringGuidanceScopeKind }).scopeKind = scopeKind;

    const guidanceText = (value as { guidanceText?: unknown }).guidanceText;
    if (typeof guidanceText !== "string" || guidanceText.trim().length === 0) {
      const err = new Error(
        "STEER_MISSING_GUIDANCE_TEXT: apply-to-future decision requires non-empty guidanceText",
      ) as Error & { code: string };
      err.code = "STEER_MISSING_GUIDANCE_TEXT";
      throw err;
    }

    if (scopeKind !== "workflow") {
      const scopeTarget = (value as { scopeTarget?: unknown }).scopeTarget;
      if (typeof scopeTarget !== "string" || scopeTarget.trim().length === 0) {
        const err = new Error(
          `STEER_MISSING_SCOPE_TARGET: apply-to-future scopeKind="${scopeKind}" requires non-empty scopeTarget`,
        ) as Error & { code: string };
        err.code = "STEER_MISSING_SCOPE_TARGET";
        throw err;
      }
    }
  }

  return value as unknown as SteeringDecision;
}

export { UnsupportedActionShapeError } from "./normalize";
