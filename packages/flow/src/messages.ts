/**
 * Result-message builders for flow tools.
 *
 * The implement/auto tools return directive-first messages that make the
 * agent CONTINUE in the same turn (cd into the worktree / read the skill file),
 * with factual context demoted to a Context block.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { configModelFor, type ResolvedModels } from "./config/schema.js";
import type { FlowYaml } from "./yaml/schema.js";

export type PhaseModelInfo = {
  phase: string;
  kind: "tier1-skill" | "tier2-agent" | "tier2-elicitor" | "other";
  skill?: string;
  agent?: string;
  /** The model this phase will ACTUALLY use per precedence, or null = inherit orchestrator. */
  model: string | null;
  /** Human label of where `model` came from. */
  source: string;
};

/**
 * Summarize the model EACH phase will actually use, per the documented precedence:
 *  - tier-1 skill phase (sf-flow-plan/implement/audit): a REPRESENTATIVE config-chain
 *    model (the skill's primary role) — indicative only; tier-1 skills self-resolve
 *    ALL their role agents (researcher/designer/planner/reviewer/developer) from the
 *    full config chain per the documented Model resolution chain.
 *  - tier-2 agent phase: YAML agents.<name>.model (baked by generate.ts agentOpts),
 *    else config <group>.model (when the agent name matches a group),
 *    else .md model:, else inherit orchestrator (inline wins).
 *  - questions-phase elicitor: same chain via configModelFor.
 */
export function summarizePhaseModels(flow: FlowYaml, models: ResolvedModels | null): PhaseModelInfo[] {
  const TIER1 = new Set(["sf-flow-plan", "sf-flow-implement", "sf-flow-audit"]);
  const tier1ModelFor = (skill: string): string | null => {
    if (skill === "sf-flow-plan") return models?.researcherModel ?? null;
    if (skill === "sf-flow-implement") return models?.developerModel ?? null;
    if (skill === "sf-flow-audit") return models?.reviewerModel ?? null;
    return null;
  };
  return flow.phases.map((ph) => {
    if (ph.skill) {
      const isTier1 = TIER1.has(ph.skill);
      return {
        phase: ph.id,
        kind: isTier1 ? "tier1-skill" : "other",
        skill: ph.skill,
        model: isTier1 ? tier1ModelFor(ph.skill) : null,
        source: isTier1 ? (tier1ModelFor(ph.skill) ? "config (representative role)" : "inherit orchestrator") : "inherit orchestrator",
      };
    }
    if (ph.raw) {
      return {
        phase: ph.id,
        kind: "other" as const,
        model: null,
        source: "raw phase (no model resolution)",
      };
    }
    if (ph.questions) {
      const def = flow.agents[ph.questions];
      const yamlModel = def?.model ?? null;
      const configModel = configModelFor(ph.questions, models);
      const resolved = yamlModel ?? configModel;
      const source = yamlModel ? "YAML agents.<name>.model" : configModel ? `config ${ph.questions}.model` : "inherit orchestrator (.md model: / orchestrator)";
      return { phase: ph.id, kind: "tier2-elicitor" as const, agent: ph.questions, model: resolved, source };
    }
    const def = ph.agent ? flow.agents[ph.agent] : undefined;
    const yamlModel = def?.model ?? null;
    const configModel = configModelFor(ph.agent ?? "", models);
    const resolved = yamlModel ?? configModel;
    return {
      phase: ph.id,
      kind: "tier2-agent",
      agent: ph.agent,
      model: resolved,
      source: yamlModel ? "YAML agents.<name>.model" : configModel ? `config ${ph.agent}.model` : "inherit orchestrator (.md model: / orchestrator)",
    };
  });
}

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to an internal flow skill doc (loaded by tools via `read`; NOT pi-discovered — see pi.skills: []). */
export function skillDocPath(name: string): string {
  return join(pkgRoot, "skills", name, "SKILL.md");
}

export interface ImplementReadyInput {
  slug: string;
  worktreePath: string;
  reviewerModel: string | null;
  developerModel: string | null;
  planPath: string;
}

