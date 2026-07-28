/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ID_PARAM_NAMES = [
  "issueIdOrKey",
  "pageId",
  "linkId",
  "boardId",
  "sprintId",
  "versionId",
  "projectIdOrKey",
  "key",
  "inwardIssueKey",
  "outwardIssueKey",
  "issues",
  "issueKeys",
  "issueIdsOrKeys",
  "attachmentIds",
  "labels",
] as const;

function resolveIdentifier(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const record = params as Record<string, unknown>;
  for (const name of ID_PARAM_NAMES) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value) && value.length > 0) return value.join(", ");
  }
  return undefined;
}

function successMessage(name: string, params: unknown): string {
  const identifier = resolveIdentifier(params);
  return identifier ? `${name} succeeded (${identifier}).` : `${name} succeeded.`;
}

/**
 * Register a simple tool that JSON-serializes the execute result.
 * Used across Jira and Confluence tool registration modules.
 */
export function registerTool(
  pi: ExtensionAPI,
  name: string,
  description: string,
  parameters: unknown,
  execute: (params: any, signal?: AbortSignal) => Promise<unknown>,
  options?: { promptSnippet?: string },
): void {
  pi.registerTool({
    name,
    label: name,
    description,
    promptSnippet: options?.promptSnippet,
    parameters: parameters as never,
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined) {
      const result = await execute(params, signal);
      const text = result === undefined ? successMessage(name, params) : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }], details: result };
    },
  });
}
