import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { homedir } from "node:os";
import { finalizeWorktree } from "./worktree/finalize.js";
import { createWorktree } from "./worktree/create.js";
import { loadAndResolveDefaults } from "./config/load.js";
import type { ResolvedModels } from "./config/schema.js";
import { loadFlowYaml } from "./yaml/load.js";
import { generateScript } from "./yaml/generate.js";
import { registerGeneratedFlow } from "./yaml/register.js";
import { writeFlowYamlAsync } from "./yaml/write.js";
import { validateFlowYaml, validateSection, type FlowSection } from "./yaml/validate.js";
import type { FlowYaml } from "./yaml/schema.js";
import { ensureAgentFiles } from "./agents.js";
import { ensureExampleWorkflows } from "./ensure-workflows.js";
import { buildImplementReadyMessage, buildAutoReadyMessage, summarizePhaseModels, skillDocPath } from "./messages.js";
import { classifyInput, slugSourceFor } from "./auto/input.js";
import { resolveWorkflowPath, globalWorkflowsDir, projectWorkflowsDir } from "./paths.js";
import { deriveSlug, materializeArtifacts, assertArtifacts, writeRunPrompt } from "./contract/ops.js";
import { WorkflowState, statePath, prepareRunState } from "./workflow/state.js";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  assignFindingIds,
  evolveCanonical,
  verificationApproved,
  renderCanonicalList,
  type VerificationEntry,
  type NumberedFinding,
} from "./audit/verification.js";
import type { Finding } from "./audit/verdict.js";
import { seedAgents, seedWorkflows, renderSeedReport } from "./seed.js";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { existsSync } from "node:fs";

export const FLOW_TOOL_NAMES = [
  "sf_flow_plan",
  "sf_flow_implement",
  "sf_flow_audit",
  "sf_flow_auto",
  "sf_flow_create_workflow",
  "sf_flow_finalize",
  "sf_flow_seed",
] as const;

const MODEL_ALIASES = new Set([
  "sonnet", "haiku", "opus", "mini", "flash", "pro", "nano", "air", "turbo",
  "claude", "gpt", "gemini", "llama", "mistral", "deepseek", "grok",
]);
/**
 * A token looks like a plausible model name/alias if it is a known alias OR
 * contains a digit / version punctuation (`.`, `/`, `-`). Rejects short/common
 * English words that regex capture groups can mis-extract (e.g. "and", "or").
 */
export function isValidModelToken(token: string | undefined): token is string {
  if (!token || token.length < 2) return false;
  if (MODEL_ALIASES.has(token.toLowerCase())) return true;
  return /[\d/.-]/.test(token);
}