export function buildImplementReadyMessage(opts: ImplementReadyInput): string {
  const reviewerLine = opts.reviewerModel
    ? `Reviewer model: ${opts.reviewerModel}`
    : "Reviewer model: inherits from parent (not configured)";
  const developerLine = opts.developerModel
    ? `Developer model: ${opts.developerModel}`
    : "Developer model: inherits from parent (not configured)";
  return [
    `Continue executing now — do not stop after this tool returns.`,
    ``,
    `1. Run: cd ${opts.worktreePath}`,
    `2. Read and execute the skill file at ${skillDocPath("sf-flow-implement")} in full: implement`,
    `   every milestone with the TDD→review→commit→tracker loop, then call`,
    `   sf_flow_finalize with worktree_path "${opts.worktreePath}".`,
    `   Do not stop between milestones or ask for confirmation.`,
    ``,
    `Context:`,
    `- ${reviewerLine}`,
    `- ${developerLine}`,
    `- Plan path: ${opts.planPath}`,
  ]
    .join("\n")
    .replace(/\n+$/g, "\n");
}

export interface AutoReadyInput {
  workflowName: string;
  inputSummary: string;
  /** Absolute path resolved by `resolveWorkflowPath` (project override → global). */
  resolvedWorkflowPath: string;
  /** Pre-generated pi-dw script (skill phases run INLINE — no general-purpose twin). Optional so legacy callers/tests omit it. */
  script?: string;
  /** Resolved models, rendered as a reference table for the orchestrator. Optional. */
  models?: ResolvedModels | null;
  /** Optional per-phase model summary (accurate per precedence). */
  phaseModels?: PhaseModelInfo[];
  /** Whether any phase uses `questions:` (conditional gates). */
  hasConditionalGates?: boolean;
}

export function buildAutoReadyMessage(opts: AutoReadyInput): string {
  const lines: string[] = [
    `Continue executing now — do not stop after this tool returns.`,
    ``,
    `Running flow "${opts.workflowName}" end-to-end.`,
    `Input: ${opts.inputSummary}`,
    `Workflow file: ${opts.resolvedWorkflowPath}`,
    opts.hasConditionalGates
      ? `Conditional gates — questions phases pause for user input but auto-fallback to defaults if unattended; all other phases run to completion or a terminal state.`
      : `No human gates — phases run to completion or a terminal state.`,
  ];
  if (opts.script) {
    lines.push(``);
    lines.push(
      `The tool already generated the pi-dw orchestration script below. Skill phases run INLINE — YOU are the orchestrator: read + execute each skill file in full, dispatch role agents via the Agent tool, write NO code yourself, and spawn NO general-purpose subagent for a skill phase.`,
    );
    lines.push(``);
    lines.push("```js");
    lines.push(opts.script);
    lines.push("```");
  }
  if (opts.models) {
    lines.push(``);
    lines.push(`Config model groups (tier-1 skills + tier-2 agents with a matching group; inline YAML wins; inherit the orchestrator when null):`);
    lines.push(`- reviewer: ${opts.models.reviewerModel ?? "(inherit orchestrator)"}`);
    lines.push(`- researcher: ${opts.models.researcherModel ?? "(inherit orchestrator)"}`);
    lines.push(`- developer: ${opts.models.developerModel ?? "(inherit orchestrator)"}`);
    lines.push(`- planner: ${opts.models.plannerModel ?? "(inherit orchestrator)"}`);
    lines.push(`- auditor: ${opts.models.auditorModel ?? "(inherit orchestrator)"}`);
    lines.push(`- synth: ${opts.models.synthModel ?? "(inherit orchestrator)"}`);
    lines.push(`- designer: ${opts.models.designerModel ?? "(inherit orchestrator)"}`);
    lines.push(`- notifier: ${opts.models.notifierModel ?? "(inherit orchestrator)"}`);
    lines.push(`- scanner: ${opts.models.scannerModel ?? "(inherit orchestrator)"}`);
    if (opts.phaseModels && opts.phaseModels.length) {
      lines.push(``);
      lines.push(`Per-phase models (what each phase ACTUALLY uses):`);
      for (const p of opts.phaseModels) {
        const who = p.skill ? `skill ${p.skill}` : p.agent ? `agent ${p.agent}` : "(no agent)";
        lines.push(`- ${p.phase} (${p.kind}, ${who}): ${p.model ?? "(inherit orchestrator)"} — ${p.source}`);
      }
    }
  }
  lines.push(``);
  lines.push(`Read and execute the skill file at ${skillDocPath("sf-flow-auto")} in full: run every phase`);
  lines.push(`to a terminal state. Do not stop after reading the skill. Do not ask for confirmation.`);
  return lines.join("\n").replace(/\n+$/g, "\n");
}
