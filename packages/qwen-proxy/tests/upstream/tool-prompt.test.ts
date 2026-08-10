import { describe, it, expect } from "vitest";
import {
  injectToolPrompt,
  injectToolResults,
  prependToFirstSystemMessage,
} from "../../src/upstream/tool-prompt";

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
};

const calculatorTool = {
  type: "function",
  function: {
    name: "calculate",
    description: "Evaluate a math expression",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string" },
      },
      required: ["expression"],
    },
  },
};

describe("injectToolPrompt", () => {
  it("returns empty string when tools array is empty", () => {
    expect(injectToolPrompt([], "auto")).toBe("");
  });

  it("returns empty string when tool_choice is 'none'", () => {
    expect(injectToolPrompt([weatherTool], "none")).toBe("");
  });

  it("returns empty string when there are no function tools", () => {
    expect(injectToolPrompt([{ type: "web_search" }], "auto")).toBe("");
  });

  it("returns empty string for undefined tool_choice with function tools (defaults to auto)", () => {
    // undefined tool_choice treated as "auto" — should inject
    const result = injectToolPrompt([weatherTool], undefined);
    expect(result).toContain("get_weather");
  });

  it("auto tool_choice: includes 'You MAY call' guidance", () => {
    const result = injectToolPrompt([weatherTool], "auto");
    expect(result).toContain("You MAY");
    expect(result).toContain("get_weather");
    expect(result).toContain("Get the current weather");
    expect(result).toContain("<tool_calls>");
  });

  it("required tool_choice: includes 'You MUST call at least one' guidance", () => {
    const result = injectToolPrompt([weatherTool], "required");
    expect(result).toContain("You MUST call at least one");
  });

  it("specific function tool_choice: includes 'You MUST call the tool' guidance", () => {
    const result = injectToolPrompt(
      [weatherTool, calculatorTool],
      { function: { name: "get_weather" } },
    );
    expect(result).toContain("You MUST call the tool `get_weather`");
  });

  it("renders multiple tools with names, descriptions, parameters", () => {
    const result = injectToolPrompt([weatherTool, calculatorTool], "auto");
    expect(result).toContain("get_weather");
    expect(result).toContain("calculate");
    expect(result).toContain("Get the current weather");
    expect(result).toContain("Evaluate a math expression");
    expect(result).toContain('"location"');
    expect(result).toContain('"expression"');
  });

  it("includes the <tool_calls> format example in the prompt", () => {
    const result = injectToolPrompt([weatherTool], "auto");
    expect(result).toContain('<tool_calls>[{"name":"');
    expect(result).toContain('"arguments":{');
    expect(result).toContain("}]</tool_calls>");
  });

  it("ignores non-function tools in the tools array", () => {
    const result = injectToolPrompt(
      [{ type: "web_search" }, weatherTool],
      "auto",
    );
    expect(result).toContain("get_weather");
    expect(result).not.toContain("web_search");
  });
});

