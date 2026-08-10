/**
 * Tool prompt engineering — inject tool definitions + format into the system prompt
 * so ANY model can use function-calling via prompt-engineering.
 *
 * Works with the `<tool_calls>[{...}]</tool_calls>` XML convention for both
 * prompt injection and result rewriting.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

interface FunctionTool {
  type?: string;
  function?: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

interface AssistantToolCall {
  id?: string;
  type?: string;
  function?: { name: string; arguments: string };
}

interface Message {
  role: string;
  content?: unknown;
  tool_calls?: AssistantToolCall[];
  tool_call_id?: string;
  name?: string;
}

// ── flattenContent ──────────────────────────────────────────────────────────

/**
 * Flatten a message content field to a plain string.
 * content can be string OR [{type:"text",text}].
 * Kept local to avoid circular dependency with chat.ts.
 */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: unknown) => {
        const p = part as Record<string, unknown>;
        return p && p.type === "text" && typeof p.text === "string";
      })
      .map((part: unknown) => (part as { text: string }).text)
      .join("");
  }
  return "";
}

// ── injectToolPrompt ─────────────────────────────────────────────────────────

/**
 * Build the system-prompt block describing available tools + the expected
 * `<tool_calls>` response format.
 *
 * Returns "" when tool_choice is "none" or there are no function tools.
 */
export function injectToolPrompt(
  tools: unknown[],
  toolChoice: unknown,
): string {
  // Skip injection when tool_choice is "none"
  if (toolChoice === "none") return "";

  // Filter to function tools only
  const functionTools = (tools as FunctionTool[]).filter(
    (t) => t.type === "function" && t.function,
  );
  if (functionTools.length === 0) return "";

  // Build tool list
  const toolList = functionTools
    .map((t) => {
      const fn = t.function!;
      const params = fn.parameters ? JSON.stringify(fn.parameters, null, 2) : "{}";
      return `- **${fn.name}**: ${fn.description ?? "No description"}\n  Parameters: \`\`\`json\n${params}\n\`\`\``;
    })
    .join("\n");

  // Tool_choice modifier
  let modifier = "You MAY call a tool if appropriate.";
  if (toolChoice === "required") {
    modifier = "You MUST call at least one tool.";
  } else if (
    toolChoice &&
    typeof toolChoice === "object" &&
    (toolChoice as { function?: { name?: string } }).function?.name
  ) {
    const name = (toolChoice as { function: { name: string } }).function.name;
    modifier = `You MUST call the tool \`${name}\`.`;
  }

  // Format example
  const formatExample =
    'When you need to call a tool, respond ONLY with a `<tool_calls>` block containing a JSON array:\n' +
    '<tool_calls>[{"name":"tool_name","arguments":{"key":"value"}}]</tool_calls>\n' +
    'You may call multiple tools in a single response by including multiple objects in the array.';

  return [
    "# Available Tools",
    "",
    toolList,
    "",
    modifier,
    "",
    formatExample,
    "",
  ].join("\n");
}

// ── injectToolResults ────────────────────────────────────────────────────────

/**
 * Rewrite tool-related messages to the prompt-engineering convention:
 * - role:"tool" → {role:"system", content:"Tool `name` returned: {result}"}
 * - assistant tool_calls → `<tool_calls>[...]</tool_calls>` text in content
 *
 * Name resolution: tool_call_id → map from assistant tool_calls, or explicit name field.
 * Returns a new array (no mutation).
 */
export function injectToolResults(
  messages: Message[],
): { role: string; content: string }[] {
  // Build a map from tool_call_id → function name
  const idToName = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function?.name) {
          idToName.set(tc.id, tc.function.name);
        }
      }
    }
  }

  return messages.map((msg) => {
    // assistant with tool_calls → rewrite content to <tool_calls> text
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const calls = msg.tool_calls.map((tc) => ({
        name: tc.function?.name ?? "unknown",
        arguments: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
      }));
      const textBlock = `<tool_calls>${JSON.stringify(calls)}</tool_calls>`;
      return { role: "assistant", content: textBlock };
    }

    // tool message → system with Tool prefix
    if (msg.role === "tool") {
      const name =
        (msg.tool_call_id && idToName.get(msg.tool_call_id)) ??
        msg.name ??
        "unknown";
      return {
        role: "system",
        content: `Tool \`${name}\` returned: ${flattenContent(msg.content)}`,
      };
    }

    // Pass through everything else
    return { role: msg.role, content: flattenContent(msg.content) };
  });
}

// ── prependToFirstSystemMessage ──────────────────────────────────────────────

/**
 * Prepend `block` to the existing system message, or insert a new system
 * message at index 0 if none exists.
 * Mutates the array in place.
 */
export function prependToFirstSystemMessage(
  messages: { role: string; content: string }[],
  block: string,
): void {
  const idx = messages.findIndex((m) => m.role === "system");
  if (idx !== -1) {
    messages[idx].content = block + messages[idx].content;
  } else {
    messages.unshift({ role: "system", content: block });
  }
}
