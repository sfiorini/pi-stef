import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { finalizeWorktree } from "./worktree/finalize.js";

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
        content: [{ type: "text" as const, text: "Now load the skill named sf-flow-create-workflow." }],
        details: { created: false, phase: "wizard" },
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
