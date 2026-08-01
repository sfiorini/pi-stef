import type { FlowYaml } from "./schema.js";
import type { ResolvedModels } from "../config/schema.js";
import { resolveAgentType } from "../agents.js";
import { skillDocPath } from "../messages.js";

/**
 * Build a baked model-hint clause for a tier-1 skill phase prompt (belt-and-
 * suspenders — the skill self-resolves too). Returns "" when no models are
 * available or the skill names no tier-1 model subset.
 */
function tier1Hint(skill: string, models: ResolvedModels | null): string {
  if (!models) return "";
  const tier1 =
    skill === "sf-flow-plan" || skill === "sf-flow-implement" || skill === "sf-flow-audit";
  if (!tier1) return "";
  const parts: string[] = [];
  const push = (label: string, m: string | null) => {
    if (m) parts.push(`${label}=${m}`);
  };
  push("reviewer", models.reviewerModel);
  if (skill === "sf-flow-plan") push("researcher", models.researcherModel);
  if (skill === "sf-flow-implement") push("developer", models.developerModel);
  if (skill === "sf-flow-audit") push("auditor", models.auditorModel);
  return parts.length ? `Models (config; use unless overridden): ${parts.join(", ")}.` : "";
}

function titleCase(s: string): string {
  return s.replace(/(^|[-_])(\w)/g, (_m, _sep, c) => " " + c.toUpperCase()).trim();
}

