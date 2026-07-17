import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { homedir } from "node:os";
import { finalizeWorktree } from "./worktree/finalize.js";
import { createWorktree } from "./worktree/create.js";
import { loadAndResolveDefaults, resolveReviewerModel, resolveExplorerModel } from "./config/load.js";
import { ensureAgentFiles } from "./agents.js";
import { ensureExampleWorkflows } from "./ensure-workflows.js";
import { buildImplementReadyMessage, buildAutoReadyMessage, skillDocPath } from "./messages.js";
import { classifyInput } from "./auto/input.js";

export const FLOW_TOOL_NAMES = [
  "sf_flow_plan",
  "sf_flow_implement",
  "sf_flow_audit",
  "sf_flow_auto",
  "sf_flow_create_workflow",
  "sf_flow_finalize",
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
  // sf_flow_create_workflow — interview -> write .pi/workflows/<name>.yaml -> register /<name>.
  pi.registerTool({
    name: "sf_flow_create_workflow",
    label: "sf_flow_create_workflow",
    description:
      "Create or validate a reusable flow from a declarative agents/phases/loops definition. Interviews the user, writes .pi/workflows/<name>.yaml, and registers /<name>.",
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
      const defaults = await loadAndResolveDefaults(repoRoot);
      const prompt = (params as any).prompt ?? "";
      const reviewerModel = resolveReviewerModel(
        (params as any).reviewer_model ?? extractReviewerModelFromPrompt(prompt),
        defaults,
      );
      const explorerModel = resolveExplorerModel(
        (params as any).explorer_model ?? extractExplorerModelFromPrompt(prompt),
        defaults,
      );
      if (!reviewerModel) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No reviewer model configured. Set via prompt, .pi/sf/flow/config.json, or SF_FLOW_REVIEWER_MODEL.",
            },
          ],
          details: { configured: false },
        };
      }
      const agentWarnings = (await ensureAgentFiles(homedir(), repoRoot)).warnings;
      await ensureExampleWorkflows(repoRoot);
      const warnText = agentWarnings.length
        ? `\n\n⚠️ ${agentWarnings.map((w) => `- ${w}`).join("\n")}`
        : "";
      return {
        content: [
          { type: "text" as const, text: `Reviewer model: ${reviewerModel}\nExplorer model: ${explorerModel ?? "inherits from parent (not configured)"}\nNow read the skill file at ${skillDocPath("sf-flow-plan")}.${warnText}` },
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
      const defaults = await loadAndResolveDefaults(repoRoot);
      const reviewerModel = resolveReviewerModel((params as any).reviewer_model, defaults);
      if (!reviewerModel) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No reviewer model configured. Set via prompt, .pi/sf/flow/config.json, or SF_FLOW_REVIEWER_MODEL.",
            },
          ],
          details: { configured: false },
        };
      }
      const rawPath = String((params as any).path);
      const slug = rawPath.replace(/^[\s\S]*\//, "") || "flow";
      const agentWarnings = (await ensureAgentFiles(homedir(), repoRoot)).warnings;
      await ensureExampleWorkflows(repoRoot);
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
                planPath: `ai_plan/${slug}`,
              }) + warnText,
          },
        ],
        details: { configured: true, reviewerModel, path: rawPath, worktreePath: worktree.worktreePath, branchName: worktree.branchName },
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
        workflow: Type.String({ description: "Flow name (matches .pi/workflows/<name>.yaml)." }),
        input: Type.String({ description: "prompt | path-to-md | prd:<path> | jira STORY-123" }),
      },
      { additionalProperties: false },
    ) as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const workflow = (params as any).workflow as string;
      const input = (params as any).input as string;
      const repoRoot = ctx.cwd ?? process.cwd();
      await ensureAgentFiles(homedir(), repoRoot);
      await ensureExampleWorkflows(repoRoot);
      const classified = classifyInput(input);
      return {
        content: [
          {
            type: "text" as const,
            text: buildAutoReadyMessage({ workflowName: workflow, inputSummary: `${classified.kind}: ${classified.value}` }),
          },
        ],
        details: { workflow, kind: classified.kind, value: classified.value },
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

  // Other tools (plan/implement/audit/auto/create_workflow) registered in later milestones.
}
