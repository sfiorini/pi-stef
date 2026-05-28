import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TaskSchema = Type.Object({
  subagent_type: Type.String({
    description: "Type of subagent to dispatch (e.g., 'general-purpose', 'Explore', 'Plan')",
  }),
  prompt: Type.String({ description: "The task prompt for the subagent" }),
  description: Type.String({ description: "Short 3-5 word summary of the task" }),
  model: Type.Optional(
    Type.String({ description: "Model to use (provider/modelId or fuzzy name)" }),
  ),
  thinking: Type.Optional(
    Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
  ),
  max_turns: Type.Optional(Type.Number({ description: "Maximum agentic turns" })),
  run_in_background: Type.Optional(Type.Boolean({ description: "Run without blocking" })),
  resume: Type.Optional(Type.String({ description: "Agent ID to resume a previous session" })),
  isolated: Type.Optional(Type.Boolean({ description: "No extension/MCP tools" })),
  inherit_context: Type.Optional(
    Type.Boolean({ description: "Fork parent conversation into agent" }),
  ),
});

type TaskInput = Static<typeof TaskSchema>;

export function registerTaskTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "Task",
    label: "Task",
    description:
      "Dispatch a subagent to handle a specific task. Alias for Agent tool from pi-subagents. Requires @tintinweb/pi-subagents.",
    promptSnippet: "Dispatch specialized subagent for isolated task execution",
    promptGuidelines: [
      "Use Task when you need to delegate work to a specialized agent with isolated context.",
      "Task tool requires @tintinweb/pi-subagents extension to be installed.",
    ],
    parameters: TaskSchema,
    async execute(_toolCallId: string, params: TaskInput) {
      const activeTools = pi.getActiveTools();
      const hasAgentTool = activeTools.includes("Agent");

      if (!hasAgentTool) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Task tool requires @tintinweb/pi-subagents extension.\n\nInstall with: pi install npm:@tintinweb/pi-subagents",
            },
          ],
          isError: true,
          details: { availableTools: activeTools },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Task tool is an alias for the Agent tool. Please use the Agent tool directly with the same parameters:\n\nAgent({\n  subagent_type: "${params.subagent_type}",\n  prompt: "${params.prompt}",\n  description: "${params.description}"\n  ...\n})`,
          },
        ],
        details: { availableTools: activeTools },
      };
    },
  });
}
