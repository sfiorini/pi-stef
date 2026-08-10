import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StreamChunk } from "../../../src/pool/retry";
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

/** Helper: make an OpenAiChatChunk with delta fields */
function ck(delta?: { content?: string; reasoning_content?: string; role?: string }, finish_reason?: string | null, usage?: { prompt_tokens?: number; completion_tokens?: number }): StreamChunk {
  return {
    choices: [{ delta, finish_reason: finish_reason ?? undefined }],
    ...(usage ? { usage } : {}),
  } as StreamChunk;
}

/** Helper: make the done sentinel */
function doneSentinel(extra?: { rateLimited?: boolean }): StreamChunk {
  return { done: true, ...(extra ? { extra } : {}) } as StreamChunk;
}

/** Extract all text_delta texts joined + all thinking_delta texts joined from collected output */
function extractContent(output: string): { text: string; thinking: string; events: Array<{ event: string; data: unknown }> } {
  const events = parseEvents(output);
  const textParts = events
    .filter((e) => e.event === "content_block_delta")
    .map((e) => e.data as any)
    .filter((d) => d.delta?.type === "text_delta")
    .map((d) => d.delta.text);
  const thinkParts = events
    .filter((e) => e.event === "content_block_delta")
    .map((e) => e.data as any)
    .filter((d) => d.delta?.type === "thinking_delta")
    .map((d) => d.delta.thinking);
  return { text: textParts.join(""), thinking: thinkParts.join(""), events };
}

