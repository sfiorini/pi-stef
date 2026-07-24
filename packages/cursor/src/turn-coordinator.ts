/**
 * Turn coordinator — maps SDK InteractionUpdate / ConversationStep deltas
 * into pi AssistantMessageEvent stream.
 *
 * Local mirrors of SDK types are used (no `@cursor/sdk` import) so the module
 * stays unit-testable without a live SDK.  Mirror field names MATCH the
 * installed SDK `delta-types.d.ts` exactly so that S-62 wiring works.
 */

import type {
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent as PiAssistantMessageEvent,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";

// ─── Re-export pi types under shorter names ──────────────────────────────────

export type AssistantMessage = PiAssistantMessage;
export type AssistantMessageEvent = PiAssistantMessageEvent;

// ─── Local mirrors of SDK InteractionUpdate subtypes ─────────────────────────
// Field names are EXACT matches to @cursor/sdk@1.0.24 delta-types.d.ts

export interface TextDeltaUpdate {
  type: "text-delta";
  text: string;
}

export interface ThinkingDeltaUpdate {
  type: "thinking-delta";
  text: string;
}

export interface ShellOutputDeltaUpdate {
  type: "shell-output-delta";
  event: Record<string, unknown>;
}

export interface ThinkingCompletedUpdate {
  type: "thinking-completed";
  thinkingDurationMs: number;
}

export interface ToolCallStartedUpdate {
  type: "tool-call-started";
  callId: string;
  toolCall: { type: string; args: Record<string, unknown> };
}

export interface ToolCallDeltaUpdate {
  type: "tool-call-delta";
  callId: string;
  modelCallId: string;
  taskUpdate: { type: string; text?: string };
}

export interface ToolCallCompletedUpdate {
  type: "tool-call-completed";
  callId: string;
  toolCall: { type: string; args: Record<string, unknown>; result?: unknown };
}

export interface TurnEndedUpdate {
  type: "turn-ended";
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens?: number;
  };
}

/** Discriminated union of all known InteractionUpdate subtypes. */
export type InteractionUpdate =
  | TextDeltaUpdate
  | ThinkingDeltaUpdate
  | ShellOutputDeltaUpdate
  | ThinkingCompletedUpdate
  | ToolCallStartedUpdate
  | ToolCallDeltaUpdate
  | ToolCallCompletedUpdate
  | TurnEndedUpdate
  | { type: string }; // catch-all for unknown subtypes

// ─── Local mirror of SDK ConversationStep ────────────────────────────────────

export interface ConversationStep {
  type: "assistantMessage" | "toolCall";
  message: {
    type: string;
    name?: string;
    text?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    callId?: string;
  };
}

// ─── Usage type ──────────────────────────────────────────────────────────────

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ─── Coordinator ─────────────────────────────────────────────────────────────

export class CursorSdkTurnCoordinator {
  private _partial: AssistantMessage;
  private _push: (e: AssistantMessageEvent) => void;

  // Content-index trackers for deduplicating start events
  private _textContentIndex = -1;
  private _thinkingContentIndex = -1;
  private _toolContentIndex = new Map<string, number>();

  // Dedup set: callIds that have been finalised (toolcall_end emitted)
  private _completedCalls = new Set<string>();

  // Usage from turn-ended
  private _usage: TurnUsage = {};

  constructor(
    partial: AssistantMessage,
    push: (e: AssistantMessageEvent) => void,
  ) {
    this._partial = partial;
    this._push = push;
  }

  // ─── block-transition helpers ─────────────────────────────────────────────

  /** If a text block is open, emit text_end and reset the index. */
  private _closeTextBlock(): void {
    if (this._textContentIndex !== -1) {
      const textBlock = this._partial.content[this._textContentIndex] as TextContent;
      this._push({
        type: "text_end",
        contentIndex: this._textContentIndex,
        content: textBlock.text,
        partial: this._partial,
      });
      this._textContentIndex = -1;
    }
  }

