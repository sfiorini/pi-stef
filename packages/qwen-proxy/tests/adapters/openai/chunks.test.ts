import { describe, it, expect } from "vitest";
import { firstChunk, mapOpenAiChunk, TERMINATOR } from "../../../src/adapters/openai/chunks";

describe("firstChunk", () => {
  it("returns the initial chunk with delta.role = assistant", () => {
    const chunk = firstChunk("chatcmpl-1", 1700000000, "qwen3-max");
    expect(chunk).toEqual({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "qwen3-max",
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          logprobs: null,
          finish_reason: null,
        },
      ],
    });
  });
});

describe("mapOpenAiChunk", () => {
  it("maps a content chunk with delta.content", () => {
    const result = mapOpenAiChunk(
      { choices: [{ delta: { content: "Hello" } }] },
      "chatcmpl-1",
      1700000000,
      "qwen3-max",
    );
    expect(result).toEqual({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "qwen3-max",
      choices: [
        {
          index: 0,
          delta: { content: "Hello" },
          logprobs: null,
          finish_reason: null,
        },
      ],
    });
  });

  it("maps a reasoning_content chunk", () => {
    const result = mapOpenAiChunk(
      { choices: [{ delta: { reasoning_content: "Let me think..." } }] },
      "chatcmpl-1",
      1700000000,
      "qwen3-max",
    );
    expect(result.choices[0].delta).toEqual({ reasoning_content: "Let me think..." });
  });

  it("maps a finish_reason chunk", () => {
    const result = mapOpenAiChunk(
      { choices: [{ finish_reason: "stop" }] },
      "chatcmpl-1",
      1700000000,
      "qwen3-max",
    );
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.choices[0].delta).toEqual({});
  });

  it("includes usage when present", () => {
    const result = mapOpenAiChunk(
      { choices: [{ delta: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      "chatcmpl-1",
      1700000000,
      "qwen3-max",
    );
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("omits usage when absent", () => {
    const result = mapOpenAiChunk(
      { choices: [{ delta: { content: "x" } }] },
      "chatcmpl-1",
      1700000000,
      "qwen3-max",
    );
    expect(result).not.toHaveProperty("usage");
  });

  it("defaults choice index to 0 when absent", () => {
    const result = mapOpenAiChunk(
      { choices: [{ delta: { content: "x" } }] },
      "chatcmpl-1",
      1700000000,
      "qwen3-max",
    );
    expect(result.choices[0].index).toBe(0);
  });

  it("preserves choice index when present", () => {
    const result = mapOpenAiChunk(
      { choices: [{ index: 2, delta: { content: "x" } }] },
      "chatcmpl-1",
      1700000000,
      "qwen3-max",
    );
    expect(result.choices[0].index).toBe(2);
  });

  it("handles empty choices array (no choices)", () => {
    const result = mapOpenAiChunk(
      { choices: [] },
      "chatcmpl-1",
      1700000000,
      "qwen3-max",
    );
    // With empty choices, choice is undefined → index defaults to 0, delta defaults to {}
    expect(result.choices[0].index).toBe(0);
    expect(result.choices[0].delta).toEqual({});
    expect(result.choices[0].finish_reason).toBeNull();
  });

  it("always includes logprobs as null", () => {
    const result = mapOpenAiChunk(
      { choices: [{ delta: { content: "x" } }] },
      "chatcmpl-1",
      1700000000,
      "qwen3-max",
    );
    expect(result.choices[0].logprobs).toBeNull();
  });
});

describe("TERMINATOR", () => {
  it("is the [DONE] SSE line", () => {
    expect(TERMINATOR).toBe("data: [DONE]\n\n");
  });
});
