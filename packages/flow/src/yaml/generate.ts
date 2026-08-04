import type { FlowYaml, PhaseDef } from "./schema.js";
import { configModelFor, type ResolvedModels } from "../config/schema.js";
import { resolveAgentType } from "../agents.js";
import { skillDocPath } from "../messages.js";
import { requiredNames } from "./contract.js";

/**
 * Build a baked model-hint clause for a tier-1 skill phase (belt-and-
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

/** Codegen helper: the emitted JS for a blocked terminal return at a phase. The
 *  shape mirrors the success terminal so a blocked run still carries a resume
 *  pointer (the state file the orchestrator reloads on the next invocation). */
function blockedReturn(flowName: string, phaseId: string): string {
  return `return { name: ${JSON.stringify(flowName)}, status: "blocked", finalPhase: ${JSON.stringify(phaseId)}, resumeState: { stateFile: \`ai_plan/\${args.slug}/.flow-state.json\` } };`;
}

function agentOpts(
  name: string,
  def: FlowYaml["agents"][string] | undefined,
  phase: string,
  agentType: string,
  configModel?: string | null,
): string {
  const parts: string[] = [
    `label: ${JSON.stringify(name)}`,
    `phase: ${JSON.stringify(phase)}`,
    `agentType: ${JSON.stringify(agentType)}`,
  ];
  if (def?.tools) parts.push(`tools: ${JSON.stringify(def.tools)}`);
  const resolvedModel = def?.model ?? configModel ?? undefined;
  if (resolvedModel) parts.push(`model: ${JSON.stringify(resolvedModel)}`);
  if (def?.thinking) parts.push(`thinking: ${JSON.stringify(def.thinking)}`);
  if (def?.isolated) parts.push(`isolated: true`);
  if (def?.schema) parts.push(`schema: ${JSON.stringify(def.schema)}`);
  return `{ ${parts.join(", ")} }`;
}

// --- contract codegen helpers ------------------------------------------------

/**
 * codegen helper: a YAML string with {{name}} -> a JS template-literal referencing
 * the in-scope variable `name`. e.g. "D: {{design_doc}}" -> `D: ${design_doc}`;
 * "ai_plan/{{slug}}" -> `ai_plan/${slug}`. Backticks/${ already present are escaped.
 */
function tmplToJs(s: string): string {
  const esc = s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return "`" + esc.replace(/\{\{(\w+)\}\}/g, (_, n) => "${" + n + "}") + "`";
}

/**
 * Map a declared publish value to a JS expression: {{slug}}->slug, {{dir}}->_dir,
 * a bare identifier -> itself, anything else -> a string literal. Validation
 * (validate.ts) guarantees bare/{{X}} values resolve to an in-scope const.
 */
function publishValueToJs(v: string): string {
  const m = v.match(/^\{\{(\w+)\}\}$/);
  if (m) return m[1] === "dir" ? "_dir" : m[1];
  if (/^[a-z_]\w*$/i.test(v)) return v;
  return JSON.stringify(v);
}

/** Build the agent prompt as a JS expression: base prompt + each inject line, with
 *  {{name}} resolved to JS refs (no runtime placeholders). Falls back to the bare
 *  prompt literal when there is nothing to inject (backward-compatible). */
function agentPromptExpr(prompt: string, ph: PhaseDef): string {
  const lines =
    ph.inputs?.inject ??
    (ph.in ? (Array.isArray(ph.in) ? ph.in.map((n) => `{{${n}}}`) : [`{{${ph.in}}}`]) : []);
  if (!lines.length) return JSON.stringify(prompt ?? "");
  return (
    JSON.stringify((prompt ?? "") + "\n\nContext:\n") + " + " + lines.map(tmplToJs).join(' + "\\n" + ')
  );
}

/**
 * Emit the contract prologue for a phase: load+destructure required inputs (blocked
 * return when missing), worktree prepare/finalize, slug derivation, dir + materialize.
 * Emits nothing for a phase that declares no require/worktree/outputs.
 */