  /** If a thinking block is open, emit thinking_end and reset the index. */
  private _closeThinkingBlock(): void {
    if (this._thinkingContentIndex !== -1) {
      const thinkBlock = this._partial.content[this._thinkingContentIndex] as ThinkingContent;
      this._push({
        type: "thinking_end",
        contentIndex: this._thinkingContentIndex,
        content: thinkBlock.thinking,
        partial: this._partial,
      });
      this._thinkingContentIndex = -1;
    }
  }

  // ─── handleDelta ─────────────────────────────────────────────────────────

  handleDelta({ update }: { update: InteractionUpdate }): void {
    switch (update.type) {
      case "text-delta": {
        const u = update as TextDeltaUpdate;
        if (this._textContentIndex === -1) {
          // Close any open thinking block before opening text
          this._closeThinkingBlock();
          // First text delta → create a TextContent block
          this._textContentIndex = this._partial.content.length;
          this._partial.content.push({ type: "text", text: "" } as TextContent);
          this._push({
            type: "text_start",
            contentIndex: this._textContentIndex,
            partial: this._partial,
          });
        }
        const textBlock = this._partial.content[this._textContentIndex] as TextContent;
        textBlock.text += u.text;
        this._push({
          type: "text_delta",
          contentIndex: this._textContentIndex,
          delta: u.text,
          partial: this._partial,
        });
        break;
      }

      case "thinking-delta":
      case "shell-output-delta": {
        // Both route to thinking_* events
        const text =
          update.type === "thinking-delta"
            ? (update as ThinkingDeltaUpdate).text
            : extractShellOutputText(update as ShellOutputDeltaUpdate);

        if (this._thinkingContentIndex === -1) {
          // Close any open text block before opening thinking
          this._closeTextBlock();
          this._thinkingContentIndex = this._partial.content.length;
          this._partial.content.push({ type: "thinking", thinking: "" } as ThinkingContent);
          this._push({
            type: "thinking_start",
            contentIndex: this._thinkingContentIndex,
            partial: this._partial,
          });
        }
        const thinkBlock = this._partial.content[this._thinkingContentIndex] as ThinkingContent;
        thinkBlock.thinking += text;
        this._push({
          type: "thinking_delta",
          contentIndex: this._thinkingContentIndex,
          delta: text,
          partial: this._partial,
        });
        break;
      }

      case "thinking-completed": {
        if (this._thinkingContentIndex !== -1) {
          const thinkBlock = this._partial.content[this._thinkingContentIndex] as ThinkingContent;
          this._push({
            type: "thinking_end",
            contentIndex: this._thinkingContentIndex,
            content: thinkBlock.thinking,
            partial: this._partial,
          });
          this._thinkingContentIndex = -1; // allow new thinking block
        }
        break;
      }

      case "tool-call-started": {
        const u = update as ToolCallStartedUpdate;
        // P2-c real fix: if bridge emitter already started this callId,
        // update name/args and emit a delta — do NOT re-emit toolcall_start.
        if (this._toolContentIndex.has(u.callId)) {
          const idx = this._toolContentIndex.get(u.callId)!;
          const block = this._partial.content[idx] as ToolCall;
          if (block) {
            block.name = stripToolPrefix(u.toolCall.type);
            if (u.toolCall.args) block.arguments = { ...u.toolCall.args };
          }
          this._push({
            type: "toolcall_delta",
            contentIndex: idx,
            delta: JSON.stringify(u.toolCall.args),
            partial: this._partial,
          });
          break;
        }
        // Close any open text/thinking blocks before opening toolCall
        this._closeTextBlock();
        this._closeThinkingBlock();
        const idx = this._partial.content.length;
        this._toolContentIndex.set(u.callId, idx);
        this._partial.content.push({
          type: "toolCall",
          id: u.callId,
          name: stripToolPrefix(u.toolCall.type),
          arguments: { ...u.toolCall.args },
        } as ToolCall);
        this._push({
          type: "toolcall_start",
          contentIndex: idx,
          partial: this._partial,
        });
        this._push({
          type: "toolcall_delta",
          contentIndex: idx,
          delta: JSON.stringify(u.toolCall.args),
          partial: this._partial,
        });
        break;
      }

      case "tool-call-delta": {
        const u = update as ToolCallDeltaUpdate;
        let idx = this._toolContentIndex.get(u.callId);
        if (idx === undefined) {
          // Lazy start — create a placeholder ToolCall
          idx = this._partial.content.length;
          this._toolContentIndex.set(u.callId, idx);
          const nameFromTask =
            u.taskUpdate.type === "tool-call-started"
              ? (u.taskUpdate as unknown as ToolCallStartedUpdate).toolCall.type
              : "unknown";
          this._partial.content.push({
            type: "toolCall",
            id: u.callId,
            name: stripToolPrefix(nameFromTask),
            arguments: {},
          } as ToolCall);
          this._push({
            type: "toolcall_start",
            contentIndex: idx,
            partial: this._partial,
          });
        }
        const deltaText = u.taskUpdate.text ?? "";
        if (deltaText) {
          this._push({
            type: "toolcall_delta",
            contentIndex: idx,
            delta: deltaText,
            partial: this._partial,
          });
        }
        break;
      }

      case "tool-call-completed": {
        const u = update as ToolCallCompletedUpdate;
        if (this._completedCalls.has(u.callId)) break;

        let idx = this._toolContentIndex.get(u.callId);
        if (idx === undefined || idx >= this._partial.content.length || !this._partial.content[idx]) {
          // Lazy-create or re-create if block is missing
          idx = this._partial.content.length;
          this._toolContentIndex.set(u.callId, idx);
          this._partial.content.push({
            type: "toolCall",
            id: u.callId,
            name: stripToolPrefix(u.toolCall.type),
            arguments: { ...u.toolCall.args },
          } as ToolCall);
        }

        // Update the ToolCall with final args
        const toolBlock = this._partial.content[idx] as ToolCall;
        toolBlock.name = stripToolPrefix(u.toolCall.type);
        toolBlock.arguments = { ...u.toolCall.args };

        this._completedCalls.add(u.callId);
        this._push({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall: toolBlock,
          partial: this._partial,
        });
        break;
      }

      case "turn-ended": {
        const u = update as TurnEndedUpdate;
        if (u.usage) {
          this._usage = {
            inputTokens: u.usage.inputTokens,
            outputTokens: u.usage.outputTokens,
            cacheReadTokens: u.usage.cacheReadTokens,
            cacheWriteTokens: u.usage.cacheWriteTokens,
          };
        }
        break;
      }

      default: {
        // Unknown subtypes (summary-*, token-delta, nested-task,
        // user-message-appended, etc.) are silently ignored.
        break;
      }
    }
  }

