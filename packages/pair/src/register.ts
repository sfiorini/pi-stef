import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAndResolveDefaults,
  resolveReviewerModel,
  resolveExplorerModel,
} from "./config/load";

export const PAIR_TOOL_NAMES = [
  "sf_pair_plan",
  "sf_pair_implement",
  "sf_pair_task",
] as const;

const REVIEWER_AGENT_PATH = ".pi/agents/reviewer.md";

/**
 * Write the reviewer agent file with the resolved model.
 * This ensures pi-subagents spawns the reviewer with the correct model.
 */
async function writeReviewerAgent(
  repoRoot: string,
  model: string
): Promise<void> {
  const agentPath = join(repoRoot, REVIEWER_AGENT_PATH);
  await mkdir(dirname(agentPath), { recursive: true });

  // Read the template file from the package
  const templatePath = join(dirname(fileURLToPath(import.meta.url)), "..", "agents", "reviewer.md");
  const template = await readFile(templatePath, "utf8");

  // Replace the {{REVIEWER_MODEL}} placeholder with the resolved model
  const content = template.replace("{{REVIEWER_MODEL}}", model);

  await writeFile(agentPath, content, "utf8");
}

/**
 * Extract reviewer model from prompt string.
 * Looks for patterns like "use <model> as reviewer" or "reviewer: <model>"
 */
