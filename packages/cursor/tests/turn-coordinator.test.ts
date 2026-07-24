import { describe, expect, it, beforeEach } from "vitest";

import {
  CursorSdkTurnCoordinator,
  type AssistantMessage,
  type AssistantMessageEvent,
  type InteractionUpdate,
} from "../src/turn-coordinator";

// ─── helpers ─────────────────────────────────────────────────────────────────

function freshAssistant(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "cursor-sdk",
    provider: "cursor",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function collectEvents(): { events: AssistantMessageEvent[]; push: (e: AssistantMessageEvent) => void } {
  const events: AssistantMessageEvent[] = [];
  return { events, push: (e) => events.push(e) };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("CursorSdkTurnCoordinator", () => {
  let partial: AssistantMessage;
  let events: AssistantMessageEvent[];
  let coordinator: CursorSdkTurnCoordinator;

  beforeEach(() => {
    partial = freshAssistant();
    const collected = collectEvents();
    events = collected.events;
    coordinator = new CursorSdkTurnCoordinator(partial, collected.push);
  });

  // --- Case 1: text deltas accumulate ---
  it("text deltas accumulate: text_start once + text_delta for each, partial.content updated", () => {
    coordinator.handleDelta({ update: { type: "text-delta", text: "Hel" } });
    coordinator.handleDelta({ update: { type: "text-delta", text: "lo" } });

    // text_start emitted once, then two text_delta
    const startEvts = events.filter((e) => e.type === "text_start");
    const deltaEvts = events.filter((e) => e.type === "text_delta");
    expect(startEvts).toHaveLength(1);
    expect(deltaEvts).toHaveLength(2);

    // partial accumulates
    expect(partial.content).toHaveLength(1);
    expect(partial.content[0].type).toBe("text");
    expect((partial.content[0] as { type: "text"; text: string }).text).toBe("Hello");
  });

  // --- Case 2: thinking + completed ---
  it("thinking deltas accumulate and thinking-completed emits thinking_end", () => {
    coordinator.handleDelta({ update: { type: "thinking-delta", text: "pondering..." } });
    coordinator.handleDelta({ update: { type: "thinking-delta", text: " still thinking" } });
    coordinator.handleDelta({ update: { type: "thinking-completed", thinkingDurationMs: 1500 } });

    const startEvts = events.filter((e) => e.type === "thinking_start");
    const deltaEvts = events.filter((e) => e.type === "thinking_delta");
    const endEvts = events.filter((e) => e.type === "thinking_end");
    expect(startEvts).toHaveLength(1);
    expect(deltaEvts).toHaveLength(2);
    expect(endEvts).toHaveLength(1);

    // ThinkingContent uses `thinking` property, not `text`
    expect(partial.content).toHaveLength(1);
    expect(partial.content[0].type).toBe("thinking");
    expect(
      (partial.content[0] as unknown as { type: "thinking"; thinking: string }).thinking,
    ).toBe("pondering... still thinking");
  });

  // --- Case 3: tool start/delta/end ---
  it("tool-call-started/delta/completed emit correct toolcall events", () => {
    coordinator.handleDelta({
      update: {
        type: "tool-call-started",
        callId: "call-1",
        toolCall: { type: "read", args: { path: "/tmp/foo" } },
      },
    });
    coordinator.handleDelta({
      update: {
        type: "tool-call-delta",
        callId: "call-1",
        modelCallId: "mc-1",
        taskUpdate: { type: "text-delta", text: "/tmp/foo" },
      },
    });
    coordinator.handleDelta({
      update: {
        type: "tool-call-completed",
        callId: "call-1",
        toolCall: { type: "read", args: { path: "/tmp/foo" } },
      },
    });

    const startEvts = events.filter((e) => e.type === "toolcall_start");
    const deltaEvts = events.filter((e) => e.type === "toolcall_delta");
    const endEvts = events.filter((e) => e.type === "toolcall_end");
    expect(startEvts).toHaveLength(1);
    // start delta from tool-call-started + delta from tool-call-delta
    expect(deltaEvts).toHaveLength(2);
    expect(endEvts).toHaveLength(1);

    // partial has a toolcall
    const toolCalls = partial.content.filter((c) => c.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
  });

  // --- Case 4: dedup — second completed via handleStep does NOT duplicate ---
  it("dedup: handleDelta tool-call-completed + handleStep toolCall → only one toolcall_end", () => {
    coordinator.handleDelta({
      update: {
        type: "tool-call-started",
        callId: "call-2",
        toolCall: { type: "shell", args: { command: "ls" } },
      },
    });
    coordinator.handleDelta({
      update: {
        type: "tool-call-completed",
        callId: "call-2",
        toolCall: { type: "shell", args: { command: "ls" } },
      },
    });

    // Now handleStep with the same callId — should NOT emit another toolcall_end
    coordinator.handleStep({
      step: {
        type: "toolCall",
        message: { type: "shell", args: { command: "ls" }, callId: "call-2" },
      },
    });

    const endEvts = events.filter((e) => e.type === "toolcall_end");
    expect(endEvts).toHaveLength(1);
  });

  // --- Case 5: handleStep toolCall fallback ---
  it("handleStep toolCall emits toolcall_end when not already completed via delta", () => {
    coordinator.handleStep({
      step: {
        type: "toolCall",
        message: { type: "shell", args: { command: "echo hi" }, callId: "step-call-1" },
      },
    });

    const endEvts = events.filter((e) => e.type === "toolcall_end");
    expect(endEvts).toHaveLength(1);
  });

  // --- Case 6: turn-ended usage ---
  it("turn-ended records usage", () => {
    coordinator.handleDelta({
      update: {
        type: "turn-ended",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      },
    });

    expect(coordinator.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });

  // --- Case 7: unknown subtype ignored ---
  it("unknown subtype is ignored (no events, no crash)", () => {
    const eventsBefore = events.length;
    coordinator.handleDelta({ update: { type: "summary-started" } as unknown as InteractionUpdate });
    coordinator.handleDelta({ update: { type: "token-delta" } as unknown as InteractionUpdate });
    coordinator.handleDelta({ update: { type: "nested-task" } as unknown as InteractionUpdate });
    expect(events).toHaveLength(eventsBefore);
  });

  // --- Case 8: reset + append ---
  it("reset clears state so new deltas append to fresh content", () => {
    // First turn
    coordinator.handleDelta({ update: { type: "text-delta", text: "first" } });
    expect((partial.content[0] as { type: "text"; text: string }).text).toBe("first");

    coordinator.reset();

    // Second turn — new text appends (contentIndex resets)
    coordinator.handleDelta({ update: { type: "text-delta", text: "second" } });
    // After reset, a NEW text block is created (second element)
    expect(partial.content.length).toBe(2);
    const lastText = partial.content[1] as { type: "text"; text: string };
    expect(lastText.type).toBe("text");
    expect(lastText.text).toBe("second");

    // usage was cleared
    expect(coordinator.usage.inputTokens).toBeUndefined();
  });
});