  // ─── handleStep ──────────────────────────────────────────────────────────

  handleStep({ step }: { step: ConversationStep }): void {
    if (step.type === "toolCall") {
      const callId = step.message.callId;
      if (callId && !this._completedCalls.has(callId)) {
        // Fallback: emit toolcall_end via step when delta path didn't complete it
        let idx = this._toolContentIndex.get(callId);
        if (idx === undefined) {
          idx = this._partial.content.length;
          this._toolContentIndex.set(callId, idx);
          this._partial.content.push({
            type: "toolCall",
            id: callId,
            name: stripToolPrefix(step.message.name ?? step.message.type),
            arguments: step.message.args ? { ...step.message.args } : {},
          } as ToolCall);
        }
        const toolBlock = this._partial.content[idx] as ToolCall;
        this._completedCalls.add(callId);
        this._push({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall: toolBlock,
          partial: this._partial,
        });
      }
    }
  }

  // ─── reset ───────────────────────────────────────────────────────────────

  /**
   * Clear internal tracking state so the SAME coordinator instance can serve
   * a resumed run.  Content already pushed to partial stays; new content
   * will be appended.
   */
  reset(): void {
    this._textContentIndex = -1;
    this._thinkingContentIndex = -1;
    this._toolContentIndex.clear();
    this._completedCalls.clear();
    this._usage = {};
  }

