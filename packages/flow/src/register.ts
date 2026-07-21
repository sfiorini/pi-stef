import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { homedir } from "node:os";
import { finalizeWorktree } from "./worktree/finalize.js";
import { createWorktree } from "./worktree/create.js";
import { loadAndResolveDefaults } from "./config/load.js";
import { ensureAgentFiles } from "./agents.js";
import { ensureExampleWorkflows } from "./ensure-workflows.js";
import { buildImplementReadyMessage, buildAutoReadyMessage, skillDocPath } from "./messages.js";
import { classifyInput } from "./auto/input.js";
import { resolveWorkflowPath, globalWorkflowsDir } from "./paths.js";
import { seedAgents, seedWorkflows, renderSeedReport } from "./seed.js";
import { join } from "node:path";

export const FLOW_TOOL_NAMES = [
  "sf_flow_plan",
  "sf_flow_implement",
  "sf_flow_audit",
  "sf_flow_auto",
  "sf_flow_create_workflow",
  "sf_flow_finalize",
  "sf_flow_seed",
] as const;

/** Extract reviewer model from a prompt string (e.g. "use opus as reviewer"). Ported from pair. */
export function extractReviewerModelFromPrompt(prompt: string): string | undefined {
  const patterns = [
    /use\s+([\w/.-]+)\s+as\s+reviewer/i,
    /reviewer[:\s]+([\w/.-]+)/i,
    /review\s+with\s+([\w/.-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

/** Extract explorer model from a prompt string. Ported from pair. */
export function extractExplorerModelFromPrompt(prompt: string): string | undefined {
  const patterns = [
    /use\s+([\w/.-]+)\s+as\s+explorer/i,
    /explorer[:\s]+([\w/.-]+)/i,
    /explore\s+with\s+([\w/.-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

export function registerSfFlow(pi: ExtensionAPI): void {
  // sf_flow_create_workflow — interview -> write .pi/sf/flow/workflows/<name>.yaml -> register /<name>.
  pi.registerTool({
    name: "sf_flow_create_workflow",
    label: "sf_flow_create_workflow",
    description:
      "Create or validate a reusable flow from a declarative agents/phases/loops definition. Interviews the user, writes .pi/sf/flow/workflows/<name>.yaml (project-scoped), and registers /<name>.",
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
      },
      { additionalProperties: false },
    ) as any,
    execute: async () => {
      return {
        content: [{ type: "text" as const, text: `Now read the skill file at ${skillDocPath("sf-flow-create-workflow")}.` }],
        details: { created: false, phase: "wizard" },
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
        explorer_model: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const repoRoot = ctx.cwd ?? process.cwd();
      const prompt = (params as any).prompt ?? "";
      const defaults = await loadAndResolveDefaults(repoRoot, {
        overrides: {
          reviewer: (params as any).reviewer_model ?? extractReviewerModelFromPrompt(prompt),
          explorer: (params as any).explorer_model ?? extractExplorerModelFromPrompt(prompt),
        },
      });
      const reviewerModel = defaults.reviewerModel;
      const explorerModel = defaults.explorerModel;
      const agentWarnings = (await ensureAgentFiles(homedir(), repoRoot)).warnings;
      await ensureExampleWorkflows(homedir());
      const warnText = agentWarnings.length
        ? `\n\n⚠️ ${agentWarnings.map((w) => `- ${w}`).join("\n")}`
        : "";
      return {
        content: [
          { type: "text" as const, text: `Reviewer model: ${reviewerModel ?? "inherits from parent (not configured)"}\nExplorer model: ${explorerModel ?? "inherits from parent (not configured)"}\nNow read the skill file at ${skillDocPath("sf-flow-plan")}.${warnText}` },
        ],
        details: { configured: true, reviewerModel, explorerModel },
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
      return {
        content: [
          {
            type: "text" as const,
            text: buildAutoReadyMessage({
              workflowName: workflow,
              inputSummary: `${classified.kind}: ${classified.value}`,
              resolvedWorkflowPath: resolved,
            }),
          },
        ],
        details: { workflow, kind: classified.kind, value: classified.value, workflowPath: resolved },
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
