import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  mapUpstreamDeltaToOpenAI,
  extractReasoningContentFromDelta,
  mapUsageToOpenAI,
  isDataInspectionFailed,
  translateQwenSse,
} from "../../src/upstream/qwen-sse";
import { ClientError } from "../../src/upstream/errors";

// ── mapUpstreamDeltaToOpenAI ─────────────────────────────────────────────

describe("mapUpstreamDeltaToOpenAI", () => {
  it("copies role only if assistant", () => {
    const result = mapUpstreamDeltaToOpenAI({ role: "assistant", content: "hi" });
    expect(result).toEqual({ role: "assistant", content: "hi" });
  });

  it("strips non-assistant role", () => {
    const result = mapUpstreamDeltaToOpenAI({ role: "user", content: "hi" });
    expect(result).toEqual({ content: "hi" });
  });

  it("returns null for empty delta", () => {
    const result = mapUpstreamDeltaToOpenAI({});
    expect(result).toBeNull();
  });

  it("passes through content string", () => {
    const result = mapUpstreamDeltaToOpenAI({ content: "Hello" });
    expect(result).toEqual({ content: "Hello" });
  });

  it("includes reasoning_content when present", () => {
    const result = mapUpstreamDeltaToOpenAI({ reasoning_content: "thinking..." });
    expect(result).toEqual({ reasoning_content: "thinking..." });
  });
});

// ── extractReasoningContentFromDelta ─────────────────────────────────────

describe("extractReasoningContentFromDelta", () => {
  it("P1: returns delta.reasoning_content", () => {
    expect(extractReasoningContentFromDelta({ reasoning_content: "thought" })).toBe("thought");
  });

  it("P1: falls back to delta.reasoning", () => {
    expect(extractReasoningContentFromDelta({ reasoning: "fallback" })).toBe("fallback");
  });

  it("P2: joins thinking_summary content array", () => {
    const delta = {
      phase: "thinking_summary",
      extra: {
        summary_thought: {
          content: [{ text: "step one" }, { text: "step two" }],
        },
      },
    };
    expect(extractReasoningContentFromDelta(delta)).toBe("step one\nstep two");
  });

  it("P2: handles string items in summary_thought.content", () => {
    const delta = {
      phase: "thinking_summary",
      extra: {
        summary_thought: {
          content: ["plain string", { text: "object text" }],
        },
      },
    };
    expect(extractReasoningContentFromDelta(delta)).toBe("plain string\nobject text");
  });

  it("returns empty string when no reasoning present", () => {
    expect(extractReasoningContentFromDelta({ content: "hi" })).toBe("");
  });
});

// ── mapUsageToOpenAI ─────────────────────────────────────────────────────

describe("mapUsageToOpenAI", () => {
  it("maps input_tokens → prompt_tokens, output_tokens → completion_tokens", () => {
    const result = mapUsageToOpenAI({ input_tokens: 10, output_tokens: 20 });
    expect(result).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  });

  it("uses total_tokens when present", () => {
    const result = mapUsageToOpenAI({ input_tokens: 10, output_tokens: 20, total_tokens: 99 });
    expect(result).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 99 });
  });

  it("sums when total_tokens absent", () => {
    const result = mapUsageToOpenAI({ input_tokens: 5, output_tokens: 3 });
    expect(result.total_tokens).toBe(8);
  });

  it("copies token details", () => {
    const result = mapUsageToOpenAI({
      input_tokens: 10,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 8 },
    });
    expect(result.prompt_tokens_details).toEqual({ cached_tokens: 5 });
    expect(result.completion_tokens_details).toEqual({ reasoning_tokens: 8 });
  });

  it("defaults to 0 when missing", () => {
    const result = mapUsageToOpenAI({});
    expect(result).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

// ── isDataInspectionFailed ───────────────────────────────────────────────

describe("isDataInspectionFailed", () => {
  it("returns true when data_inspection_failed is true", () => {
    expect(isDataInspectionFailed({ data_inspection_failed: true })).toBe(true);
  });

  it("returns false when absent", () => {
    expect(isDataInspectionFailed({ something: "else" })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isDataInspectionFailed(null)).toBe(false);
    expect(isDataInspectionFailed(undefined)).toBe(false);
  });
});

// ── translateQwenSse ─────────────────────────────────────────────────────

describe("translateQwenSse", () => {
  function loadFixture(name: string): ReadableStream<Uint8Array> {
    const filePath = path.join(__dirname, "fixtures", name);
    const content = fs.readFileSync(filePath, "utf-8");
    const encoder = new TextEncoder();
    const bytes = encoder.encode(content);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  it("yields reasoning_content then content, no finish_reason, usage last", async () => {
    const stream = loadFixture("qwen-stream-thinking.txt");
    const chunks: any[] = [];
    for await (const chunk of translateQwenSse(stream)) {
      chunks.push(chunk);
    }

    // Should have 4 chunks: 2 reasoning, 2 content, 1 usage
    // (each SSE data line yields a chunk)
    expect(chunks.length).toBeGreaterThanOrEqual(4);

    // First two chunks should have reasoning_content
    expect(chunks[0].choices[0].delta.reasoning_content).toBeTruthy();
    expect(chunks[1].choices[0].delta.reasoning_content).toBeTruthy();

    // Next two should have content
    expect(chunks[2].choices[0].delta.content).toBe("Hello ");
    expect(chunks[3].choices[0].delta.content).toBe("world");

    // No chunk should have finish_reason
    for (const chunk of chunks) {
      expect(chunk.choices[0].finish_reason).toBeUndefined();
    }

    // Usage chunk should be last (or second-to-last before [DONE] terminated)
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk).toBeDefined();
    expect(usageChunk!.usage.prompt_tokens).toBe(5);
    expect(usageChunk!.usage.completion_tokens).toBe(2);

    // Last chunk with usage
    const lastWithUsage = chunks[chunks.length - 1];
    expect(lastWithUsage.usage).toBeDefined();
  });

  it("terminates on [DONE]", async () => {
    const stream = loadFixture("qwen-stream-thinking.txt");
    const chunks: any[] = [];
    for await (const chunk of translateQwenSse(stream)) {
      chunks.push(chunk);
    }
    // [DONE] should not be yielded
    expect(chunks.every((c) => c !== "[DONE]")).toBe(true);
  });

  it("skips non-JSON data lines", async () => {
    const content = "data: not-json\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n";
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(content));
        controller.close();
      },
    });
    const chunks: any[] = [];
    for await (const chunk of translateQwenSse(stream)) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBe(1);
    expect(chunks[0].choices[0].delta.content).toBe("ok");
  });

  it("throws ClientError(400) on data_inspection_failed (content moderation, not a rate limit)", async () => {
    const content = 'data: {"data_inspection_failed":true}\n\ndata: [DONE]\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(content));
        controller.close();
      },
    });
    let caught: unknown;
    try {
      for await (const _ of translateQwenSse(stream)) {
        // should throw before yielding
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).status).toBe(400);
  });
});
