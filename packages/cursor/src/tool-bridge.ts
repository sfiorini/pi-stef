import type { ToolResultBridge } from "./tool-result-bridge.js";

/** Mirrors @cursor/sdk SDKCustomTool — kept local so this module stays pure. */
export interface SDKCustomTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    context: { toolCallId?: string },
  ): SDKCustomToolResult | Promise<SDKCustomToolResult>;
}

export type SDKCustomToolResult =
  | string
  | { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface ToolCallEmitter {
  start(id: string, name: string, argsJson: string): void;
  delta(id: string, argsJson: string): void;
}

/** Minimal pi tool shape from context.tools */
interface PiTool {
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Cursor's model-facing built-in tool names that must never be shadowed by a
 * pi custom tool. Provenance: Cursor's leaked agent system prompt + the
 * `ClientSideToolV2` catalog — these are the MODEL-FACING built-in names, NOT
 * the SDK's internal `toolCall.type` literals. `@cursor/sdk` does not enumerate
 * them, so this set is hand-maintained. When a pi tool name matches one of
 * these, the tool is skipped and a warning is logged — the guard degrades
 * false-negative-only (never false-positive).
 */
export const CURSOR_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "run_terminal_cmd",
  "read_file",
  "edit_file",
  "codebase_search",
  "list_dir",
  "grep_search",
  "file_search",
  "delete_file",
  "web_search",
  "reapply",
  "fetch_rules",
  "diff_history",
]);

/**
 * Build a record of SDK custom tools from pi's tool list.
 * Each pi tool becomes an entry keyed by its own name whose execute() emits
 * pi toolcall events and returns the bridge's pending promise. A tool whose
 * name collides with `builtins` (Cursor built-ins by default) is skipped with
 * a warning rather than shadowing it.
 */
export function buildCustomTools(
  tools: PiTool[] | undefined,
  bridge: ToolResultBridge,
  emit: ToolCallEmitter,
  builtins: ReadonlySet<string> = CURSOR_BUILTIN_TOOLS,
): Record<string, SDKCustomTool> {
  if (!tools || tools.length === 0) return {};

  const result: Record<string, SDKCustomTool> = {};

  for (const tool of tools) {
    const { name, description, parameters } = tool.function;

    if (builtins.has(name)) {
      console.warn(
        `[cursor] skipping pi tool "${name}" — name collides with a Cursor built-in; choose a different tool name.`,
      );
      continue;
    }

    const sdkTool: SDKCustomTool = {
      description,
      inputSchema: parameters,
      execute(
        args: Record<string, unknown>,
        ctx: { toolCallId?: string },
      ): Promise<SDKCustomToolResult> {
        const toolCallId = ctx.toolCallId ?? `pi-${name}-${Date.now()}`;
        const argsJson = JSON.stringify(args ?? {});

        // Emit pi toolcall_start + toolcall_delta so the stream renders the call
        emit.start(toolCallId, name, argsJson);
        emit.delta(toolCallId, argsJson);

        // Return the bridge's pending promise — resolves when the NEXT turn
        // supplies the tool result via resolveFromToolResults.
        // On rejection (abort/error), catch and return an isError result
        // so the SDK gets a proper result rather than a thrown rejection.
        return bridge
          .pending(toolCallId, name, argsJson)
          .catch(
            (err: Error): SDKCustomToolResult => ({
              content: [{ type: "text", text: err.message }],
              isError: true,
            }),
          );
      },
    };

    result[name] = sdkTool;
  }

  return result;
}
