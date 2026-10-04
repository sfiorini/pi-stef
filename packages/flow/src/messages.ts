/**
 * Result-message builders for flow tools.
 *
 * The implement/auto tools return directive-first messages that make the
 * agent CONTINUE in the same turn (cd into the worktree / read the skill file),
 * with factual context demoted to a Context block.
 *
 * Models are REPORT-ONLY here: each agent's model lives in its `.md`
 * frontmatter (project .pi/agents overrides global ~/.pi/agent/agents;
 * pi-subagents applies it natively). The orchestrator is told NOT to pass a
 * model at dispatch — passing one would override the `.md` pin.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { AgentFileInfo } from "./config/agent-files.js";
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

/** Discovered agent `.md` info by agent name (null = no .md found). */
export type AgentInfoMap = Map<string, AgentFileInfo | null>;

/**
 * Summarize the model EACH phase will actually use:
 *  - tier-1 skill phase (sf-flow-plan/implement/audit): the skill dispatches
 *    its role agents per their `.md` files — reported from the info map
 *    (representative role per skill), else inherit the orchestrator.
 *  - tier-2 agent phase: the agent's `.md` `model:` frontmatter (read from the
 *    info map), else inherit the orchestrator.
 *  - raw phase: opaque user JS — no resolution, reported as such.
 */
export function summarizePhaseModels(flow: FlowYaml, agentInfo: AgentInfoMap): PhaseModelInfo[] {
  const TIER1_ROLE: Record<string, string> = {
    "sf-flow-plan": "researcher",
    "sf-flow-implement": "developer",
    "sf-flow-audit": "reviewer",
  };
  const mdModelFor = (name: string): { model: string | null; source: string } => {
    const info = agentInfo.get(name);
    if (!info) return { model: null, source: "no .md — built-in/general-purpose fallback" };
    if (info.frontmatter.enabled === false) return { model: null, source: `.md (${info.source}) — DISABLED (enabled: false)` };
    if (info.frontmatter.model) return { model: info.frontmatter.model, source: `.md (${info.source})` };
    return { model: null, source: `.md (${info.source}) — no model, inherits orchestrator` };
  };
  return flow.phases.map((ph) => {
    if (ph.skill) {
      const role = TIER1_ROLE[ph.skill];
      const isTier1 = role !== undefined;
      const md = isTier1 ? mdModelFor(role!) : null;
      return {
        phase: ph.id,
        kind: isTier1 ? "tier1-skill" : "other",
        skill: ph.skill,
        model: md?.model ?? null,
        source: isTier1
          ? md?.source ?? "role agents per their .md — inherit orchestrator"
          : "role agents per their .md",
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
    const agentName = ph.questions ?? ph.agent;
    const md = agentName ? mdModelFor(agentName) : null;
    return {
      phase: ph.id,
      kind: ph.questions ? ("tier2-elicitor" as const) : ("tier2-agent" as const),
      agent: agentName,
      model: md?.model ?? null,
      source: md?.source ?? "no .md — built-in/general-purpose fallback",
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
  planPath: string;
  /** Discovered agent info for the reviewer/developer roles (report-only). */
  reviewerInfo?: AgentFileInfo | null;
  developerInfo?: AgentFileInfo | null;
}

function agentModelLine(role: string, info: AgentFileInfo | null | undefined): string {
  if (!info) return `${role}: no .md found (built-in/general-purpose fallback) — inherits the orchestrator`;
  if (info.frontmatter.enabled === false) return `${role}: ${info.path} — DISABLED (enabled: false)`;
  return info.frontmatter.model
    ? `${role}: ${info.frontmatter.model} (pinned in ${info.path})`
    : `${role}: inherits the orchestrator (no model: in ${info.path})`;
}

export function buildImplementReadyMessage(opts: ImplementReadyInput): string {
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
    `- ${agentModelLine("Reviewer", opts.reviewerInfo)}`,
    `- ${agentModelLine("Developer", opts.developerInfo)}`,
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
  /** Optional per-phase model summary (report-only, from the agents' .md files). */
  phaseModels?: PhaseModelInfo[];
  /** Whether any phase uses `questions:` (conditional gates). */
  hasConditionalGates?: boolean;
  /** Run-level slug sf_flow_auto derived once at start (args.slug); the generated
   *  script's checkpoint dir is `ai_plan/<slug>`. Optional for legacy callers. */
  slug?: string;
  /** Agents declared by the workflow with no discoverable .md (typo guard — surfaced as a warning). */
  missingAgents?: string[];
}

export function buildAutoReadyMessage(opts: AutoReadyInput): string {
  const lines: string[] = [
    `Continue executing now — do not stop after this tool returns.`,
    ``,
    `Running flow "${opts.workflowName}" end-to-end.`,
    `Input: ${opts.inputSummary}`,
    `Workflow file: ${opts.resolvedWorkflowPath}`,
    opts.hasConditionalGates
      ? `Gates: only questions: phases pause for user input (auto-fallback to sensible defaults if unattended). Every other phase runs to a terminal state with no human gate; a blocked phase is terminal — stop and report it with its resumeState.`
      : `Gates: no human gates — every phase runs to a terminal state (success or blocked). A blocked phase is terminal — stop and report it with its resumeState.`,
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
  lines.push(``);
  lines.push(`Models: agents resolve from their .md files (project .pi/agents overrides global ~/.pi/agent/agents).`);
  lines.push(`Do NOT pass a model at dispatch — pi-subagents applies the agent .md model, else inherits the orchestrator.`);
  if (opts.phaseModels && opts.phaseModels.length) {
    lines.push(`Per-phase effective models (informational):`);
    for (const p of opts.phaseModels) {
      const who = p.skill ? `skill ${p.skill}` : p.agent ? `agent ${p.agent}` : "(no agent)";
      lines.push(`- ${p.phase} (${p.kind}, ${who}): ${p.model ?? "(inherit orchestrator)"} — ${p.source}`);
    }
  }
  if (opts.missingAgents?.length) {
    lines.push(``);
    lines.push(`⚠ No .md found for: ${opts.missingAgents.join(", ")} — they fall back to the built-in/general-purpose agent. If this is a typo, create or rename the agent .md.`);
  }
  lines.push(``);
  lines.push(`Contract enforcement: the generated script calls helper tools around each phase —`);
  lines.push(`sf_flow_contract (derive-slug/materialize/assert), sf_flow_checkpoint (load-required/complete/load-all),`);
  lines.push(`sf_flow_prepare (worktree prepare) + sf_flow_finalize (finalize), and sf_flow_gate (canonical-delta).`);
  lines.push(`Follow the emitted steps exactly; a {status:"blocked"} return is terminal — stop, report it, and surface`);
  lines.push(`resumeState.stateFile so the next run resumes there.`);
  lines.push(`Inputs + outputs: the original input is captured at ai_plan/<slug>/prompt.md (read it there; never write`);
  lines.push(`prompt files to the repo root). Every artifact goes under ai_plan/<slug>/.`);
  lines.push(`Runtime context: args = { input: <bind to the resolved workflow input>, flow: ${JSON.stringify(opts.workflowName)}, slug: ${opts.slug ? JSON.stringify(opts.slug) : "<derived>"} }.`);
  lines.push(``);
  lines.push(`Read and execute the skill file at ${skillDocPath("sf-flow-auto")} in full: run every phase`);
  lines.push(`to a terminal state. Do not stop after reading the skill. Do not ask for confirmation.`);
  return lines.join("\n").replace(/\n+$/g, "\n");
}