function emitContractPrologue(ph: PhaseDef, flowName: string, body: string[]): void {
  const req = requiredNames(ph);
  if (req.length) {
    body.push(
      `const _req = await sf_flow_checkpoint({ mode: "load-required", dir: \`ai_plan/\${args.slug}\`, require: ${JSON.stringify(req)} });`,
    );
    body.push(
      `if (_req.details?.status === "blocked") { log("⚠ BLOCKED at ${ph.id}: missing " + JSON.stringify(_req.details?.missing)); ${blockedReturn(flowName, ph.id)} }`,
    );
    for (const n of req) body.push(`const ${n} = _req.details?.values?.${n};`);
  }
  if (ph.worktree === "prepare") {
    body.push(`const _wt = (await sf_flow_prepare({ slug: args.slug })).details;`);
  }
  if (ph.worktree === "finalize") {
    body.push(
      `const _wtReq = await sf_flow_checkpoint({ mode: "load-required", dir: \`ai_plan/\${args.slug}\`, require: ["worktreePath"] });`,
    );
    body.push(
      `if (_wtReq.details?.status === "blocked") { log("⚠ BLOCKED at ${ph.id}: worktreePath not published (was worktree:prepare skipped?)"); ${blockedReturn(flowName, ph.id)} }`,
    );
    body.push(`await sf_flow_finalize({ worktree_path: _wtReq.details?.values?.worktreePath });`);
  }
  if (ph.outputs?.slug) {
    // Site 2: reuse the AI-supplied run slug (args.slug) instead of re-deriving a
    // deterministic slug from args.input. ONE slug feeds the run folder, plan files,
    // prompt.md, and the flow/<slug> branch. sf_flow_auto already sanitized it; the
    // orchestrator binds args at runtime (messages.ts:196 + sf-flow-auto SKILL Phase 3).
    // Today only the plan phase declares outputs.slug; the guard is general so any
    // future phase that declares a slug also reuses the run slug (single-slug invariant).
    body.push(`const slug = args.slug;`);
  }
  if (ph.outputs?.dir) {
    body.push(`const _dir = ${tmplToJs(ph.outputs.dir)};`);
    if (ph.outputs.artifacts?.length) {
      body.push(
        `await sf_flow_contract({ mode: "materialize", dir: _dir, artifacts: ${JSON.stringify(ph.outputs.artifacts)} });`,
      );
    }
  }
}

/**
 * Emit the contract epilogue: assert declared artifacts (blocked return on failure),
 * then ONE atomic complete() (publish + mark success + persist) with the state dir.
 * The publish set is the declared publish (or the phase out) plus, for
 * worktree:prepare, the worktree handle (so finalize can recover it on resume).
 */
function emitContractEpilogue(ph: PhaseDef, flowName: string, body: string[], producedOutConst: boolean): void {
  if (ph.outputs?.assert?.length && ph.outputs?.dir) {
    // Pass the DECLARED artifact files so `nonempty` checks the specific declared
    // artifacts (a deleted declared file is flagged missing, not silently dropped
    // from the dir enumeration).
    const assertFiles = JSON.stringify((ph.outputs?.artifacts ?? []).map((a) => a.file));
    body.push(
      `const _assertRes = await sf_flow_contract({ mode: "assert", dir: _dir, assert: ${JSON.stringify(ph.outputs.assert)}, files: ${assertFiles} });`,
    );
    body.push(
      `if (_assertRes.details?.status === "blocked") { log("⚠ BLOCKED at ${ph.id}: " + _assertRes.details?.detail); ${blockedReturn(flowName, ph.id)} }`,
    );
  }
  // Only an agent-dispatch phase (agent/fanout/gate with out) actually emits a
  // `const <out> = await …`, so only those can safely auto-publish the out.
  // questions/skill phases emit a directive (no const), so they publish ONLY
  // what they declare explicitly.
  const declared = ph.outputs?.publish ?? (producedOutConst && ph.out ? { [ph.out]: ph.out } : {});
  const fieldParts: string[] = Object.entries(declared).map(
    ([k, v]) => `${k}: ${publishValueToJs(v)}`,
  );
  if (ph.worktree === "prepare") {
    fieldParts.push("worktreePath: _wt?.worktreePath", "branchName: _wt?.branchName", "baseSha: _wt?.baseSha");
  }
  const outputsLit = fieldParts.length ? `{ ${fieldParts.join(", ")} }` : "{}";
  body.push(
    `await sf_flow_checkpoint({ mode: "complete", dir: \`ai_plan/\${args.slug}\`, phase: ${JSON.stringify(ph.id)}, outputs: ${outputsLit}, artifacts: ${JSON.stringify((ph.outputs?.artifacts ?? []).map((a) => a.file))} });`,
  );
}

