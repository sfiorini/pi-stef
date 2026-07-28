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
 * Build a record of SDK custom tools from pi's tool list.
 * Each pi tool becomes a `pi__<name>` entry whose execute() emits
 * pi toolcall events and returns the bridge's pending promise.
 */
export function buildCustomTools(
  tools: PiTool[] | undefined,
  bridge: ToolResultBridge,
  emit: ToolCallEmitter,
): Record<string, SDKCustomTool> {
  if (!tools || tools.length === 0) return {};

  const result: Record<string, SDKCustomTool> = {};

  for (const tool of tools) {
    const { name, description, parameters } = tool.function;
    const prefixedName = `pi__${name}`;

    const sdkTool: SDKCustomTool = {
      description,
      inputSchema: parameters,
      execute(
        args: Record<string, unknown>,
        ctx: { toolCallId?: string },
      ): SDKCustomToolResult | Promise<SDKCustomToolResult> {
        // Canonical id MUST be the SDK delta callId — the same id pi echoes back in
        // the next turn's toolResult, so `resolveFromToolResults` always matches.
        // A synthetic Date.now() id can never be matched, leaving execute() pending
        // forever (hang). If the SDK omits toolCallId, surface an in-band error
        // (guard) instead of parking a deferred that can never resolve.
        const toolCallId = ctx.toolCallId;
        const argsJson = JSON.stringify(args ?? {});
        if (!toolCallId) {
          return {
            content: [
              {
                type: "text",
                text: `Cursor customTool "${name}" invoked without a toolCallId; cannot correlate the result across turns.`,
              },
            ],
            isError: true,
          } satisfies SDKCustomToolResult;
        }

        // Emit pi toolcall_start + toolcall_delta so the stream renders the call
        emit.start(toolCallId, name, argsJson);
        emit.delta(toolCallId, argsJson);

        // Return the bridge's pending promise — resolves when the NEXT turn
        // supplies the tool result via resolveFromToolResults.
        // On rejection (abort/error), catch and return an isError result
        // so the SDK gets a proper result rather than a thrown rejection.
        return bridge.pending(toolCallId, name, argsJson).catch(
          (err: Error): SDKCustomToolResult => ({
            content: [{ type: "text", text: err.message }],
            isError: true,
          }),
        );
      },
    };

    result[prefixedName] = sdkTool;
  }

  return result;
}