function extractReviewerModelFromPrompt(prompt: string): string | undefined {
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

/**
 * Extract explorer model from prompt string.
 * Looks for patterns like "use <model> as explorer" or "explorer: <model>"
 */
function extractExplorerModelFromPrompt(prompt: string): string | undefined {
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

export function registerSfPair(pi: ExtensionAPI): void {
  // Register plan tool
  const planSchema = Type.Object(
    {
      prompt: Type.Optional(
        Type.String({ description: "The task to plan. May include reviewer/explorer model overrides." })
      ),
      reviewer_model: Type.Optional(
        Type.String({ description: "Override reviewer model (e.g. 'anthropic/sonnet-4-6')" })
      ),
      explorer_model: Type.Optional(
        Type.String({ description: "Override explorer model (e.g. 'anthropic/sonnet-4-6'). Falls back to parent model if not set." })
      ),
    },
    { additionalProperties: false }
  );

  pi.registerTool({
    name: "sf_pair_plan",
    label: "sf_pair_plan",
    description:
      "Create a multi-milestone implementation plan with iterative reviewer approval. Produces a plan folder under ai_plan/.",
    parameters: planSchema as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const repoRoot = ctx.cwd ?? process.cwd();
      const defaults = await loadAndResolveDefaults(repoRoot);
      const prompt = (params as any).prompt ?? "";

      // Resolve reviewer model
      const promptReviewerModel = extractReviewerModelFromPrompt(prompt);
      const reviewerModel = resolveReviewerModel(
        (params as any).reviewer_model ?? promptReviewerModel,
        defaults
      );

      if (!reviewerModel) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No reviewer model configured. Please provide one via:\n1. The prompt (e.g. 'use anthropic/sonnet-4-6 as reviewer')\n2. Config file at .pi/sf/pair/config.json\n3. Environment variable SF_PAIR_REVIEWER_MODEL\n4. Or pass reviewer_model parameter",
            },
          ],
          details: { configured: false },
        };
      }

      // Resolve explorer model (optional, falls back to parent)
      const promptExplorerModel = extractExplorerModelFromPrompt(prompt);
      const explorerModel = resolveExplorerModel(
        (params as any).explorer_model ?? promptExplorerModel,
        defaults
      );

      await writeReviewerAgent(repoRoot, reviewerModel);

      const explorerInfo = explorerModel
        ? `Explorer model: ${explorerModel}`
        : "Explorer model: inherits from parent (not configured)";

      return {
        content: [
          {
            type: "text" as const,
            text: `Reviewer configured with model: ${reviewerModel}\n${explorerInfo}\nAgent file written to ${REVIEWER_AGENT_PATH}\n\nNow load and follow the plan skill.`,
          },
        ],
        details: { configured: true, reviewerModel, explorerModel },
      };
    },
  });

  // Register implement tool
  const implementSchema = Type.Object(
    {
      path: Type.String({
        description:
          "Plan folder path or slug (e.g. '2026-06-17-add-auth' or 'ai_plan/2026-06-17-add-auth')",
      }),
      reviewer_model: Type.Optional(
        Type.String({ description: "Override reviewer model" })
      ),
    },
    { additionalProperties: false }
  );

  pi.registerTool({
    name: "sf_pair_implement",
    label: "sf_pair_implement",
    description:
      "Execute an approved plan milestone-by-milestone in a git worktree. Creates worktree, implements all milestones with reviewer approval, then rolls up commits and deletes worktree.",
    parameters: implementSchema as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const repoRoot = ctx.cwd ?? process.cwd();
      const defaults = await loadAndResolveDefaults(repoRoot);
      const model = resolveReviewerModel((params as any).reviewer_model, defaults);

      if (!model) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No reviewer model configured. Please provide one via:\n1. Config file at .pi/sf/pair/config.json\n2. Environment variable SF_PAIR_REVIEWER_MODEL\n3. Or pass reviewer_model parameter",
            },
          ],
          details: { configured: false },
        };
      }

      await writeReviewerAgent(repoRoot, model);

      return {
        content: [
          {
            type: "text" as const,
            text: `Reviewer configured with model: ${model}\nPlan path: ${(params as any).path}\nAgent file written to ${REVIEWER_AGENT_PATH}\n\nNow load and follow the implement skill.`,
          },
        ],
        details: { configured: true, model, path: (params as any).path },
      };
    },
  });

  // Register task tool
  const taskSchema = Type.Object(
    {
      prompt: Type.String({
        description: "The task to execute end-to-end",
      }),
      reviewer_model: Type.Optional(
        Type.String({ description: "Override reviewer model" })
      ),
    },
    { additionalProperties: false }
  );

  pi.registerTool({
    name: "sf_pair_task",
    label: "sf_pair_task",
    description:
      "Execute a single task end-to-end: plan, review, implement, verify, commit. Uses current branch (no worktree).",
    parameters: taskSchema as any,
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      const repoRoot = ctx.cwd ?? process.cwd();
      const defaults = await loadAndResolveDefaults(repoRoot);
      const promptModel = extractReviewerModelFromPrompt((params as any).prompt);
      const model = resolveReviewerModel(
        (params as any).reviewer_model ?? promptModel,
        defaults
      );

      if (!model) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No reviewer model configured. Please provide one via:\n1. The prompt (e.g. 'use anthropic/sonnet-4-6 as reviewer')\n2. Config file at .pi/sf/pair/config.json\n3. Environment variable SF_PAIR_REVIEWER_MODEL\n4. Or pass reviewer_model parameter",
            },
          ],
          details: { configured: false },
        };
      }

      await writeReviewerAgent(repoRoot, model);

      return {
        content: [
          {
            type: "text" as const,
            text: `Reviewer configured with model: ${model}\nTask: ${(params as any).prompt}\nAgent file written to ${REVIEWER_AGENT_PATH}\n\nNow load and follow the task skill.`,
          },
        ],
        details: { configured: true, model, prompt: (params as any).prompt },
      };
    },
  });

  // Register slash commands
  const send = typeof pi.sendUserMessage === "function" ? pi.sendUserMessage.bind(pi) : undefined;

  const slashDescriptions: Record<string, string> = {
    sf_pair_plan: "Create implementation plan with reviewer loop. Args: task description",
    sf_pair_implement: "Execute plan in worktree with milestone reviews. Args: plan folder path or slug",
    sf_pair_task: "Execute single task end-to-end. Args: task description",
  };

  for (const name of PAIR_TOOL_NAMES) {
    const slashName = name.replace(/_/g, "-");
    const desc = slashDescriptions[name] ?? name;

    pi.registerCommand(slashName, {
      description: desc,
      handler: async (args, ctx) => {
        const trimmed = args.trim();
        let message: string;

        if (name === "sf_pair_plan") {
          message = trimmed.length === 0
            ? "Invoke the sf_pair_plan tool. Ask me first what to plan."
            : `Invoke the sf_pair_plan tool with prompt: ${trimmed}`;
        } else if (name === "sf_pair_implement") {
          message = trimmed.length === 0
            ? "Invoke the sf_pair_implement tool. Ask me first for the plan folder path or slug."
            : `Invoke the sf_pair_implement tool with path: ${trimmed}`;
        } else {
          // sf_pair_task
          message = trimmed.length === 0
            ? "Invoke the sf_pair_task tool. Ask me first what task to execute."
            : `Invoke the sf_pair_task tool with prompt: ${trimmed}`;
        }

        if (!send) {
          ctx.ui?.notify?.(
            `pair: this pi runtime can't post slash-command output to the agent. Type "${slashName} ${trimmed}" instead.`,
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