  // ─── markToolStarted (P2-c: bridge emitter dedup) ────────────────────────

  /**
   * Record a callId as already started WITHOUT emitting any events.
   * Used by the bridge emitter so the coordinator doesn't emit a duplicate
   * `toolcall_start` when it later receives `tool-call-started` for the same callId.
   *
   * @deprecated Use `bridgeToolStart` instead which creates the block + emits events.
   */
  markToolStarted(callId: string): void {
    if (!this._toolContentIndex.has(callId)) {
      this._toolContentIndex.set(callId, this._partial.content.length);
    }
  }

  // ─── bridgeToolStart (P2-c: coordinator-owned toolcall events) ─────────

  /**
   * Called by the tool-bridge emitter when a customTool's execute() fires
   * (possibly without a preceding SDK tool-call-started delta).
   *
   * Idempotent per callId:
   *   - If the SDK already started this call, just update args + emit a delta.
   *   - Otherwise create the ToolCall block + emit toolcall_start + delta.
   */
  bridgeToolStart(callId: string, name: string, argsJson: string): void {
    const cleanName = name.startsWith("pi__") ? name.slice(4) : name;
    const parsedArgs = parseArgsJson(argsJson);
    if (this._toolContentIndex.has(callId)) {
      // Already started (by SDK delta or prior bridgeToolStart) — just emit delta
      const idx = this._toolContentIndex.get(callId)!;
      const block = this._partial.content[idx] as ToolCall;
      if (block) {
        if (cleanName) block.name = cleanName;
        block.arguments = parsedArgs;
      }
      this._push({
        type: "toolcall_delta",
        contentIndex: idx,
        delta: argsJson,
        partial: this._partial,
      } as AssistantMessageEvent);
      return;
    }
    // New call — create ToolCall block + emit start + delta
    this._closeTextBlock();
    this._closeThinkingBlock();
    const idx = this._partial.content.length;
    this._partial.content.push({
      type: "toolCall",
      id: callId,
      name: cleanName,
      arguments: parsedArgs,
    } as ToolCall);
    this._toolContentIndex.set(callId, idx);
    this._push({
      type: "toolcall_start",
      contentIndex: idx,
      partial: this._partial,
    } as AssistantMessageEvent);
    this._push({
      type: "toolcall_delta",
      contentIndex: idx,
      delta: argsJson,
      partial: this._partial,
    } as AssistantMessageEvent);
  }

  // ─── accessors ───────────────────────────────────────────────────────────

  get usage(): TurnUsage {
    return this._usage;
  }

  get partial(): AssistantMessage {
    return this._partial;
  }
}

// ─── internal helpers ────────────────────────────────────────────────────────

/**
 * Strip the `pi__` prefix that the tool-bridge adds to custom tool names.
 * e.g. `pi__read_file` → `read_file`; `shell` → `shell`.
 */
function stripToolPrefix(name: string): string {
  return name.replace(/^pi__/, "");
}

/**
 * Safely parse a JSON string into a Record. Returns {} on failure.
 */
function parseArgsJson(json: string): Record<string, any> {
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Extract text from a shell-output-delta event record.
 * The `event` field is `Record<string, unknown>` — we try to pull useful
 * text from common fields, falling back to JSON.stringify.
 */
function extractShellOutputText(update: ShellOutputDeltaUpdate): string {
  const evt = update.event;
  if (typeof evt === "object" && evt !== null) {
    if (typeof (evt as Record<string, unknown>).stdout === "string")
      return (evt as Record<string, unknown>).stdout as string;
    if (typeof (evt as Record<string, unknown>).stderr === "string")
      return (evt as Record<string, unknown>).stderr as string;
    if (typeof (evt as Record<string, unknown>).text === "string")
      return (evt as Record<string, unknown>).text as string;
  }
  return JSON.stringify(evt);
}
