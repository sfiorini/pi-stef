import { Value } from "@sinclair/typebox/value";
import { FlowYamlSchema, type FlowYaml } from "./schema.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Flow's own slash-command namespace — user flows must not shadow these. */
const RESERVED_NAME = /^sf[_-]flow[_-]/i;

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
    for (const [phaseId, loop] of Object.entries(flow.loops)) {
      // S-14: skip group-keyed loops here; S-15 adds full group-aware validation
      if (flow.groups && phaseId in flow.groups) continue;
      const phase = flow.phases.find((p) => p.id === phaseId);
      if (!phase) {
        errors.push(`loops.${phaseId}: no such phase`);
        continue;
      }
      if (phase.skill) {
        errors.push(`loops.${phaseId}: loops are not supported on skill phases (a skill phase returns no structured verdict to gate on)`);
        continue;
      }
      if (phase.raw) {
        errors.push(`loops.${phaseId}: loops are not supported on raw phases`);
        continue;
      }
      if (loop.until_dry && !phase.fanout) {
        errors.push(
          `loops.${phaseId}: until_dry requires the phase to set fanout (discovery loop runs over a list)`,
        );
      }
      if (loop.until === "approved") {
        const ag = phase?.agent ? flow.agents[phase.agent] : undefined;
        if (!ag?.schema || !(ag.schema as Record<string, unknown>).verdict) {
          errors.push(
            `loops.${phaseId}: until:approved requires phase agent to declare a verdict schema`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
