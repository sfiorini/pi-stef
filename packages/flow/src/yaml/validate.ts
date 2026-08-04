import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { existsSync } from "node:fs";
import { FlowYamlSchema, AgentDef, PhaseDef, LoopDef, GroupDef, type FlowYaml } from "./schema.js";
import { requiredNames, availableBefore } from "./contract.js";
import { resolveTemplate } from "../paths.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Resolve a template ref and stat it; never throws (validation is read-only). */
function templateExists(ref: string): boolean {
  try {
    return existsSync(resolveTemplate(ref));
  } catch {
    return false;
  }
}

/** Flow's own slash-command namespace — user flows must not shadow these. */
const RESERVED_NAME = /^sf[_-]flow[_-]/i;

/**
 * Kebab-case format: lowercase alphanumeric and hyphens, starting with an
 * alphanumeric character. Blocks slashes, dots, underscores, path traversal
 * sequences, and anything that could escape the workflows directory.
 */
const KEBAB_CASE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate a flow YAML object: structural (TypeBox) + cross-field rules the
 * schema can't express. Cross-field rules reject combinations the generator
 * can't honor so a loop/fanout is never silently swallowed.
 */
export function validateFlowYaml(input: unknown): ValidationResult {
  const errors: string[] = [];
  const typeErrors = [...Value.Errors(FlowYamlSchema, input)];
  if (typeErrors.length > 0) {
    return { ok: false, errors: typeErrors.map((e) => `${e.path}: ${e.message}`) };
  }
  const flow = input as FlowYaml;
  if (RESERVED_NAME.test(flow.name)) {
    errors.push(
      `name "${flow.name}": reserved (the sf-flow-/sf_flow_ prefix is flow's own command namespace)`,
    );
  }
  if (!KEBAB_CASE_NAME.test(flow.name)) {
    errors.push(
      `name "${flow.name}": must be kebab-case (lowercase alphanumeric and hyphens, starting alphanumeric — no slashes, dots, or path traversal)`,
    );
  }
  const agentNames = new Set(Object.keys(flow.agents));
  const outs = new Set<string>();

  for (const ph of flow.phases) {
    const runKinds = [ph.agent, ph.skill, ph.raw, ph.questions].filter(Boolean);
    if (runKinds.length === 0) errors.push(`phase "${ph.id}": must set one of agent/skill/raw/questions`);
    if (runKinds.length > 1)
      errors.push(`phase "${ph.id}": set at most one of agent/skill/raw/questions`);
    if (ph.agent && !agentNames.has(ph.agent))
      errors.push(`phase "${ph.id}": agent "${ph.agent}" not defined in agents`);
    if (ph.questions && !agentNames.has(ph.questions))
      errors.push(`phase "${ph.id}": questions "${ph.questions}" not defined in agents`);
    if (ph.questions && ph.fanout)
      errors.push(`phase "${ph.id}": questions and fanout are mutually exclusive`);
    if (ph.questions && ph.verify)
      errors.push(`phase "${ph.id}": questions and verify are mutually exclusive`);
    // fanout only applies to agent phases (skill/raw are opaque to the generator).
    if (ph.fanout && (ph.skill || ph.raw))
      errors.push(`phase "${ph.id}": fanout is only supported on agent phases`);
    if (ph.fanout && !ph.out)
      errors.push(
        `phase "${ph.id}": fanout requires the phase to declare out (the parallel results must be captured)`,
      );
    if (ph.verify && !outs.has(ph.verify))
      errors.push(`phase "${ph.id}": verify "${ph.verify}" references no prior out`);
    if (ph.out && outs.has(ph.out))
      errors.push(
        `phase "${ph.id}": out "${ph.out}" is already declared by an earlier phase (duplicate const would be emitted)`,
      );
    if (ph.out) outs.add(ph.out);
  }

  // Contract-graph rules (spec §16): every inputs.require must resolve to a
  // prior publish/input; worktree:finalize needs a preceding prepare; artifact
  // templates must exist; publish names/values must be codegen-safe. A missing
  // require is exactly the "self-defeating dataflow" that makes a skipped phase
  // block the next one instead of silently starving it.
  let prepareSeen = false;
  flow.phases.forEach((ph, i) => {
    const avail = availableBefore(flow, i);
    for (const req of requiredNames(ph)) {
      if (!avail.has(req))
        errors.push(
          `phase "${ph.id}": inputs.require "${req}" is unresolved (no prior publish/input)`,
        );
    }
    if (ph.worktree === "finalize" && !prepareSeen)
      errors.push(
        `phase "${ph.id}": worktree:finalize requires a preceding worktree:prepare phase`,
      );
    if (ph.worktree === "prepare") prepareSeen = true;
    for (const a of ph.outputs?.artifacts ?? [])
      if (a.template && !templateExists(a.template))
        errors.push(`phase "${ph.id}": artifact template "${a.template}" not found`);
    if (ph.outputs?.publish) {
      for (const [k, v] of Object.entries(ph.outputs.publish)) {
        if (!/^[a-z_][a-z0-9_]*$/i.test(k))
          errors.push(`phase "${ph.id}": publish name "${k}" is not a valid identifier`);
        if (v === undefined) errors.push(`phase "${ph.id}": publish "${k}" has no value`);
        // Bare-name publish values (not {{...}}, not a literal) must resolve to
        // this phase's own out or a prior publish, else the generated JS would
        // reference an undefined variable.
        const vm = v.match(/^\{\{(\w+)\}\}$/);
        if (!vm && /^[a-z_]\w*$/i.test(v) && v !== ph.out && !avail.has(v))
          errors.push(
            `phase "${ph.id}": publish value "${v}" is not {{...}}, a literal, the phase out, or a prior publish`,
          );
      }
    }
  });

  if (flow.groups) {
    const phaseInGroup = new Map<string, string>();
    for (const [groupId, group] of Object.entries(flow.groups)) {
      for (const phaseId of group.phases) {
        const phase = flow.phases.find((p) => p.id === phaseId);
        if (!phase) { errors.push(`groups.${groupId}: phase "${phaseId}" does not exist`); continue; }
        const existing = phaseInGroup.get(phaseId);
        if (existing) errors.push(`groups.${groupId}: phase "${phaseId}" already belongs to group "${existing}"`);
        else phaseInGroup.set(phaseId, groupId);
        if (!phase.agent)
          errors.push(`groups.${groupId}: phase "${phaseId}" must be an agent phase (skill/raw/questions phases cannot participate in group loops)`);
      }
      if (!flow.loops || !(groupId in flow.loops))
        errors.push(`groups.${groupId}: no matching loops.${groupId} (a group must be looped)`);
    }
  }

  if (flow.loops) {
    for (const [key, loop] of Object.entries(flow.loops)) {
      const group = flow.groups?.[key];
      if (group) {
        if (loop.until_dry) { errors.push(`loops.${key}: until_dry is not valid on a group loop (use until: approved)`); continue; }
        if (loop.until === "approved") {
          const gatePhase = flow.phases.find((p) => p.id === group.phases[0]);
          const gateAgent = gatePhase?.agent ? flow.agents[gatePhase.agent] : undefined;
          if (!gateAgent?.schema || !(gateAgent.schema as Record<string, unknown>).verdict)
            errors.push(`loops.${key}: until:approved requires the gate phase's agent ("${gatePhase?.agent}") to declare a verdict schema`);
        }
        continue;
      }
      const phase = flow.phases.find((p) => p.id === key);
      if (!phase) { errors.push(`loops.${key}: no such phase`); continue; }
      if (phase.skill) { errors.push(`loops.${key}: loops are not supported on skill phases (a skill phase returns no structured verdict to gate on)`); continue; }
      if (phase.raw) { errors.push(`loops.${key}: loops are not supported on raw phases`); continue; }
      if (phase.questions) { errors.push(`loops.${key}: loops are not supported on questions phases (the follow-up loop is built-in)`); continue; }
      if (loop.until_dry && !phase.fanout) errors.push(`loops.${key}: until_dry requires the phase to set fanout (discovery loop runs over a list)`);
      if (loop.until === "approved") {
        const ag = phase?.agent ? flow.agents[phase.agent] : undefined;
        if (!ag?.schema || !(ag.schema as Record<string, unknown>).verdict)
          errors.push(`loops.${key}: until:approved requires phase agent to declare a verdict schema`);
      }
    }
  }

  // Strict profile for bundled ship-feature — only runs once a phase declares a
  // contract (outputs). Full rules land when ship-feature migrates (M7); until
  // then the gate keeps current workflows unaffected.
  if (flow.phases.some((p) => p.outputs)) {
    errors.push(...validateStrictProfile(flow));
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Extra invariants for the bundled ship-feature workflow (strict profile).
 * Spec §16: the plan phase must produce plan artifacts and the implement phase
 * must require the slug handed to it by the planner.
 */
export function validateStrictProfile(flow: FlowYaml): string[] {
  const errs: string[] = [];
  if (flow.name !== "ship-feature") return errs;
  const hasPlanProducer = flow.phases.some((p) => p.outputs?.artifacts?.length);
  if (!hasPlanProducer) errs.push("ship-feature: no phase produces plan artifacts");
  const implementer = flow.phases.find((p) => /implement/i.test(p.id));
  if (implementer && !implementer.inputs?.require?.includes("slug"))
    errs.push('ship-feature: implement phase must require "slug"');
  return errs;
}

export type FlowSection = "agents" | "phases" | "loops" | "groups";

const SECTION_SCHEMAS = {
  agents: Type.Record(Type.String(), AgentDef),
  phases: Type.Array(PhaseDef, { minItems: 1 }),
  loops: Type.Record(Type.String(), LoopDef),
  groups: Type.Record(Type.String(), GroupDef),
} as const;

export function validateSection(section: FlowSection, value: unknown): ValidationResult {
  const schema = SECTION_SCHEMAS[section];
  const errors = [...Value.Errors(schema, value)];
  if (errors.length > 0) return { ok: false, errors: errors.map((e) => `${section}.${e.path}: ${e.message}`) };
  return { ok: true, errors: [] };
}
