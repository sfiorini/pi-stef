/**
 * Parse `<tool_calls>` blocks from model text output.
 *
 * The prompt-engineering layer instructs models to emit:
 *   <tool_calls>[{"name":"fn","arguments":{...}}]</tool_calls>
 *
 * This module parses that format back into OpenAI-compatible tool call objects.
 * Uses regex extraction + JSON.parse + lenient bracket-depth fallback for malformed JSON.
 */

import { randomUUID } from "node:crypto";

// ── Public types ─────────────────────────────────────────────────────────────

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ParseToolCallsResult {
  content: string | null;
  toolCalls: OpenAiToolCall[] | null;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Regex to match all `<tool_calls>...</tool_calls>` blocks (global). */
const TOOL_CALLS_RE = /<tool_calls>([\s\S]*?)<\/tool_calls>/g;

/**
 * Try to parse the inner JSON array.
 * Falls back to lenient per-object bracket-depth extraction on failure.
 */
function parseToolCallsInner(inner: string): OpenAiToolCall[] {
  const trimmed = inner.trim();
  if (!trimmed || trimmed === "[]") return [];

  // Fast path: try direct JSON.parse
  try {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr)) {
      return arr.map((item) => normalizeToolCall(item));
    }
  } catch {
    // Fall through to lenient parsing
  }

  // Lenient fallback: extract individual objects by bracket-depth scanning
  return extractObjectsLenient(trimmed);
}

/**
 * Normalize a parsed tool call object to OpenAiToolCall format.
 */
function normalizeToolCall(item: Record<string, unknown>): OpenAiToolCall {
  const name = typeof item.name === "string" ? item.name : "unknown";
  const args =
    typeof item.arguments === "string"
      ? item.arguments // already stringified
      : JSON.stringify(item.arguments ?? {});
  return {
    id: `call_${randomUUID()}`,
    type: "function",
    function: { name, arguments: args },
  };
}

/**
 * Lenient fallback: scan for individual `{...}` objects using bracket-depth tracking.
 * Returns as many valid objects as can be extracted.
 */
function extractObjectsLenient(text: string): OpenAiToolCall[] {
  const results: OpenAiToolCall[] = [];
  let i = 0;

  while (i < text.length) {
    // Find next opening brace
    const start = text.indexOf("{", i);
    if (start === -1) break;

    // Scan for matching closing brace by depth
    let depth = 0;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end === -1) break;

    const candidate = text.slice(start, end + 1);
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && typeof obj.name === "string") {
        results.push(normalizeToolCall(obj));
      }
    } catch {
      // Skip unparseable segment
    }

    i = end + 1;
  }

  return results;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse `<tool_calls>` blocks from text output.
 *
 * - Extracts all `<tool_calls>...</tool_calls>` spans (global regex)
 * - Parses inner JSON (with lenient bracket-depth fallback)
 * - Strips matched tag spans from content
 * - Returns {content:null, toolCalls:null} when no tags found
 */
export function parseToolCalls(text: string): ParseToolCallsResult {
  const allToolCalls: OpenAiToolCall[] = [];
  let cleanedContent = text;
  let found = false;

  // Collect all tool call blocks
  let match: RegExpExecArray | null;
  TOOL_CALLS_RE.lastIndex = 0; // reset global regex state
  while ((match = TOOL_CALLS_RE.exec(text)) !== null) {
    found = true;
    const inner = match[1];
    const calls = parseToolCallsInner(inner);
    allToolCalls.push(...calls);
  }

  if (!found) {
    return { content: text, toolCalls: null };
  }

  // Strip all tag spans from the content
  cleanedContent = text.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "").trim();
  if (!cleanedContent) cleanedContent = "";

  return {
    content: cleanedContent || null,
    toolCalls: allToolCalls.length > 0 ? allToolCalls : [],
  };
}
