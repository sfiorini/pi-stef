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

  // --- Case 3: text → toolCall emits text_end before toolcall_start ---
  it("text-delta then tool-call-started emits text_end before toolcall_start", () => {
    coordinator.handleDelta({ update: { type: "text-delta", text: "some text" } });
    coordinator.handleDelta({
      update: {
        type: "tool-call-started",
        callId: "tc-1",
        toolCall: { type: "read", args: { path: "/tmp" } },
      },
    });

    const types = events.map((e) => e.type);
    const textEndIdx = types.indexOf("text_end");
    const toolcallStartIdx = types.indexOf("toolcall_start");
    expect(textEndIdx).toBeGreaterThanOrEqual(0);
    expect(toolcallStartIdx).toBeGreaterThan(textEndIdx);

    // text_end should have the accumulated text
    const textEndEvt = events[textEndIdx] as AssistantMessageEvent & { content?: string };
    expect(textEndEvt.content).toBe("some text");

    // text contentIndex should have been reset so no duplicate text_start later
    // A second text-delta after the toolcall should start a NEW text block
    coordinator.handleDelta({ update: { type: "text-delta", text: "after tool" } });
    const starts = events.filter((e) => e.type === "text_start");
    expect(starts).toHaveLength(2);
  });

  // --- Case 3b: text → thinking emits text_end before thinking_start ---
  it("text-delta then thinking-delta emits text_end before thinking_start", () => {
    coordinator.handleDelta({ update: { type: "text-delta", text: "pre-think" } });
    coordinator.handleDelta({ update: { type: "thinking-delta", text: "hmm" } });

    const types = events.map((e) => e.type);
    const textEndIdx = types.indexOf("text_end");
    const thinkStartIdx = types.indexOf("thinking_start");
    expect(textEndIdx).toBeGreaterThanOrEqual(0);
    expect(thinkStartIdx).toBeGreaterThan(textEndIdx);
  });

  // --- Case 3c: thinking → text emits thinking_end before text_start ---
  it("thinking-delta then text-delta emits thinking_end before text_start", () => {
    coordinator.handleDelta({ update: { type: "thinking-delta", text: "hmm" } });
    coordinator.handleDelta({ update: { type: "text-delta", text: "answer" } });

    const types = events.map((e) => e.type);
    const thinkEndIdx = types.indexOf("thinking_end");
    const textStartIdx = types.indexOf("text_start");
    expect(thinkEndIdx).toBeGreaterThanOrEqual(0);
    expect(textStartIdx).toBeGreaterThan(thinkEndIdx);
  });

  // --- Case 3d: tool start/delta/end ---
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

  // --- Case 5a: handleStep uses step.message.name when available ---
  it("handleStep toolCall uses step.message.name for tool name when present", () => {
    coordinator.handleStep({
      step: {
        type: "toolCall",
        message: { type: "shell", name: "my_shell_tool", args: { command: "echo hi" }, callId: "step-named-1" },
      },
    });

    // The toolcall_end event should reference the named tool
    const endEvt = events.find((e) => e.type === "toolcall_end") as AssistantMessageEvent & { toolCall?: { name: string } };
    expect(endEvt).toBeDefined();
    expect(endEvt.toolCall?.name).toBe("my_shell_tool");
  });

  // --- Case 5b: handleStep falls back to message.type when name absent ---
  it("handleStep toolCall uses message.type when name is absent", () => {
    coordinator.handleStep({
      step: {
        type: "toolCall",
        message: { type: "read", args: { path: "/tmp" }, callId: "step-unnamed-1" },
      },
    });

    const endEvt = events.find((e) => e.type === "toolcall_end") as AssistantMessageEvent & { toolCall?: { name: string } };
    expect(endEvt).toBeDefined();
    expect(endEvt.toolCall?.name).toBe("read");
  });

  // --- Case 5c: handleStep toolCall fallback ---
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

  // --- P2-c: bridgeToolStart + tool-call-started → dedup (one toolcall_start) ---
  it("bridgeToolStart + SDK tool-call-started → dedup (one toolcall_start)", () => {
    // bridgeToolStart creates block + emits start + delta
    coordinator.bridgeToolStart("tc_dedup", "read_file", '{"path":"/tmp/x"}');

    // SDK fires tool-call-started for the same callId → should only emit delta
    coordinator.handleDelta({
      update: {
        type: "tool-call-started",
        callId: "tc_dedup",
        toolCall: { type: "read_file", args: { path: "/tmp/x" } },
      },
    });

    // Should have exactly ONE toolcall_start (from bridgeToolStart)
    const starts = events.filter((e) => e.type === "toolcall_start");
    expect(starts.length).toBe(1);

    // But toolcall_delta should be emitted (bridgeToolStart delta + SDK delta)
    const deltas = events.filter((e) => e.type === "toolcall_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
  });

  // --- P2-c bridgeToolStart: creates block + emits start/delta ---
  it("bridgeToolStart: creates ToolCall block at correct index + emits toolcall_start + toolcall_delta", () => {
    coordinator.bridgeToolStart("bt1", "read_file", '{"path":"/x"}');

    // partial.content should have a ToolCall block
    expect(partial.content).toHaveLength(1);
    const block = partial.content[0] as { type: string; id: string; name: string; arguments: Record<string, any> };
    expect(block.type).toBe("toolCall");
    expect(block.id).toBe("bt1");
    expect(block.name).toBe("read_file");
    expect(block.arguments).toEqual({ path: "/x" });

    // Events: exactly one toolcall_start + one toolcall_delta
    const starts = events.filter((e) => e.type === "toolcall_start");
    const deltas = events.filter((e) => e.type === "toolcall_delta");
    expect(starts).toHaveLength(1);
    expect(deltas).toHaveLength(1);
    expect((starts[0] as AssistantMessageEvent & { contentIndex: number }).contentIndex).toBe(0);
  });

  // --- P2-c bridgeToolStart: idempotent — second call for same callId only emits delta ---
  it("bridgeToolStart: idempotent — second call only emits delta, not start", () => {
    coordinator.bridgeToolStart("bt2", "read_file", '{"path":"/a"}');
    coordinator.bridgeToolStart("bt2", "read_file", '{"path":"/b"}');

    // Still exactly one ToolCall block
    expect(partial.content).toHaveLength(1);
    const block = partial.content[0] as { type: string; arguments: Record<string, any> };
    expect(block.arguments).toEqual({ path: "/b" }); // updated args

    const starts = events.filter((e) => e.type === "toolcall_start");
    const deltas = events.filter((e) => e.type === "toolcall_delta");
    expect(starts).toHaveLength(1);
    expect(deltas).toHaveLength(2); // start delta + second delta
  });

  // --- P2-c bridgeToolStart: strips pi__ prefix ---
  it("bridgeToolStart: strips pi__ prefix from tool name", () => {
    coordinator.bridgeToolStart("bt3", "pi__read_file", '{"path":"/y"}');

    const block = partial.content[0] as { type: string; name: string };
    expect(block.name).toBe("read_file");
  });

  // --- P2-c: bridgeToolStart then SDK tool-call-started → still exactly one toolcall_start ---
  it("bridgeToolStart then SDK tool-call-started → dedup (one toolcall_start)", () => {
    coordinator.bridgeToolStart("bt4", "read_file", '{"path":"/z"}');

    // SDK fires tool-call-started for the same callId
    coordinator.handleDelta({
      update: {
        type: "tool-call-started",
        callId: "bt4",
        toolCall: { type: "pi__read_file", args: { path: "/z" } },
      },
    });

    const starts = events.filter((e) => e.type === "toolcall_start");
    expect(starts).toHaveLength(1); // STILL exactly one

    // The block should have updated name from SDK (pi__ stripped)
    const block = partial.content[0] as { type: string; name: string; arguments: Record<string, any> };
    expect(block.name).toBe("read_file");
  });

  // --- P2-c: bridgeToolStart then tool-call-completed → no crash + toolcall_end ---
  it("bridgeToolStart then tool-call-completed → no crash + toolcall_end emitted", () => {
    coordinator.bridgeToolStart("bt5", "read_file", '{"path":"/w"}');

    // SDK fires tool-call-completed — should not crash even though bridge started it
    coordinator.handleDelta({
      update: {
        type: "tool-call-completed",
        callId: "bt5",
        toolCall: { type: "pi__read_file", args: { path: "/w" } },
      },
    });

    const ends = events.filter((e) => e.type === "toolcall_end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as AssistantMessageEvent & { toolCall?: { name: string } }).toolCall?.name).toBe("read_file");
  });

  // --- P3: pi__ prefix stripped in tool-call-started ---
  it("P3: tool-call-started with pi__ prefix → partial name is stripped", () => {
    coordinator.handleDelta({
      update: {
        type: "tool-call-started",
        callId: "tc_pi",
        toolCall: { type: "pi__read_file", args: { path: "/tmp/strip" } },
      },
    });

    expect(partial.content).toHaveLength(1);
    const block = partial.content[0] as { type: string; name: string };
    expect(block.name).toBe("read_file");
  });
});