/** Emit a single-quoted JS string literal, escaping backslashes and apostrophes. */
function singleQuote(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

function agentOpts(
  name: string,
  def: FlowYaml["agents"][string] | undefined,
  phase: string,
  agentType: string,
): string {
  const parts: string[] = [
    `label: ${JSON.stringify(name)}`,
    `phase: ${JSON.stringify(phase)}`,
    `agentType: ${JSON.stringify(agentType)}`,
  ];
  if (def?.tools) parts.push(`tools: ${JSON.stringify(def.tools)}`);
  if (def?.model) parts.push(`model: ${JSON.stringify(def.model)}`);
  if (def?.thinking) parts.push(`thinking: ${JSON.stringify(def.thinking)}`);
  if (def?.isolated) parts.push(`isolated: true`);
  if (def?.schema) parts.push(`schema: ${JSON.stringify(def.schema)}`);
  return `{ ${parts.join(", ")} }`;
}

/**
 * Emit a block-scoped group-loop: gate agent → filter findings → fix phases with
 * findings appended → re-verify → until APPROVED / max_rounds.
 * Gate phase resolved by id (group.phases[0]).
 * F1 invariant: null/crashed gate must NOT be treated as approval.
 */
function emitGroupLoop(groupId: string, group: { phases: string[] }, flow: FlowYaml): string[] {
  const loop = flow.loops?.[groupId];
  const gatePhaseId = group.phases[0];
  const gatePhase = flow.phases.find((p) => p.id === gatePhaseId)!;
  const gateDef = gatePhase.agent ? flow.agents[gatePhase.agent] : undefined;
  const gateAgentType = resolveAgentType(gatePhase.agent!, Object.keys(flow.agents));
  const gateOpts = agentOpts(gatePhase.agent!, gateDef, groupId, gateAgentType);
  const gatePromptLit = JSON.stringify(gatePhase.prompt ?? "");
  const maxRounds = loop?.max_rounds ?? 5;
  const failOn = JSON.stringify(loop?.fail_on ?? ["P0", "P1", "P2"]);
  const lines: string[] = [];
  lines.push(`phase(${JSON.stringify(groupId)});`);
  lines.push(`{`);
  lines.push(`  const _maxRounds = ${maxRounds};`);
  lines.push(`  const _failOn = ${failOn};`);
  lines.push(`  for (let _round = 1; _round <= _maxRounds; _round++) {`);
  lines.push(`    log("Group loop " + ${JSON.stringify(groupId)} + " round " + _round + "/" + _maxRounds + " (gate: " + ${JSON.stringify(gatePhaseId)} + "). Dispatch the gate agent; on REVISE with blocking findings, dispatch fix phases with the canonical findings appended.");`);
  lines.push(`    const _gate = await agent(${gatePromptLit}, ${gateOpts});`);
  lines.push(`    const _findings = (_gate?.findings ?? []);`);
  lines.push(`    const _blocking = _findings.filter((f) => _failOn.includes(f.severity));`);
  lines.push(`    if (_gate?.verdict === "APPROVED" || (_gate && _blocking.length === 0)) { log("APPROVED — group " + ${JSON.stringify(groupId)}); break; }`);
  lines.push(`    if (_round === _maxRounds) {`);
  lines.push(`      log("⚠ NON-CONVERGENT: group " + ${JSON.stringify(groupId)} + " did not converge after " + _maxRounds + " rounds; findings: ");`);
  lines.push(`      log(JSON.stringify(_findings));`);
  lines.push(`      break;`);
  lines.push(`    }`);
  lines.push(`    const _findingsJson = JSON.stringify(_findings);`);
  for (let i = 1; i < group.phases.length; i++) {
    const fixPhase = flow.phases.find((p) => p.id === group.phases[i])!;
    const fixDef = fixPhase.agent ? flow.agents[fixPhase.agent] : undefined;
    const fixAgentType = resolveAgentType(fixPhase.agent!, Object.keys(flow.agents));
    const fixOpts = agentOpts(fixPhase.agent!, fixDef, groupId, fixAgentType);
    const fixPromptLit = JSON.stringify(fixPhase.prompt ?? "");
    lines.push(`    await agent(${fixPromptLit} + "\\n\\nCanonical findings to address:\\n" + _findingsJson, ${fixOpts});`);
  }
  lines.push(`  }`);
  lines.push(`}`);
  return lines;
}

/**
 * Compile a validated FlowYaml into a pi-dynamic-workflows script string.
 * Deterministic + idempotent (no timestamps, no random order). The generator
 * trusts that incompatible loop/phase combos were rejected by validate.ts and
 * hardens itself by throwing if it ever sees one.
 */
export function generateScript(
  flow: FlowYaml,
  genOpts: { models?: ResolvedModels | null } = {},
): string {
  const phaseTitles = flow.phases.map((p) => `{ title: ${singleQuote(titleCase(p.id))} }`).join(", ");
  const body: string[] = [];

  // Pre-scan: map each phase to its group (for grouped-phase skip)
  const phaseToGroup = new Map<string, string>();
  if (flow.groups) for (const [groupId, group] of Object.entries(flow.groups))
    for (const phaseId of group.phases) phaseToGroup.set(phaseId, groupId);
  const emittedGroups = new Set<string>();

  for (const ph of flow.phases) {
    // Grouped-phase skip: emit the group loop once, skip individual phases
    if (phaseToGroup.has(ph.id)) {
      const groupId = phaseToGroup.get(ph.id)!;
      if (!emittedGroups.has(groupId)) { emittedGroups.add(groupId); body.push(...emitGroupLoop(groupId, flow.groups![groupId], flow)); }
      continue;
    }
    body.push(`phase(${JSON.stringify(ph.id)});`);
    const loop = flow.loops?.[ph.id];

    // Questions branch: emit QUESTIONS PHASE directive with clarifying-questions follow-up loop
    if (ph.questions) {
      const maxRounds = ph.max_rounds ?? 5;
      const qDef = flow.agents[ph.questions];
      const qAgentType = resolveAgentType(ph.questions, Object.keys(flow.agents));
      const qOpts = agentOpts(ph.questions, qDef, ph.id, qAgentType);
      const esc = (s: string): string => s.replace(/`/g, "\\`").replace(/\$\{/g, "\\$");
      const directive =
        "`QUESTIONS PHASE: " + esc(ph.questions) + " (max " + maxRounds + " rounds). " +
        "The orchestrator (YOU) must run a clarifying-questions follow-up loop. " +
        "Dispatch the " + esc(ph.questions) + " agent via the Agent tool (subagent_type: " + qAgentType + ", " +
        "model/thinking/isolated/schema per opts: " + qOpts + "). " +
        "It returns { questions: string[] }. If NON-EMPTY: present each via AskUserQuestion (one at a time, " +
        "multiple-choice when possible), collect answers, RE-DISPATCH with prior context + questions + answers. " +
        "Repeat until EMPTY or " + maxRounds + " rounds. If unattended (no user): answer with sensible defaults " +
        "and proceed (do not block). args.flow=${args.flow}, args.slug=${args.slug}.`";
      body.push("log(" + directive + ");");
      body.push("// elicitor agent opts: " + qOpts);
      continue;
    }

    if (ph.skill) {
      if (loop) {
        throw new Error(
          `phase ${ph.id}: loops are not supported on skill phases (validate.ts should have rejected this)`,
        );
      }
      // Skill phase: run INLINE in the orchestrator (no nested general-purpose
      // twin). Emit a log() directive the orchestrator reads as an instruction:
      // read + execute the skill file itself, dispatch role agents via the Agent
      // tool, and never spawn a general-purpose subagent for this phase.
      const hint = tier1Hint(ph.skill, genOpts.models ?? null);
      const skillPath = skillDocPath(ph.skill);
      // Escape backticks and ${ in values baked in at codegen time so they
      // can't break the emitted log(`…`) template literal. args.flow/args.slug
      // stay literal (runtime interpolations, not escaped).
      const esc = (s: string): string => s.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
      const directive =
        "`INLINE SKILL PHASE: " + esc(ph.skill) + ". " +
        "The orchestrator (YOU) must read and execute the skill file at " + esc(skillPath) + " in full. " +
        "Dispatch role agents directly via the Agent tool (subagent_type per the skill); do NOT write code yourself " +
        "and do NOT spawn a general-purpose subagent for this phase \u2014 run it inline. " +
        "Workflow " + esc(flow.name) + ". args.flow=${args.flow}, args.slug=${args.slug}. " + esc(hint) + "`";
      body.push("log(" + directive + ");");
      continue;
    }
    if (ph.raw) {
      body.push(ph.raw);
      continue;
    }

    const def = ph.agent ? flow.agents[ph.agent] : undefined;
    if (!ph.agent) throw new Error(`phase ${ph.id} has no resolvable agent`);
    // Resolve the pi-subagents agent type via the shared rule: a declared agent
    // spawns by name; an undeclared planner/reviewer falls back to the built-in;
    // anything else undeclared → general-purpose. `def` may be undefined for a
    // built-in fallback (agentOpts tolerates it).
    const agentType = resolveAgentType(ph.agent, Object.keys(flow.agents));
    const opts = agentOpts(ph.agent, def, ph.id, agentType);
    const promptLit = JSON.stringify(ph.prompt ?? "");

    if (ph.fanout) {
      // fanout iterates a list variable; treat it as an array (the producing
      // phase / external input is expected to yield an array).
      const mapFn = `${ph.fanout}.map((item) => () => agent(${promptLit}.replace(/{{item}}/g, item), ${opts}))`;
      if (loop?.until_dry) {
        const dedupKey = JSON.stringify(loop.dedup_key ?? "");
        body.push(
          `const ${ph.out} = await loopUntilDry({ round: async () => (await parallel(${mapFn})).filter(Boolean), key: (f) => ${dedupKey}.replace(/{{(\\w+)}}/g, (_m, k) => f[k] ?? ""), consecutiveEmpty: ${loop.consecutive_empty ?? 2}, maxRounds: ${loop.max_rounds ?? 3} });`,
        );
      } else {
        body.push(`const ${ph.out} = (await parallel(${mapFn})).filter(Boolean);`);
      }
    } else if (loop?.until === "approved") {
      // Gate on the agent's verdict, honoring fail_on: a REVISE verdict only
      // blocks when at least one finding severity is in fail_on (default P0/P1/P2).
      // Phases without `out` emit a bare gate() call (no discard const, so two
      // gate-without-out phases can't collide).
      const failOn = JSON.stringify(loop.fail_on ?? ["P0", "P1", "P2"]);
      const gateCall = `await gate(async () => agent(${promptLit}, ${opts}), (r) => { if (r?.verdict === "APPROVED") return { ok: true }; const failOn = ${failOn}; const findings = (r?.findings ?? []); const blocking = findings.filter((f) => failOn.includes(f.severity)); return blocking.length === 0 ? { ok: true } : { ok: false, feedback: JSON.stringify(findings) }; }, { attempts: ${loop.max_rounds ?? 5} })`;
      if (ph.out) {
        body.push(`const ${ph.out} = ${gateCall};`);
      } else {
        body.push(gateCall + ";");
      }
    } else {
      const assign = ph.out ? `const ${ph.out} = ` : "";
      body.push(`${assign}await agent(${promptLit}, ${opts});`);
    }
  }

  body.push(`return { name: ${JSON.stringify(flow.name)} };`);

  return [
    `export const meta = {`,
    `  name: ${singleQuote(flow.name)},`,
    `  description: ${JSON.stringify(flow.description)},`,
    `  phases: [${phaseTitles}],`,
    `};`,
    ``,
    ...body,
  ].join("\n");
}
