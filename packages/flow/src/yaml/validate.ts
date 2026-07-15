import { Value } from "@sinclair/typebox/value";
import { FlowYamlSchema, type FlowYaml } from "./schema.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

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
  const agentNames = new Set(Object.keys(flow.agents));
  const outs = new Set<string>();

  for (const ph of flow.phases) {
    const runKinds = [ph.agent, ph.skill, ph.raw].filter(Boolean);
    if (runKinds.length === 0) errors.push(`phase "${ph.id}": must set one of agent/skill/raw`);
    if (ph.agent && !agentNames.has(ph.agent))
      errors.push(`phase "${ph.id}": agent "${ph.agent}" not defined in agents`);
    // fanout only applies to agent phases (skill/raw are opaque to the generator).
    if (ph.fanout && (ph.skill || ph.raw))
      errors.push(`phase "${ph.id}": fanout is only supported on agent phases`);
    if (ph.fanout && !ph.out)
      errors.push(
        `phase "${ph.id}": fanout requires the phase to declare out (the parallel results must be captured)`,
      );
    if (ph.verify && !outs.has(ph.verify))
      errors.push(`phase "${ph.id}": verify "${ph.verify}" references no prior out`);
    if (ph.out) outs.add(ph.out);
  }

  if (flow.loops) {
    for (const [phaseId, loop] of Object.entries(flow.loops)) {
      const phase = flow.phases.find((p) => p.id === phaseId);
      if (!phase) {
        errors.push(`loops.${phaseId}: no such phase`);
        continue;
      }
      if (phase.skill) {
        errors.push(`loops.${phaseId}: loops are not supported on skill phases (skill chains are opaque)`);
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