describe("streamAnthropicEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1: think→text emits signature_delta + stop + start with correct indices ──

  it("think→answer emits signature_delta + stop + start with correct indices", async () => {
    // Use text > 9 chars so the stripper emits immediately (holdback = 9)
    const chunks: StreamChunk[] = [
      ck({ reasoning_content: "Let me" }),
      ck({ reasoning_content: " think" }),
      ck({ content: "Hello world! This is a long message." }),
      ck(undefined, "stop", { prompt_tokens: 10, completion_tokens: 5 }),
      doneSentinel(),
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

    // Content text + terminal events — stripper holds back 9 chars so text
    // will appear across delta + finalize flush. Aggregate all text.
    const { text: allText } = extractContent(output);
    expect(allText).toBe("Hello world! This is a long message.");

    // content_block_stop index 1
    const stopEvents = events.filter((e) => e.event === "content_block_stop");
    expect(stopEvents).toHaveLength(2);
    expect(stopEvents[1]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 1 },
    });

    // message_delta with stop_reason
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta).toBeDefined();
    expect((msgDelta!.data as any).delta.stop_reason).toBe("end_turn");
    expect((msgDelta!.data as any).usage.output_tokens).toBe(5);

    // message_stop
    expect(events[events.length - 1].event).toBe("message_stop");
  });

  // ── 2: text-only → text block at index 0 ──

  it("no-think → text block at index 0", async () => {
    // Use text > 9 chars so stripper emits
    const chunks: StreamChunk[] = [
      ck({ content: "Direct answer is here with enough text." }),
      ck(undefined, "stop", { prompt_tokens: 5, completion_tokens: 3 }),
      doneSentinel(),
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

    // Aggregate all text content (stripper buffers last 9 chars)
    const { text: allText } = extractContent(output);
    expect(allText).toBe("Direct answer is here with enough text.");

    // content_block_stop index 0
    const stopEvents = events.filter((e) => e.event === "content_block_stop");
    expect(stopEvents).toHaveLength(1);
    expect(stopEvents[0]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    });

    // message_delta
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta!.data as any).delta.stop_reason).toBe("end_turn");
    expect((msgDelta!.data as any).usage.output_tokens).toBe(3);

    // message_stop
    expect(events[events.length - 1].event).toBe("message_stop");
  });

  // ── 3: think-only → terminal signature_delta + stop ──

  it("think-only then done → terminal signature_delta + content_block_stop", async () => {
    const chunks: StreamChunk[] = [
      ck({ reasoning_content: "Thinking..." }),
      ck(undefined, "stop", { prompt_tokens: 5, completion_tokens: 1 }),
      doneSentinel(),
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
    // terminal signature_delta
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

  // ── 4: <details> split across text deltas is stripped ──

  it("<details> split across text deltas is stripped via DetailsStreamStripper", async () => {
    // Simulate <details> tag split across multiple content chunks
    // Use enough real text before <details> so the stripper can emit it
    const chunks: StreamChunk[] = [
      ck({ content: "Hello world! More text here." }),
      ck({ content: "<det" }),
      ck({ content: "ails>foo</details>" }),
      ck(undefined, "stop", { prompt_tokens: 1, completion_tokens: 1 }),
      doneSentinel(),
    ];

    async function* gen() {
      for (const c of chunks) yield c;
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 }),
    );

    const { text: allText } = extractContent(output);
    expect(allText).toBe("Hello world! More text here.");
    // The <details> junk must be stripped
    expect(allText).not.toContain("<details>");
  });

  // ── 5: sentinel → terminal error event ──

  it("sentinel with rateLimited → terminal error event + terminate", async () => {
    // Need enough content so the stripper emits before the sentinel
    async function* gen(): AsyncIterable<StreamChunk> {
      yield ck({ content: "enough content to pass the holdback" });
      yield doneSentinel({ rateLimited: true });
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 }),
    );
    const events = parseEvents(output);

    // Should have message_start, content_block_start, text_delta, then error
    expect(events[0].event).toBe("message_start");
    expect(events[1].event).toBe("content_block_start");

    // Some text delta(s) may or may not appear depending on holdback —
    // but error must be present
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

  // ── 6: bare done (no extra) → break cleanly with terminal events ──

  it("bare done (no extra) → clean break with terminal events", async () => {
    async function* gen(): AsyncIterable<StreamChunk> {
      yield ck({ content: "enough text for stripper to emit" });
      yield doneSentinel();
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 }),
    );
    const events = parseEvents(output);

    // message_start → content_block_start → text_delta(s) → content_block_stop → message_delta → message_stop
    expect(events[0].event).toBe("message_start");
    expect(events[1].event).toBe("content_block_start");

    // Text content present
    const { text: allText } = extractContent(output);
    expect(allText).toBe("enough text for stripper to emit");

    // Terminal events
    const stopEvents = events.filter((e) => e.event === "content_block_stop");
    expect(stopEvents).toHaveLength(1);
    expect(events.find((e) => e.event === "message_delta")).toBeDefined();
    expect(events[events.length - 1].event).toBe("message_stop");

    // No error event
    expect(events.find((e) => e.event === "error")).toBeUndefined();
  });

  // ── 7: 30s ping ──

  it("30s idle → ping event", async () => {
    let resolve: () => void;
    const blocker = new Promise<void>((r) => (resolve = r));

    async function* gen(): AsyncIterable<StreamChunk> {
      yield ck({ content: "first" });
      await blocker;
      yield doneSentinel();
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

  // ── 8: usage.completion_tokens → output_tokens ──

  it("usage.completion_tokens maps to output_tokens in message_delta", async () => {
    async function* gen(): AsyncIterable<StreamChunk> {
      yield ck({ content: "enough content" });
      yield ck(undefined, "stop", { prompt_tokens: 10, completion_tokens: 42 });
      yield doneSentinel();
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 10 }),
    );
    const events = parseEvents(output);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta!.data as any).usage.output_tokens).toBe(42);
  });

  // ── 9: finish_reason mapping ──

  it("finish_reason: length → max_tokens", async () => {
    async function* gen(): AsyncIterable<StreamChunk> {
      yield ck({ content: "enough content" });
      yield ck(undefined, "length", { prompt_tokens: 1, completion_tokens: 1 });
      yield doneSentinel();
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 }),
    );
    const events = parseEvents(output);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta!.data as any).delta.stop_reason).toBe("max_tokens");
  });

  it("finish_reason: stop_sequence → stop_sequence", async () => {
    async function* gen(): AsyncIterable<StreamChunk> {
      yield ck({ content: "enough content" });
      yield ck(undefined, "stop_sequence", { prompt_tokens: 1, completion_tokens: 1 });
      yield doneSentinel();
    }

    const output = await collectEvents(
      streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 }),
    );
    const events = parseEvents(output);
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta!.data as any).delta.stop_reason).toBe("stop_sequence");
  });

  // ── 10: A2: ping must NOT drop the first post-stall chunk ──

  it("A2: 30s ping does NOT drop the first post-stall content chunk", async () => {
    let resolve: () => void;
    const blocker = new Promise<void>((r) => (resolve = r));

    async function* gen(): AsyncIterable<StreamChunk> {
      yield ck({ content: "before-stall-text" });
      await blocker;
      yield ck({ content: "after-stall-text" });
      yield doneSentinel();
    }

    const iter = streamAnthropicEvents(gen(), { model: "qwen3-max", inputTokens: 1 });
    const collected: string[] = [];

    const consumePromise = (async () => {
      for await (const chunk of iter) {
        collected.push(chunk);
      }
    })();

    // Let initial events drain
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

    // CRITICAL: text must NOT be lost — aggregate all text deltas + finalize flush
    const { text: allText } = extractContent(allOutput);
    expect(allText).toContain("before-stall-text");
    expect(allText).toContain("after-stall-text");
  });
});
