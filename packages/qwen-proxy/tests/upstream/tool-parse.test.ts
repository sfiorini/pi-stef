import { describe, it, expect } from "vitest";
import { parseToolCalls } from "../../src/upstream/tool-parse";

describe("parseToolCalls", () => {
  it("returns null content and null toolCalls when no <tool_calls> tag", () => {
    const result = parseToolCalls("Hello, how can I help?");
    expect(result.content).toBe("Hello, how can I help?");
    expect(result.toolCalls).toBeNull();
  });

  it("parses a single tool call from <tool_calls> block", () => {
    const text = `<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}}]</tool_calls>`;
    const result = parseToolCalls(text);
    expect(result.content).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({
      type: "function",
      function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
    });
    expect(result.toolCalls![0].id).toMatch(/^call_/);
  });

  it("parses multiple parallel tool calls", () => {
    const text = `<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}},{"name":"calculate","arguments":{"expression":"2+2"}}]</tool_calls>`;
    const result = parseToolCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].function.name).toBe("get_weather");
    expect(result.toolCalls![1].function.name).toBe("calculate");
  });

  it("strips <tool_calls> spans from content", () => {
    const text = `Here is what I found:\n<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}}]</tool_calls>\nDone.`;
    const result = parseToolCalls(text);
    expect(result.content).toBe("Here is what I found:\n\nDone.");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("handles malformed JSON with lenient bracket-depth fallback", () => {
    // Missing closing bracket inside arguments — lenient should still parse individual objects
    const text = `<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}},{"name":"broken","arguments":{"bad":true}}]</tool_calls>`;
    const result = parseToolCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].function.name).toBe("get_weather");
    expect(result.toolCalls![1].function.name).toBe("broken");
  });

  it("returns empty toolCalls for empty <tool_calls>[] block", () => {
    const text = `<tool_calls>[]</tool_calls>`;
    const result = parseToolCalls(text);
    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual([]);
  });

  it("handles multiple <tool_calls> blocks", () => {
    const text = `<tool_calls>[{"name":"a","arguments":{}}]</tool_calls> text <tool_calls>[{"name":"b","arguments":{}}]</tool_calls>`;
    const result = parseToolCalls(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].function.name).toBe("a");
    expect(result.toolCalls![1].function.name).toBe("b");
    expect(result.content).toBe("text");
  });

  it("handles string arguments (pre-stringified JSON)", () => {
    const text = `<tool_calls>[{"name":"get_weather","arguments":"{\\"location\\":\\"Tokyo\\"}"}]</tool_calls>`;
    const result = parseToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].function.arguments).toBe('{"location":"Tokyo"}');
  });

  it("handles nested JSON in arguments", () => {
    const text = `<tool_calls>[{"name":"search","arguments":{"query":"test","filters":{"min":1,"max":10}}}]</tool_calls>`;
    const result = parseToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    const args = JSON.parse(result.toolCalls![0].function.arguments);
    expect(args.filters.min).toBe(1);
    expect(args.filters.max).toBe(10);
  });

  it("generates unique call IDs for each tool call", () => {
    const text = `<tool_calls>[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]</tool_calls>`;
    const result = parseToolCalls(text);
    expect(result.toolCalls![0].id).not.toBe(result.toolCalls![1].id);
    expect(result.toolCalls![0].id).toMatch(/^call_/);
    expect(result.toolCalls![1].id).toMatch(/^call_/);
  });
});