/**
 * Emit a canonical-delta group-loop (spec §13, D12/D13): the gate agent's
 * findings are numbered [F1..Fn] and carried across rounds; round >=2 runs in
 * verification mode and the loop AND-gates via sf_flow_gate (which wraps
 * assignFindingIds/evolveCanonical/verificationApproved). Fix phases receive the
 * canonical list, not the latest raw findings.
 */
function emitCanonicalGroupLoop(
  groupId: string,
  group: { phases: string[] },
  flow: FlowYaml,
  models: ResolvedModels | null,
): string[] {
  const loop = flow.loops?.[groupId];
  const gatePhaseId = group.phases[0];
  const gatePhase = flow.phases.find((p) => p.id === gatePhaseId)!;
  const gateDef = gatePhase.agent ? flow.agents[gatePhase.agent] : undefined;
  const gateAgentType = resolveAgentType(gatePhase.agent!, Object.keys(flow.agents));
  const gateConfigModel = configModelFor(gatePhase.agent!, models);
  const gateOpts = agentOpts(gatePhase.agent!, gateDef, groupId, gateAgentType, gateConfigModel);
  const gatePromptLit = JSON.stringify(gatePhase.prompt ?? "");
  const maxRounds = loop?.max_rounds ?? 5;
  const failOn = JSON.stringify(loop?.fail_on ?? ["P0", "P1", "P2"]);
  const lines: string[] = [];
  lines.push(`phase(${JSON.stringify(groupId)});`);
  lines.push(`{`);
  lines.push(`  const _maxRounds = ${maxRounds};`);
  lines.push(`  const _failOn = ${failOn};`);
  lines.push(`  let _canonical = [];`); // Finding[] carried across rounds
  lines.push(`  let _rendered = "";`);
  lines.push(`  for (let _round = 1; _round <= _maxRounds; _round++) {`);
  lines.push(
    `    log("Canonical-delta group " + ${JSON.stringify(groupId)} + " round " + _round + "/" + _maxRounds + " (gate: " + ${JSON.stringify(gatePhaseId)} + "). Round 1: fresh review. Round >=2: verify each [Fn], fix phases address the canonical list.");`,
  );
  // round 1: bare gate prompt; round >=2: append the prior canonical list to verify
  lines.push(
    `    const _gate = await agent(${gatePromptLit} + (_round > 1 ? "\\n\\nPrior canonical findings (verify each [Fn] as FIXED/PARTIALLY-FIXED/NOT-FIXED/NEW-ISSUE-INTRODUCED):\\n" + _rendered : ""), ${gateOpts});`,
  );
  lines.push(`    const _findings = (_gate?.findings ?? []);`);
  lines.push(`    const _verification = (_gate?.verification ?? []);`);
  lines.push(
    `    const _cr = await sf_flow_gate({ mode: "canonical-round", round: _round, prior: _canonical, verification: _verification, newFindings: _findings });`,
  );
  lines.push(`    _canonical = (_cr.details?.canonical ?? []);`);
  lines.push(`    _rendered = (_cr.details?.rendered ?? "");`);
  // round 1 approval = fail-closed verdict; round >=2 approval = verificationApproved
  lines.push(
    `    const _ok = (_round === 1) ? _gateApproved(_gate, _failOn).ok : (_cr.details?.approved === true);`,
  );
  lines.push(`    if (_ok) { log("APPROVED — canonical group " + ${JSON.stringify(groupId)}); break; }`);
  lines.push(`    if (_round === _maxRounds) {`);
  lines.push(
    `      log("⚠ NON-CONVERGENT: canonical group " + ${JSON.stringify(groupId)} + " did not converge after " + _maxRounds + " rounds; canonical findings: ");`,
  );
  lines.push(`      log(_rendered || JSON.stringify(_canonical));`);
  lines.push(
    `      await sf_flow_checkpoint({ mode: "write", dir: \`ai_plan/\${args.slug}\`, phase: ${JSON.stringify(groupId)}, status: "blocked" });`,
  );
  lines.push(`      ${blockedReturn(flow.name, gatePhaseId)}`);
  lines.push(`    }`);
  for (let i = 1; i < group.phases.length; i++) {
    const fixPhase = flow.phases.find((p) => p.id === group.phases[i])!;
    const fixDef = fixPhase.agent ? flow.agents[fixPhase.agent] : undefined;
    const fixAgentType = resolveAgentType(fixPhase.agent!, Object.keys(flow.agents));
    const fixConfigModel = configModelFor(fixPhase.agent!, models);
    const fixOpts = agentOpts(fixPhase.agent!, fixDef, groupId, fixAgentType, fixConfigModel);
    const fixPromptLit = JSON.stringify(fixPhase.prompt ?? "");
    lines.push(
      `    await agent(${fixPromptLit} + "\\n\\nCanonical findings to address:\\n" + _rendered, ${fixOpts});`,
    );
  }
  lines.push(`  }`);
  lines.push(
    `  await sf_flow_checkpoint({ mode: "complete", dir: \`ai_plan/\${args.slug}\`, phase: ${JSON.stringify(groupId)}, outputs: {}, artifacts: [] });`,
  );
  lines.push(`}`);
  return lines;
}