describe("injectToolResults", () => {
  it("returns new array without mutating original", () => {
    const msgs = [{ role: "user", content: "hi" }];
    const result = injectToolResults(msgs);
    expect(result).not.toBe(msgs);
    expect(msgs[0].role).toBe("user"); // original unchanged
  });

  it("rewrites role:'tool' to role:'system' with Tool prefix", () => {
    const msgs = [
      { role: "tool", name: "get_weather", tool_call_id: "call_abc", content: '{"temp":72}' },
    ];
    const result = injectToolResults(msgs);
    expect(result).toEqual([
      {
        role: "system",
        content: 'Tool `get_weather` returned: {"temp":72}',
      },
    ]);
  });

  it("resolves tool name from tool_call_id using assistant message", () => {
    const msgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_abc", type: "function", function: { name: "get_weather", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: '{"temp":72}' },
    ];
    const result = injectToolResults(msgs);
    // assistant message → tool_calls text
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toContain("<tool_calls>");
    expect(result[0].content).toContain("get_weather");
    // tool message → system
    expect(result[1]).toEqual({
      role: "system",
      content: 'Tool `get_weather` returned: {"temp":72}',
    });
  });

  it("rewrites assistant tool_calls to <tool_calls> text block", () => {
    const msgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"location":"Tokyo"}' } },
          { id: "call_2", type: "function", function: { name: "calculate", arguments: '{"expression":"2+2"}' } },
        ],
      },
    ];
    const result = injectToolResults(msgs);
    expect(result[0].role).toBe("assistant");
    const parsed = JSON.parse(
      (result[0].content as string).match(/<tool_calls>([\s\S]*?)<\/tool_calls>/)?.[1] ?? "[]",
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("get_weather");
    expect(parsed[1].name).toBe("calculate");
  });

  it("preserves non-tool messages unchanged", () => {
    const msgs = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    const result = injectToolResults(msgs);
    expect(result).toEqual(msgs);
  });

  it("resolves name from explicit name field when no tool_call_id map", () => {
    const msgs = [
      { role: "tool", name: "custom_tool", content: "result" },
    ];
    const result = injectToolResults(msgs);
    expect(result[0]).toEqual({
      role: "system",
      content: "Tool `custom_tool` returned: result",
    });
  });

  it("flattens array content [{type:text,text}] to string in pass-through", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const result = injectToolResults(msgs);
    expect(result[0].content).toBe("hello");
  });

  it("flattens array content in tool-result messages", () => {
    const msgs = [
      { role: "tool", name: "get_weather", content: [{ type: "text", text: '{"temp":25}' }] },
    ];
    const result = injectToolResults(msgs);
    expect(result[0].content).toBe('Tool `get_weather` returned: {"temp":25}');
  });

  it("handles multiple tool results interleaved with assistant", () => {
    const msgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "get_weather", arguments: '{}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: '{"temp":72}' },
      { role: "user", content: "Thanks" },
    ];
    const result = injectToolResults(msgs);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("assistant");
    expect(result[1].role).toBe("system");
    expect(result[2].role).toBe("user");
  });

  // F1: malformed JSON in tool_calls arguments should not throw
  it("does not throw when tool_calls arguments is malformed JSON (F1)", () => {
    const msgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: { name: "x", arguments: "{bad json" },
          },
        ],
      },
    ];
    expect(() => injectToolResults(msgs)).not.toThrow();
    const result = injectToolResults(msgs);
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toContain("<tool_calls>");
    expect(result[0].content).toContain("{bad json");
    expect(result[0].content).toContain("</tool_calls>");
  });

  // F3: assistant with both content AND tool_calls should preserve both
  it("preserves assistant content when tool_calls are also present (F3)", () => {
    const msgs = [
      {
        role: "assistant",
        content: "Let me check the weather.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
          },
        ],
      },
    ];
    const result = injectToolResults(msgs);
    expect(result[0].role).toBe("assistant");
    // Original text must be preserved
    expect(result[0].content).toContain("Let me check the weather.");
    // Tool calls block must also be present
    expect(result[0].content).toContain("<tool_calls>");
    expect(result[0].content).toContain("get_weather");
    // Original content comes before tool_calls
    const textIdx = (result[0].content as string).indexOf("Let me check the weather.");
    const tcIdx = (result[0].content as string).indexOf("<tool_calls>");
    expect(textIdx).toBeLessThan(tcIdx);
  });
});

describe("prependToFirstSystemMessage", () => {
  it("prepends block to existing system message", () => {
    const msgs: { role: string; content: string }[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    prependToFirstSystemMessage(msgs, "[TOOLS] ");
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toBe("[TOOLS] You are helpful.");
  });

  it("inserts new system message at index 0 when none exists", () => {
    const msgs: { role: string; content: string }[] = [
      { role: "user", content: "Hi" },
    ];
    prependToFirstSystemMessage(msgs, "[TOOLS]");
    expect(msgs[0]).toEqual({ role: "system", content: "[TOOLS]" });
    expect(msgs[1].role).toBe("user");
  });

  it("mutates the array in place", () => {
    const msgs: { role: string; content: string }[] = [
      { role: "system", content: "test" },
    ];
    const ref = msgs;
    prependToFirstSystemMessage(msgs, "prefix-");
    expect(ref[0].content).toBe("prefix-test");
  });

  it("handles empty messages array", () => {
    const msgs: { role: string; content: string }[] = [];
    prependToFirstSystemMessage(msgs, "[TOOLS]");
    expect(msgs[0]).toEqual({ role: "system", content: "[TOOLS]" });
  });
});
