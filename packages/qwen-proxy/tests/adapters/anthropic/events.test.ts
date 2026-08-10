import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { QwenChunk } from "../../../src/upstream/client";
import { streamAnthropicEvents } from "../../../src/adapters/anthropic/events";

function parseEvents(output: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = output.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let event = "";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      if (line.startsWith("data: ")) data = line.slice("data: ".length);
    }
    if (event) {
      events.push({ event, data: JSON.parse(data) });
    }
  }
  return events;
}

async function collectEvents(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iter) out += chunk;
  return out;
}

describe("streamAnthropicEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("think→answer emits signature_delta + stop + start with correct indices", async () => {
    const chunks: QwenChunk[] = [
      { phase: "think", content: "Let me" },
      { phase: "think", content: " think" },
      { phase: "answer", content: "Hello" },
      { phase: "answer", content: " world" },
      { finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { done: true },
    ];

    async function* gen() {
      for (const c of chunks) yield c;
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 10 }),
    );
    const events = parseEvents(output);

    // message_start
    expect(events[0].event).toBe("message_start");
    const msgStart = events[0].data as any;
    expect(msgStart.type).toBe("message_start");
    expect(msgStart.message.id).toMatch(/^msg_/);
    expect(msgStart.message.role).toBe("assistant");
    expect(msgStart.message.model).toBe("qwen3-max");
    expect(msgStart.message.usage.input_tokens).toBe(10);
    expect(msgStart.message.usage.output_tokens).toBe(0);

    // think content_block_start index 0
    expect(events[1]).toEqual({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    });

    // thinking deltas
    expect(events[2]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Let me" },
      },
    });
    expect(events[3]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: " think" },
      },
    });

    // signature_delta (D7 empty)
    expect(events[4]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "" },
      },
    });

    // content_block_stop index 0
    expect(events[5]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    });

    // text content_block_start index 1
    expect(events[6]).toEqual({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
    });

    // text deltas
    expect(events[7]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Hello" },
      },
    });
    expect(events[8]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: " world" },
      },
    });

    // content_block_stop index 1
    expect(events[9]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 1 },
    });

    // message_delta with stop_reason
    expect(events[10]).toEqual({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    });

    // message_stop
    expect(events[11]).toEqual({
      event: "message_stop",
      data: { type: "message_stop" },
    });
  });

  it("no-think → text block at index 0", async () => {
    const chunks: QwenChunk[] = [
      { phase: "answer", content: "Direct answer" },
      { finishReason: "stop", usage: { prompt_tokens: 5, completion_tokens: 3 } },
      { done: true },
    ];

    async function* gen() {
      for (const c of chunks) yield c;
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 5 }),
    );
    const events = parseEvents(output);

    // message_start
    expect(events[0].event).toBe("message_start");

    // text block starts at index 0 (no thinking block)
    expect(events[1]).toEqual({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    });

    // text delta
    expect(events[2]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Direct answer" },
      },
    });

    // content_block_stop index 0
    expect(events[3]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    });

    // message_delta
    expect(events[4]).toEqual({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
    });

    // message_stop
    expect(events[5]).toEqual({
      event: "message_stop",
      data: { type: "message_stop" },
    });
  });

  it("30s idle → ping event", async () => {
    let resolve: () => void;
    const blocker = new Promise<void>((r) => (resolve = r));

    async function* gen(): AsyncIterable<QwenChunk> {
      yield { phase: "answer", content: "first" };
      await blocker;
      yield { done: true };
    }

    const iter = streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 });
    const collected: string[] = [];

    const consumePromise = (async () => {
      for await (const chunk of iter) {
        collected.push(chunk);
      }
    })();

    // Advance past the first content_block_start + delta
    await vi.advanceTimersByTimeAsync(0);

    // Advance 30 seconds — should fire a ping
    await vi.advanceTimersByTimeAsync(30_000);

    // Unblock the stream
    resolve!();
    await consumePromise;

    const allOutput = collected.join("");
    const events = parseEvents(allOutput);

    const pingEvents = events.filter((e) => e.event === "ping");
    expect(pingEvents.length).toBeGreaterThanOrEqual(1);
    expect(pingEvents[0].data).toEqual({ type: "ping" });
  });

  it("sentinel → error event + terminate", async () => {
    async function* gen(): AsyncIterable<QwenChunk> {
      yield { phase: "answer", content: "partial" };
      yield { done: true, extra: { rateLimited: true } };
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 }),
    );
    const events = parseEvents(output);

    // Should have message_start, content_block_start, text_delta, then error
    expect(events[0].event).toBe("message_start");
    expect(events[1].event).toBe("content_block_start");
    expect(events[2].event).toBe("content_block_delta");

    // Error event
    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.data).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "rate limit exceeded",
      },
    });

    // Should NOT have message_delta/message_stop after error
    const terminalEvents = events.filter(
      (e) => e.event === "message_delta" || e.event === "message_stop",
    );
    expect(terminalEvents).toHaveLength(0);
  });

  it("think-only then done → stops without text block", async () => {
    const chunks: QwenChunk[] = [
      { phase: "think", content: "Thinking..." },
      { finishReason: "stop", usage: { prompt_tokens: 5, completion_tokens: 1 } },
      { done: true },
    ];

    async function* gen() {
      for (const c of chunks) yield c;
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 5 }),
    );
    const events = parseEvents(output);

    // message_start → content_block_start(thinking) → thinking_delta → signature_delta → content_block_stop(0) → message_delta → message_stop
    expect(events[0].event).toBe("message_start");
    expect(events[1].event).toBe("content_block_start");
    expect(events[2]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Thinking..." },
      },
    });
    // signature_delta
    expect(events[3]).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "" },
      },
    });
    expect(events[4]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    });
    expect(events[5].event).toBe("message_delta");
    expect(events[6].event).toBe("message_stop");
  });

  it("stop_reason maps finishReason correctly", async () => {
    async function* gen(): AsyncIterable<QwenChunk> {
      yield { phase: "answer", content: "x" };
      yield { finishReason: "length", usage: { prompt_tokens: 1, completion_tokens: 1 } };
      yield { done: true };
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 }),
    );
    const events = parseEvents(output);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta!.data as any).delta.stop_reason).toBe("max_tokens");
  });

  it("stop_reason: stop_sequence maps correctly", async () => {
    async function* gen(): AsyncIterable<QwenChunk> {
      yield { phase: "answer", content: "x" };
      yield { finishReason: "stop_sequence", usage: { prompt_tokens: 1, completion_tokens: 1 } };
      yield { done: true };
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 }),
    );
    const events = parseEvents(output);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta!.data as any).delta.stop_reason).toBe("stop_sequence");
  });

  // ── A2: ping must NOT drop the first post-stall chunk ───────────────────

  it("A2: 30s ping does NOT drop the first post-stall content chunk", async () => {
    // Upstream stalls for >30s, then yields a content chunk + done.
    // The old code would orphan the pending iter.next() on ping timeout,
    // causing the first post-stall chunk to be silently dropped.
    let resolve: () => void;
    const blocker = new Promise<void>((r) => (resolve = r));

    async function* gen(): AsyncIterable<QwenChunk> {
      yield { phase: "answer", content: "before-stall" };
      await blocker; // stall for >30s
      yield { phase: "answer", content: "after-stall" };
      yield { done: true };
    }

    const iter = streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 });
    const collected: string[] = [];

    const consumePromise = (async () => {
      for await (const chunk of iter) {
        collected.push(chunk);
      }
    })();

    // Let initial events (message_start, content_block_start, first delta) drain
    await vi.advanceTimersByTimeAsync(0);

    // Advance 30s — fires a ping while upstream is stalled
    await vi.advanceTimersByTimeAsync(30_000);

    // Unblock the upstream
    resolve!();
    await consumePromise;

    const allOutput = collected.join("");
    const events = parseEvents(allOutput);

    // Ping must be present
    const pingEvents = events.filter((e) => e.event === "ping");
    expect(pingEvents.length).toBeGreaterThanOrEqual(1);

    // CRITICAL: "after-stall" text must NOT be lost
    const textDeltas = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data as any)
      .filter((d) => d.delta?.type === "text_delta")
      .map((d) => d.delta.text);

    const allText = textDeltas.join("");
    expect(allText).toContain("before-stall");
    expect(allText).toContain("after-stall");
  });
});
