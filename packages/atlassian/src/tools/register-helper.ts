import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExecuteFn } from "./types";

/**
 * Register a simple tool that JSON-serializes the execute result.
 * Used across Jira and Confluence tool registration modules.
 */
export function registerTool(
  pi: ExtensionAPI,
  name: string,
  description: string,
  parameters: unknown,
  execute: ExecuteFn,
  options?: { promptSnippet?: string },
): void {
  pi.registerTool({
    name,
    label: name,
    description,
    promptSnippet: options?.promptSnippet,
    parameters: parameters as never,
    async execute(_toolCallId, params, signal) {
      const result = await execute(params as Record<string, unknown>, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
