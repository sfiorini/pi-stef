import type { FlowYaml } from "./schema.js";
import type { ResolvedModels } from "../config/schema.js";
import { resolveAgentType } from "../agents.js";

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
  if (skill === "sf-flow-plan") push("explorer", models.explorerModel);
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

  for (const ph of flow.phases) {
    body.push(`phase(${JSON.stringify(ph.id)});`);
    const loop = flow.loops?.[ph.id];

    if (ph.skill) {
      if (loop) {
        throw new Error(
          `phase ${ph.id}: loops are not supported on skill phases (validate.ts should have rejected this)`,
        );
      }
      // Skill phase: the runner agent reads + executes the skill. Pass the
      // workflow name + a RUNTIME slug reference so the skill writes/reads at
      // the CONVENTIONAL location keyed by slug — a skill phase cannot know a
      // concrete path at compile time. args.flow/args.slug are provided by
      // sf_flow_auto at run time (slug is derived from args.input). The model
      // hint is belt-and-suspenders; the skill self-resolves if absent.
      const hint = tier1Hint(ph.skill, genOpts.models ?? null);
      const promptExpr =
        "`run skill " +
        JSON.stringify(ph.skill) +
        ". Workflow " +
        JSON.stringify(flow.name) +
        ". args.flow=${args.flow}, args.slug=${args.slug}. Read/write at the conventional location for this skill. " +
        hint +
        "`";
      body.push(
        "await agent(" +
          promptExpr +
          ", { phase: " +
          JSON.stringify(ph.id) +
          ', agentType: "general-purpose" });',
      );
      // (placeholder const dropped — downstream phases self-discover artifacts
      // at the conventional slug-keyed location; `in:`/`out:` are informational.)
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