/** Extract reviewer model from a prompt string (e.g. "use opus as reviewer"). Ported from pair. */
export function extractReviewerModelFromPrompt(prompt: string): string | undefined {
  const patterns = [
    /use\s+([\w/.-]+)\s+as\s+reviewer/i,
    /reviewer[:\s]+([\w/.-]+)/i,
    /review\s+with\s+([\w/.-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match && isValidModelToken(match[1])) return match[1];
  }
  return undefined;
}

/** Extract researcher model from a prompt string (e.g. "use sonnet as researcher"). */
export function extractResearcherModelFromPrompt(prompt: string): string | undefined {
  const patterns = [
    /use\s+([\w/.-]+)\s+as\s+researcher/i,
    /researcher[:\s]+([\w/.-]+)/i,
    /research\s+with\s+([\w/.-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match && isValidModelToken(match[1])) return match[1];
  }
  return undefined;
}


/** Extract designer model from a prompt string (e.g. "use opus as designer"). */
export function extractDesignerModelFromPrompt(prompt: string): string | undefined {
  const patterns = [
    /use\s+([\w/.-]+)\s+as\s+designer/i,
    /designer[:\s]+([\w/.-]+)/i,
    /design\s+with\s+([\w/.-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match && isValidModelToken(match[1])) return match[1];
  }
  return undefined;
}

export function registerSfFlow(pi: ExtensionAPI): void {
  // sf_flow_create_workflow — interview -> write .pi/sf/flow/workflows/<name>.yaml -> register /<name>.
  pi.registerTool({
    name: "sf_flow_create_workflow",
    label: "sf_flow_create_workflow",
    description:
      "Adaptive wizard: consults local bundled examples, suggests building blocks, validates (full or per-section), writes + registers the flow.",
    parameters: Type.Object(
      {
        name: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        input: Type.Optional(
          Type.Union([
            Type.Literal("prompt"),
            Type.Literal("md-file"),
            Type.Literal("prd"),
            Type.Literal("jira"),
          ]),
        ),
        agents_yaml: Type.Optional(Type.String({ description: "Pre-formed agents YAML to skip the interview." })),
        phases_yaml: Type.Optional(Type.String()),
        loops_yaml: Type.Optional(Type.String()),
        groups_yaml: Type.Optional(Type.String()),
        overwrite: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const p = (params ?? {}) as {
        name?: string;
        description?: string;
        input?: string;
        agents_yaml?: string;
        phases_yaml?: string;
        loops_yaml?: string;
        groups_yaml?: string;
        overwrite?: boolean;
      };
      const repoRoot = ctx?.cwd ?? process.cwd();

      // Path C: no params → wizard
      const yamlKeys = ["agents_yaml", "phases_yaml", "loops_yaml", "groups_yaml"] as const;
      const hasAnyParam = p.name || p.description || p.input || yamlKeys.some((k) => p[k]);
      if (!hasAnyParam) {
        return {
          content: [{ type: "text" as const, text: `Now read the skill file at ${skillDocPath("sf-flow-create-workflow")}.` }],
          details: { created: false, phase: "wizard" },
        };
      }

      // Parse YAML sections
      const parsed: Record<string, unknown> = {};
      for (const key of yamlKeys) {
        const raw = p[key];
        if (!raw) continue;
        try {
          parsed[key.replace("_yaml", "")] = parseYaml(raw);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [],
            details: { phase: "parse-error", section: key.replace("_yaml", ""), error: msg },
          };
        }
      }

      // Path A: complete flow (name + description + input + agents + phases)
      if (p.name && p.description && p.input && parsed.agents && parsed.phases) {
        const flow: FlowYaml = {
          name: p.name,
          description: p.description,
          input: p.input as FlowYaml["input"],
          agents: parsed.agents as FlowYaml["agents"],
          phases: parsed.phases as FlowYaml["phases"],
          ...(parsed.loops ? { loops: parsed.loops as FlowYaml["loops"] } : {}),
          ...(parsed.groups ? { groups: parsed.groups as FlowYaml["groups"] } : {}),
        };

        // Validate
        const result = validateFlowYaml(flow);
        if (!result.ok) {
          return { content: [], details: { phase: "validation-error", errors: result.errors } };
        }

        // Collision check
        const projectPath = join(projectWorkflowsDir(repoRoot), `${p.name}.yaml`);
        const globalPath = join(globalWorkflowsDir(homedir()), `${p.name}.yaml`);
        if ((existsSync(projectPath) || existsSync(globalPath)) && !p.overwrite) {
          return { content: [], details: { phase: "collision", name: p.name } };
        }

        // Write + register
        let writtenPath: string;
        try {
          writtenPath = await writeFlowYamlAsync(projectWorkflowsDir(repoRoot), flow);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [], details: { phase: "write-error", error: msg } };
        }
        try {
          registerGeneratedFlow(pi, flow);
          return { content: [], details: { phase: "done", writtenPath, name: p.name, created: true } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [], details: { phase: "register-error", writtenPath, name: p.name, error: msg } };
        }
      }

      // Path B: partial — validate each present section
      const requiredKeys = ["name", "description", "input"] as const;
      const requiredYamlSections = ["agents", "phases"] as const;  // loops/groups are optional
      const missing: string[] = requiredKeys.filter((k) => !p[k]);
      for (const section of requiredYamlSections) {
        if (!parsed[section]) {
          missing.push(section);
        }
      }

      const allErrors: string[] = [];
      const validSections: string[] = [];
      for (const [section, value] of Object.entries(parsed)) {
        const vr = validateSection(section as FlowSection, value);
        if (!vr.ok) {
          allErrors.push(...vr.errors);
        } else {
          validSections.push(section);
        }
      }

      if (allErrors.length > 0) {
        return { content: [], details: { phase: "validation-error", errors: allErrors } };
      }

      return {
        content: [],
        details: { phase: "partial-valid", validSections, missing },
      };
    },
  });

  // sf_flow_audit — CodeRabbit-style audit triad (codereview + auditcode + requestreview + respondreview).
  pi.registerTool({
    name: "sf_flow_audit",
    label: "sf_flow_audit",
    description:
      "CodeRabbit-style audit of a diff or codebase. Runs the triad: pi-dw /code-review (7 angles) + audit-code self-checklist (--gate) + request-review dual-blind AND-gate (94%, MAX 5) + respond-review fix-apply. Returns P0-P3 + verdict.",
    parameters: Type.Object(
      {
        target: Type.Optional(
          Type.String({
            description: "Diff target: a git ref range, file path, or 'workdir'. Defaults to staged+unstaged diff.",
          }),
        ),
        reviewer_model: Type.Optional(Type.String()),
        apply_fixes: Type.Optional(
          Type.Boolean({ description: "If true, run respond-review to apply must-fix/should-fix." }),
        ),
      },
      { additionalProperties: false },
    ) as any,
    execute: async () => {
      return {
        content: [{ type: "text" as const, text: `Now read the skill file at ${skillDocPath("sf-flow-audit")}.` }],
        details: { started: true },
      };
    },
  });

  // sf_flow_plan — multi-milestone plan with parallel research + iterative review.
  pi.registerTool({
    name: "sf_flow_plan",
    label: "sf_flow_plan",
    description:
      "Create a multi-milestone implementation plan with pi-dynamic-workflows parallel research and iterative reviewer approval. Produces ai_plan/<slug>/.",
    parameters: Type.Object(
      {
        prompt: Type.Optional(Type.String()),
        reviewer_model: Type.Optional(Type.String()),
        researcher_model: Type.Optional(Type.String()),
        designer_model: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const repoRoot = ctx.cwd ?? process.cwd();
      const prompt = (params as any).prompt ?? "";
      const defaults = await loadAndResolveDefaults(repoRoot, {
        overrides: {
          reviewer: (params as any).reviewer_model ?? extractReviewerModelFromPrompt(prompt),
          researcher: (params as any).researcher_model ?? extractResearcherModelFromPrompt(prompt),
          designer: (params as any).designer_model ?? extractDesignerModelFromPrompt(prompt),
        },
      });
      const reviewerModel = defaults.reviewerModel;
      const researcherModel = defaults.researcherModel;
      const designerModel = defaults.designerModel;
      const agentWarnings = (await ensureAgentFiles(homedir(), repoRoot)).warnings;
      await ensureExampleWorkflows(homedir());
      const warnText = agentWarnings.length
        ? `\n\n⚠️ ${agentWarnings.map((w) => `- ${w}`).join("\n")}`
        : "";
      return {
        content: [
          { type: "text" as const, text: `Reviewer model: ${reviewerModel ?? "inherits from parent (not configured)"}\nResearcher model: ${researcherModel ?? "inherits from parent (not configured)"}\nDesigner model: ${designerModel ?? "inherits from parent (not configured)"}\nNow read the skill file at ${skillDocPath("sf-flow-plan")}.${warnText}` },
        ],
        details: { configured: true, reviewerModel, researcherModel, designerModel },
      };
    },
  });

  // sf_flow_implement — ONE worktree at start (flow/<slug>), TDD per story, audit gate before commit.
  pi.registerTool({
    name: "sf_flow_implement",
    label: "sf_flow_implement",
    description:
      "Execute a plan: ONE worktree at start (flow/<slug>, git-only), TDD per story, audit triad as a non-optional gate before commit.",
    parameters: Type.Object(
      { path: Type.String({ description: "Plan folder slug or path under ai_plan/." }), reviewer_model: Type.Optional(Type.String()) },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const repoRoot = ctx.cwd ?? process.cwd();
      const defaults = await loadAndResolveDefaults(repoRoot, {
        overrides: { reviewer: (params as any).reviewer_model },
      });
      const reviewerModel = defaults.reviewerModel;
      const rawPath = String((params as any).path);
      const slug = rawPath.replace(/^[\s\S]*\//, "") || "flow";
      const agentWarnings = (await ensureAgentFiles(homedir(), repoRoot)).warnings;
      await ensureExampleWorkflows(homedir());
      const warnText = agentWarnings.length
        ? `\n\n⚠️ ${agentWarnings.map((w) => `- ${w}`).join("\n")}`
        : "";
      let worktree: { worktreePath: string; branchName: string; baseSha: string };
      try {
        worktree = await createWorktree({ slug, branchPrefix: defaults.worktree.branch_prefix });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to create worktree: ${msg}` }],
          details: { configured: true, reviewerModel, path: rawPath },
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              buildImplementReadyMessage({
                slug,
                worktreePath: worktree.worktreePath,
                reviewerModel,
                developerModel: defaults.developerModel,
                planPath: `ai_plan/${slug}`,
              }) + warnText,
          },
        ],
        details: { configured: true, reviewerModel, developerModel: defaults.developerModel, path: rawPath, worktreePath: worktree.worktreePath, branchName: worktree.branchName },
      };
    },
  });

  // sf_flow_auto — run a defined flow end-to-end, no human gates.
  pi.registerTool({
    name: "sf_flow_auto",
    label: "sf_flow_auto",
    description:
      "Run a defined flow end-to-end with no human gates. Usage: sf_flow_auto <workflow-name> <prompt | md-file | PRD | jira STORY>. Loads the flow's generated script and executes all phases to a terminal state.",
    parameters: Type.Object(
      {
        workflow: Type.String({ description: "Flow name (resolved project→global: .pi/sf/flow/workflows/<name>.yaml overrides ~/.pi/sf/flow/workflows/<name>.yaml)." }),
        input: Type.String({ description: "prompt | path-to-md | prd:<path> | jira STORY-123" }),
      },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const workflow = (params as any).workflow as string;
      const input = (params as any).input as string;
      const repoRoot = ctx.cwd ?? process.cwd();
      await ensureAgentFiles(homedir(), repoRoot);
      await ensureExampleWorkflows(homedir());
      const classified = classifyInput(input);
      const resolved = await resolveWorkflowPath(workflow, repoRoot, homedir());
      if (!resolved) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Workflow "${workflow}" was not found in the project (<repo>/.pi/sf/flow/workflows) or global (~/.pi/sf/flow/workflows) workflows dir. Create it via /sf-flow-create-workflow, or run /sf-flow-seed to copy the bundled examples.`,
            },
          ],
          details: { workflow, found: false },
        };
      }
      // Load + validate the YAML, resolve models, and pre-generate the pi-dw
      // script so the orchestrator runs skill phases INLINE (one orchestrator,
      // no nested general-purpose twin).
      let script: string | null = null;
      let models: ResolvedModels | null = null;
      let phaseModels: ReturnType<typeof summarizePhaseModels> = [];
      let hasConditionalGates = false;
      let slug = "";
      let stateFile: string | null = null;
      let promptPath: string | null = null;
      try {
        const flow = await loadFlowYaml(resolved);
        const defaults = await loadAndResolveDefaults(repoRoot, { homeDir: homedir() });
        script = generateScript(flow, { models: defaults });
        models = defaults;
        phaseModels = summarizePhaseModels(flow, defaults);
        hasConditionalGates = flow.phases.some((p) => !!p.questions);

        // Derive the run-level slug ONCE (args.slug) from a SHORT per-kind source
        // (basename for files, key for jira, text for prompt) — never the raw
        // path. This single slug drives BOTH the ai_plan/<slug>/ folder and (via
        // sf_flow_prepare) the flow/<slug> worktree branch. Pre-seed the initial
        // .flow-state.json with the FULL non-grouped phase list (all pending) so
        // firstIncomplete()/resume reflect workflow order; resume keeps a matching
        // state (same workflow+input hashes).
        slug = deriveSlug(slugSourceFor(classified), { prefix: "date" });
        const stateDir = join(repoRoot, "ai_plan", slug);
        const sha = (s: string) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 16);
        const workflowHash = sha(`${flow.name}|${flow.phases.map((p) => p.id).join(",")}`);
        const inputHash = sha(classified.value);
        // Checkpoint entities in workflow order: non-grouped phases plus one
        // entry per group (positioned at the group's first phase). The group loop
        // records the group's outcome (success on approval, blocked on
        // non-convergence), so firstIncomplete()/resume account for the group as
        // a unit and never skip past a blocked group.
        const groupStart = new Map<string, string>();
        if (flow.groups) for (const [gid, g] of Object.entries(flow.groups)) groupStart.set(g.phases[0], gid);
        const grouped = new Set<string>();
        if (flow.groups) for (const g of Object.values(flow.groups)) for (const id of g.phases) grouped.add(id);
        const phaseIds: string[] = [];
        for (const p of flow.phases) {
          if (groupStart.has(p.id)) phaseIds.push(groupStart.get(p.id)!);
          else if (!grouped.has(p.id)) phaseIds.push(p.id);
        }
        // Pre-seed the run checkpoint: resume if a matching state exists, else
        // write a fresh all-pending state (overwriting any stale one).
        stateFile = prepareRunState(stateDir, {
          workflowName: workflow,
          workflowHash,
          inputHash,
          slug,
          phaseIds,
        }).stateFile;
        // Capture the original input INSIDE the slug folder (ai_plan/<slug>/prompt.md)
        // so it never lands in the repo root. The orchestrator reads it from here.
        promptPath = writeRunPrompt(stateDir, classified.value);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Workflow "${workflow}" could not be loaded: ${msg}`,
            },
          ],
          details: { workflow, found: true, workflowPath: resolved, loadError: msg },
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: buildAutoReadyMessage({
              workflowName: workflow,
              inputSummary: `${classified.kind}: ${classified.value}`,
              resolvedWorkflowPath: resolved,
              script,
              models,
              phaseModels,
              hasConditionalGates,
              slug,
            }),
          },
        ],
        details: { workflow, kind: classified.kind, value: classified.value, workflowPath: resolved, script, slug, stateFile, promptPath },
      };
    },
  });

  // sf_flow_finalize — remove worktree dir, preserve branch (ported from pair).
  pi.registerTool({
    name: "sf_flow_finalize",
    label: "sf_flow_finalize",
    description:
      "Remove a flow worktree directory while preserving its branch. Call after sf-flow-implement finishes.",
    parameters: Type.Object(
      {
        worktree_path: Type.String({
          description: "Absolute path to the worktree to remove.",
        }),
      },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const worktreePath = (params as any).worktree_path as string;
      const cwd = ctx.cwd ?? process.cwd();
      try {
        await finalizeWorktree(worktreePath, cwd);
        return {
          content: [
            { type: "text" as const, text: `Removed worktree ${worktreePath}; branch preserved.` },
          ],
          details: { finalized: true, worktreePath },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to finalize worktree: ${msg}` }],
          details: { finalized: false, worktreePath, error: msg },
        };
      }
    },
  });

  // sf_flow_seed — copy default agents + example workflows to their GLOBAL
  // locations, with <name>.new for files the user has changed (never clobbers).
  pi.registerTool({
    name: "sf_flow_seed",
    label: "sf_flow_seed",
    description:
      "Copy flow's default agents and example workflows to their global locations (~/.pi/agent/agents and ~/.pi/sf/flow/workflows). Existing files are left untouched; if a file differs from the bundled default, the new default is written as <name>.new beside it. Idempotent.",
    parameters: Type.Object({}, { additionalProperties: false }) as any,
    execute: async () => {
      const home = homedir();
      const agents = await seedAgents(join(home, ".pi", "agent", "agents"), "with-new");
      const workflows = await seedWorkflows(globalWorkflowsDir(home), "with-new");
      return {
        content: [{ type: "text" as const, text: renderSeedReport({ agents, workflows }) }],
        details: { agents, workflows },
      };
    },
  });

  // sf_flow_contract — phase-contract output enforcement (derive-slug | materialize | assert).
  // Emitted by the tier-2 generator around each declared outputs: contract. Pure logic
  // lives in contract/ops.ts so it is unit-testable without a pi runtime.
  pi.registerTool({
    name: "sf_flow_contract",
    label: "sf_flow_contract",
    description:
      "Phase-contract output enforcement. Modes: derive-slug (kebab slug, optional date prefix), materialize (write resume-safe artifact skeletons), assert (block on missing/empty artifacts).",
    parameters: Type.Object(
      {
        mode: Type.Union([
          Type.Literal("derive-slug"),
          Type.Literal("materialize"),
          Type.Literal("assert"),
        ]),
        source: Type.Optional(Type.String()),
        prefix: Type.Optional(Type.Union([Type.Literal("date"), Type.Literal("none")])),
        dir: Type.Optional(Type.String()),
        artifacts: Type.Optional(
          Type.Array(
            Type.Object({ file: Type.String(), template: Type.Optional(Type.String()) }, { additionalProperties: false }),
          ),
        ),
        assert: Type.Optional(Type.Array(Type.String())),
        files: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: any }> => {
      const p = (params ?? {}) as {
        mode: "derive-slug" | "materialize" | "assert";
        source?: string;
        prefix?: "date" | "none";
        dir?: string;
        artifacts?: { file: string; template?: string }[];
        assert?: string[];
        files?: string[];
      };
      if (p.mode === "derive-slug") {
        const slug = deriveSlug(p.source ?? "", { prefix: p.prefix ?? "date" });
        return { content: [{ type: "text" as const, text: JSON.stringify({ slug }) }], details: { slug } };
      }
      if (p.mode === "materialize") {
        materializeArtifacts(p.dir ?? "", p.artifacts ?? []);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ dir: p.dir, ok: true }) }],
          details: { dir: p.dir, ok: true },
        };
      }
      const r = assertArtifacts(p.dir ?? "", p.assert ?? [], p.files);
      return { content: [{ type: "text" as const, text: JSON.stringify(r) }], details: r };
    },
  });

  // sf_flow_checkpoint — phase sequencing + resume state (.flow-state.json).
  // Modes: complete (atomic publish+mark+persist), publish (write-through), write
  // (mark+persist), load-required (read prior publishes; blocked when missing),
  // load-all (read the terminal view: phaseIndex, blockedPhase, artifacts, worktree).
  // A fresh WorkflowState is constructed over the resolved plan dir per call; the
  // constructor merges existing on-disk state, so once initialized (sf_flow_auto
  // pre-seeds the full phase list at run start) per-phase calls just update it.
  pi.registerTool({
    name: "sf_flow_checkpoint",
    label: "sf_flow_checkpoint",
    description:
      "Phase sequencing + resume state. Modes: complete | publish | write | load-required | load-all. dir is the plan dir (ai_plan/<slug>). load-required returns blocked when a required prior publish is missing (self-defeating dataflow). load-all returns the terminal view for the structured result.",
    parameters: Type.Object(
      {
        mode: Type.Union([
          Type.Literal("complete"),
          Type.Literal("publish"),
          Type.Literal("write"),
          Type.Literal("load-required"),
          Type.Literal("load-all"),
        ]),
        dir: Type.String(),
        phase: Type.Optional(Type.String()),
        outputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        artifacts: Type.Optional(Type.Array(Type.String())),
        status: Type.Optional(Type.String()),
        require: Type.Optional(Type.Array(Type.String())),
        // optional seed (used when initializing / forwarding new phases):
        workflowName: Type.Optional(Type.String()),
        workflowHash: Type.Optional(Type.String()),
        inputHash: Type.Optional(Type.String()),
        slug: Type.Optional(Type.String()),
        phaseIds: Type.Optional(Type.Array(Type.String())),
      },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: any }> => {
      const p = (params ?? {}) as {
        mode: "complete" | "publish" | "write" | "load-required" | "load-all";
        dir: string;
        phase?: string;
        outputs?: Record<string, unknown>;
        artifacts?: string[];
        status?: string;
        require?: string[];
        workflowName?: string;
        workflowHash?: string;
        inputHash?: string;
        slug?: string;
        phaseIds?: string[];
      };
      const dir = p.dir;
      const seed = {
        workflowName: p.workflowName ?? "flow",
        workflowHash: p.workflowHash ?? "",
        inputHash: p.inputHash ?? "",
        slug: p.slug ?? basename(dir),
        phaseIds: p.phaseIds ?? [],
      };

      if (p.mode === "load-required") {
        const st = new WorkflowState(dir, seed);
        const r = st.loadRequired(p.require ?? []);
        return { content: [{ type: "text" as const, text: JSON.stringify(r) }], details: r };
      }
      if (p.mode === "load-all") {
        const st = new WorkflowState(dir, seed);
        const phaseIndex = st.firstIncomplete();
        const blockedPhase = phaseIndex >= 0 ? st.data.phases[phaseIndex].id : null;
        const artifacts = st.data.phases.flatMap((ph) => ph.artifacts);
        const view = {
          phaseIndex,
          blockedPhase,
          artifacts,
          worktree: st.data.worktree ?? null,
          stateFile: statePath(dir),
          workflowHash: st.data.workflowHash,
          inputHash: st.data.inputHash,
          terminalResult: st.data.terminalResult ?? null,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(view) }], details: view };
      }
      // mutating modes construct + persist
      const st = new WorkflowState(dir, seed);
      if (p.mode === "complete") {
        st.complete(p.phase ?? "", p.outputs ?? {}, p.artifacts ?? []);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ phase: p.phase, ok: true }) }],
          details: { phase: p.phase, ok: true },
        };
      }
      if (p.mode === "publish") {
        st.publish(p.phase ?? "", p.outputs ?? {}, p.artifacts ?? []);
        st.write();
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ phase: p.phase, ok: true }) }],
          details: { phase: p.phase, ok: true },
        };
      }
      // write
      st.mark(p.phase ?? "", (p.status as any) ?? "in-progress");
      st.write();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ phase: p.phase, status: p.status }) }],
        details: { phase: p.phase, status: p.status },
      };
    },
  });

  // sf_flow_prepare — create the flow worktree for an implement phase (flow/<slug>).
  // Returns { worktreePath, branchName, baseSha }; the contract epilogue publishes
  // these into .flow-state.json via complete() so the finalize phase (and resume)
  // can recover the handle without an ephemeral JS const.
  pi.registerTool({
    name: "sf_flow_prepare",
    label: "sf_flow_prepare",
    description:
      "Prepare a flow worktree (flow/<slug>) for an implement phase. Returns {worktreePath, branchName, baseSha}. Publish the result via sf_flow_checkpoint so the finalize phase can recover it.",
    parameters: Type.Object({ slug: Type.String() }, { additionalProperties: false }) as any,
    execute: async (_id, params, _signal, _onUpdate, ctx): Promise<{ content: { type: "text"; text: string }[]; details: any }> => {
      const repoRoot = ctx?.cwd ?? process.cwd();
      const defaults = await loadAndResolveDefaults(repoRoot);
      try {
        const w = await createWorktree({
          slug: (params as any).slug,
          branchPrefix: defaults.worktree.branch_prefix,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(w) }], details: w };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Failed to prepare worktree: ${msg}` }],
          details: { error: msg },
        };
      }
    },
  });

  // sf_flow_gate — canonical-delta audit-round helper (spec §13, D12/D13). Wraps
  // the verification engine so a group/single-phase loop with protocol:
  // canonical-delta carries [Fn]-numbered findings across rounds and AND-gates via
  // verification, without emitting the engine logic inline into every script.
  pi.registerTool({
    name: "sf_flow_gate",
    label: "sf_flow_gate",
    description:
      "Canonical-delta audit round transition. mode: canonical-round. Round 1 numbers the fresh findings; round >=2 evolves the canonical list (FIXED dropped, regressions appended) and reports whether verificationApproved. Returns {canonical, rendered, approved}.",
    parameters: Type.Object(
      {
        mode: Type.Literal("canonical-round"),
        round: Type.Integer(),
        prior: Type.Array(
          Type.Object(
            {
              severity: Type.String(),
              file: Type.String(),
              line: Type.Number(),
              summary: Type.String(),
              failure_scenario: Type.String(),
            },
            { additionalProperties: false },
          ),
        ),
        verification: Type.Array(
          Type.Object(
            { ref: Type.String(), status: Type.String(), evidence: Type.String() },
            { additionalProperties: false },
          ),
        ),
        newFindings: Type.Array(
          Type.Object(
            {
              severity: Type.String(),
              file: Type.String(),
              line: Type.Number(),
              summary: Type.String(),
              failure_scenario: Type.String(),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: any }> => {
      const p = (params ?? {}) as {
        round: number;
        prior: Finding[];
        verification: VerificationEntry[];
        newFindings: Finding[];
      };
      const strip = (n: NumberedFinding[]): Finding[] =>
        n.map(({ severity, file, line, summary, failure_scenario }) => ({ severity, file, line, summary, failure_scenario }));
      if (p.round <= 1) {
        const numbered = assignFindingIds(p.newFindings);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ round: 1 }) }],
          details: { canonical: strip(numbered), rendered: renderCanonicalList(numbered), approved: null },
        };
      }
      const priorNumbered = assignFindingIds(p.prior);
      const evolved = evolveCanonical(priorNumbered, p.verification, p.newFindings);
      const numbered = assignFindingIds(evolved);
      const approved = verificationApproved(priorNumbered, p.verification, p.newFindings);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ round: p.round, approved }) }],
        details: { canonical: strip(numbered), rendered: renderCanonicalList(numbered), approved },
      };
    },
  });

  // Register slash commands: route /sf-flow-* to the sf_flow_* tools. The tools do
  // setup (model/worktree/agents) then load the internal skill by path, so the
  // command is the user-facing entry (skills are NOT pi-discovered — pi.skills: []).
  const send = typeof pi.sendUserMessage === "function" ? pi.sendUserMessage.bind(pi) : undefined;

  const slashDescriptions: Record<string, string> = {
    sf_flow_plan: "Multi-milestone plan with parallel research + iterative review. Args: task description",
    sf_flow_implement: "Execute a plan in a worktree with an audit gate. Args: plan folder path or slug",
    sf_flow_audit: "CodeRabbit-style code audit. Args: diff target (ref range, file, or 'workdir')",
    sf_flow_auto: "Run a defined flow end-to-end, no human gates. Args: <workflow> <input>",
    sf_flow_create_workflow: "Create or validate a reusable flow YAML (wizard).",
    sf_flow_finalize: "Remove a flow worktree dir, preserve branch. Args: worktree_path",
    sf_flow_seed: "Copy flow's default agents + example workflows to their global locations.",
  };

  for (const name of FLOW_TOOL_NAMES) {
    const slashName = name.replace(/_/g, "-");
    const desc = slashDescriptions[name] ?? name;

    pi.registerCommand(slashName, {
      description: desc,
      handler: async (args, ctx) => {
        const trimmed = args.trim();
        let message: string;

        if (name === "sf_flow_plan") {
          message = trimmed.length === 0
            ? "Invoke the sf_flow_plan tool. Ask me first what to plan."
            : `Invoke the sf_flow_plan tool with prompt: ${trimmed}`;
        } else if (name === "sf_flow_implement") {
          message = trimmed.length === 0
            ? "Invoke the sf_flow_implement tool. Ask me first for the plan folder path or slug."
            : `Invoke the sf_flow_implement tool with path: ${trimmed}`;
        } else if (name === "sf_flow_audit") {
          message = trimmed.length === 0
            ? "Invoke the sf_flow_audit tool (defaults to the staged+unstaged diff)."
            : `Invoke the sf_flow_audit tool with target: ${trimmed}`;
        } else if (name === "sf_flow_auto") {
          // /sf-flow-auto <workflow> <input>
          const [wf, ...rest] = trimmed.split(/\s+/);
          message = wf
            ? `Invoke the sf_flow_auto tool with workflow="${wf}" and input="${rest.join(" ")}".`
            : "Invoke the sf_flow_auto tool. Ask me first for the workflow name and input.";
        } else if (name === "sf_flow_finalize") {
          message = trimmed.length === 0
            ? "Invoke the sf_flow_finalize tool. Ask me first for the worktree path (or provide it now)."
            : `Invoke the sf_flow_finalize tool with worktree_path: ${trimmed}`;
        } else if (name === "sf_flow_seed") {
          message = "Invoke the sf_flow_seed tool to copy flow's default agents and example workflows to their global locations.";
        } else {
          // sf_flow_create_workflow (wizard — no positional arg)
          message = "Invoke the sf_flow_create_workflow tool.";
        }

        if (!send) {
          ctx.ui?.notify?.(
            `flow: this pi runtime can't post slash-command output to the agent. Type "${slashName} ${trimmed}" instead.`,
            "warning",
          );
          return;
        }

        const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
        if (idle) {
          send(message);
        } else {
          send(message, { deliverAs: "followUp" });
        }
      },
    });
  }
}