/**
 * Emit a block-scoped group-loop: gate agent -> fail-closed gate -> fix phases with
 * findings appended -> re-verify -> until APPROVED / max_rounds.
 * F1/D4 invariant: null/crashed/malformed gate or REVISE-without-findings must NOT
 * be treated as approval (routed through the shared _gateApproved helper).
 */
function emitGroupLoop(
  groupId: string,
  group: { phases: string[] },
  flow: FlowYaml,
  models: ResolvedModels | null,
): string[] {
  const loop = flow.loops?.[groupId];
  if (loop?.protocol === "canonical-delta") {
    return emitCanonicalGroupLoop(groupId, group, flow, models);
  }
  const gatePhaseId = group.phases[0];
  const gatePhase = flow.phases.find((p) => p.id === gatePhaseId)!;
  const gateDef = gatePhase.agent ? flow.agents[gatePhase.agent] : undefined;
  const gateAgentType = resolveAgentType(gatePhase.agent!, Object.keys(flow.agents));
  const gateConfigModel = configModelFor(gatePhase.agent!, models);
  const gateOpts = agentOpts(gatePhase.agent!, gateDef, groupId, gateAgentType, gateConfigModel);
  const gatePromptLit = JSON.stringify(gatePhase.prompt ?? "");
  const maxRounds = loop?.max_rounds ?? 5;
  const failOn = JSON.stringify(loop?.fail_on ?? ["P0", "P1", "P2"]);
  const lines: string[] = [];
  lines.push(`phase(${JSON.stringify(groupId)});`);
  lines.push(`{`);
  lines.push(`  const _maxRounds = ${maxRounds};`);
  lines.push(`  const _failOn = ${failOn};`);
  lines.push(`  for (let _round = 1; _round <= _maxRounds; _round++) {`);
  lines.push(
    `    log("Group loop " + ${JSON.stringify(groupId)} + " round " + _round + "/" + _maxRounds + " (gate: " + ${JSON.stringify(gatePhaseId)} + "). Dispatch the gate agent; on REVISE with blocking findings, dispatch fix phases with the canonical findings appended.");`,
  );
  lines.push(`    const _gate = await agent(${gatePromptLit}, ${gateOpts});`);
  lines.push(`    const _findings = (_gate?.findings ?? []);`);
  lines.push(`    const _blocking = _findings.filter((f) => _failOn.includes(f.severity));`);
  lines.push(
    `    const _ga = _gateApproved(_gate, _failOn); if (_ga.ok) { log("APPROVED — group " + ${JSON.stringify(groupId)}); break; }`,
  );
  lines.push(`    if (_round === _maxRounds) {`);
  lines.push(
    `      log("⚠ NON-CONVERGENT: group " + ${JSON.stringify(groupId)} + " did not converge after " + _maxRounds + " rounds; findings: ");`,
  );
  lines.push(`      log(JSON.stringify(_findings));`);
  lines.push(
    `      await sf_flow_checkpoint({ mode: "write", dir: \`ai_plan/\${args.slug}\`, phase: ${JSON.stringify(groupId)}, status: "blocked" });`,
  );
  lines.push(`      ${blockedReturn(flow.name, gatePhaseId)}`);
  lines.push(`    }`);
  lines.push(`    const _findingsJson = JSON.stringify(_findings);`);
  for (let i = 1; i < group.phases.length; i++) {
    const fixPhase = flow.phases.find((p) => p.id === group.phases[i])!;
    const fixDef = fixPhase.agent ? flow.agents[fixPhase.agent] : undefined;
    const fixAgentType = resolveAgentType(fixPhase.agent!, Object.keys(flow.agents));
    const fixConfigModel = configModelFor(fixPhase.agent!, models);
    const fixOpts = agentOpts(fixPhase.agent!, fixDef, groupId, fixAgentType, fixConfigModel);
    const fixPromptLit = JSON.stringify(fixPhase.prompt ?? "");
    lines.push(
      `    await agent(${fixPromptLit} + "\\n\\nCanonical findings to address:\\n" + _findingsJson, ${fixOpts});`,
    );
  }
  lines.push(`  }`);
  // Group converged (APPROVED): record the group as a checkpoint entity so resume
  // (firstIncomplete) treats the whole group as success and does not skip past it.
  lines.push(
    `  await sf_flow_checkpoint({ mode: "complete", dir: \`ai_plan/\${args.slug}\`, phase: ${JSON.stringify(groupId)}, outputs: {}, artifacts: [] });`,
  );
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

  // Emit the shared fail-closed gate helper once, iff the workflow has any gate
  // (a group loop or a single-phase until:approved — both are loops with
  // until:"approved"). Kept identical to gate.ts so group + single-phase agree.
  const hasGate = !!flow.loops && Object.values(flow.loops).some((l) => l.until === "approved");
  if (hasGate) {
    body.push(
      `function _gateApproved(_r,_failOn){if(!_r||typeof _r.verdict!=="string")return{ok:false,reason:"malformed-gate"};const b=(_r.findings||[]).filter(f=>_failOn.includes(f.severity));if(_r.verdict==="APPROVED")return b.length?{ok:false,reason:"approved-with-blocking"}:{ok:true,reason:"approved"};return{ok:false,reason:b.length?"blocking-findings":"non-approved"};}`,
    );
  }
  body.push(`// Runtime context: args = { input: <workflow input>, flow: ${JSON.stringify(flow.name)}, slug: <derived> }`);

  for (const ph of flow.phases) {
    // Grouped-phase skip: emit the group loop once, skip individual phases
    if (phaseToGroup.has(ph.id)) {
      const groupId = phaseToGroup.get(ph.id)!;
      if (!emittedGroups.has(groupId)) {
        emittedGroups.add(groupId);
        body.push(...emitGroupLoop(groupId, flow.groups![groupId], flow, genOpts.models ?? null));
      }
      continue;
    }
    body.push(`phase(${JSON.stringify(ph.id)});`);
    const loop = flow.loops?.[ph.id];

    // Raw phases are opaque user JS — emitted verbatim with no contract envelope.
    if (ph.raw) {
      body.push(ph.raw);
      continue;
    }

    // Contract prologue (load-required, worktree, slug, dir, materialize).
    emitContractPrologue(ph, flow.name, body);

    if (ph.questions) {
      const maxRounds = ph.max_rounds ?? 5;
      const qDef = flow.agents[ph.questions];
      const qAgentType = resolveAgentType(ph.questions, Object.keys(flow.agents));
      const qConfigModel = configModelFor(ph.questions, genOpts.models ?? null);
      const qOpts = agentOpts(ph.questions, qDef, ph.id, qAgentType, qConfigModel);
      const esc = (s: string): string => s.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
      const directive =
        "`QUESTIONS PHASE: " + esc(ph.questions) + " (max " + maxRounds + " rounds). " +
        "The orchestrator (YOU) must run a clarifying-questions follow-up loop. " +
        "Dispatch the " + esc(ph.questions) + " agent via the Agent tool (subagent_type: " + esc(qAgentType) + "). " +
        "It returns { questions: string[] }. If NON-EMPTY: present each via AskUserQuestion (one at a time, " +
        "multiple-choice when possible), collect answers, RE-DISPATCH with prior context + questions + answers. " +
        "Repeat until EMPTY or " + maxRounds + " rounds. If unattended (no user): answer with sensible defaults " +
        "and proceed (do not block). args.flow=${args.flow}, args.slug=${args.slug}.`";
      body.push("log(" + directive + ");");
      body.push("// elicitor agent opts: " + qOpts);
    } else if (ph.skill) {
      if (loop) {
        throw new Error(
          `phase ${ph.id}: loops are not supported on skill phases (validate.ts should have rejected this)`,
        );
      }
      const hint = tier1Hint(ph.skill, genOpts.models ?? null);
      const skillPath = skillDocPath(ph.skill);
      const esc = (s: string): string => s.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
      const directive =
        "`INLINE SKILL PHASE: " + esc(ph.skill) + ". " +
        "The orchestrator (YOU) must read and execute the skill file at " + esc(skillPath) + " in full. " +
        "Dispatch role agents directly via the Agent tool (subagent_type per the skill); do NOT write code yourself " +
        "and do NOT spawn a general-purpose subagent for this phase — run it inline. " +
        "Workflow " + esc(flow.name) + ". args.flow=${args.flow}, args.slug=${args.slug}. " + esc(hint) + "`";
      body.push("log(" + directive + ");");
    } else {
      const def = ph.agent ? flow.agents[ph.agent] : undefined;
      if (!ph.agent) throw new Error(`phase ${ph.id} has no resolvable agent`);
      const agentType = resolveAgentType(ph.agent, Object.keys(flow.agents));
      const agentConfigModel = configModelFor(ph.agent, genOpts.models ?? null);
      const opts = agentOpts(ph.agent, def, ph.id, agentType, agentConfigModel);
      const promptLit = JSON.stringify(ph.prompt ?? ""); // fanout keeps the raw {{item}} string-replace
      const promptExpr = agentPromptExpr(ph.prompt ?? "", ph);

      if (ph.fanout) {
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
        // Gate on the agent's verdict via the shared fail-closed _gateApproved.
        const failOn = JSON.stringify(loop.fail_on ?? ["P0", "P1", "P2"]);
        const gateCall = `await gate(async () => agent(${promptExpr}, ${opts}), (r) => { const ga = _gateApproved(r, ${failOn}); return ga.ok ? { ok: true } : { ok: false, feedback: ga.reason + ": " + JSON.stringify(r?.findings ?? []) }; }, { attempts: ${loop.max_rounds ?? 5} })`;
        if (ph.out) {
          body.push(`const ${ph.out} = ${gateCall};`);
        } else {
          body.push(gateCall + ";");
        }
      } else {
        const assign = ph.out ? `const ${ph.out} = ` : "";
        body.push(`${assign}await agent(${promptExpr}, ${opts});`);
      }
    }

    // Contract epilogue (assert + atomic complete with the state dir). Only an
    // agent-dispatch phase with `out` produces a `const <out>` the epilogue can
    // auto-publish; questions/skill phases emit a directive (no such const).
    const producedOutConst = !ph.questions && !ph.skill && !!ph.out;
    emitContractEpilogue(ph, flow.name, body, producedOutConst);
  }

  // Structured terminal result: read the published state (D14). blockedPhase is
  // the first non-success phase id (string) or null when all succeeded.
  body.push(
    `const _final = await sf_flow_checkpoint({ mode: "load-all", dir: \`ai_plan/\${args.slug}\` });`,
  );
  body.push(
    `return { name: ${JSON.stringify(flow.name)}, status: _final.details?.blockedPhase != null ? "blocked" : "success", finalPhase: _final.details?.blockedPhase ?? null, artifacts: _final.details?.artifacts, worktree: _final.details?.worktree, branch: _final.details?.worktree?.branchName, resumeState: { stateFile: _final.details?.stateFile } };`,
  );

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
