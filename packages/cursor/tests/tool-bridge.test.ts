import { describe, it, expect } from "vitest";
import {
  buildCustomTools,
  type SDKCustomTool,
  type ToolCallEmitter,
} from "../src/tool-bridge.js";
import { createToolResultBridge } from "../src/tool-result-bridge.js";

// Minimal pi tool shape matching context.tools
interface PiTool {
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

function makeEmitter(): ToolCallEmitter & { calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = [];
  return {
    calls,
    start(id: string, name: string, argsJson: string) { calls.push(["start", id, `${name}:${argsJson}`]); },
    delta(_id: string, _argsJson: string) { /* noop */ },
  };
}

describe("buildCustomTools", () => {
  it("empty/undefined tools returns {}", () => {
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    expect(buildCustomTools([], bridge, emit)).toEqual({});
    expect(buildCustomTools(undefined as unknown as PiTool[], bridge, emit)).toEqual({});
  });

  it("one tool -> pi__<name> with description + inputSchema", () => {
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [
      {
        function: {
          name: "read_file",
          description: "Read a file from disk",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ];

    const result = buildCustomTools(tools, bridge, emit);
    expect(Object.keys(result)).toEqual(["pi__read_file"]);

    const tool = result["pi__read_file"] as SDKCustomTool;
    expect(tool.description).toBe("Read a file from disk");
    expect(tool.inputSchema).toEqual({ type: "object", properties: { path: { type: "string" } } });
  });

  it("execute calls emit.start + emit.delta then returns pending promise", async () => {
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [
      { function: { name: "shell", description: "Run a shell command" } },
    ];

    const result = buildCustomTools(tools, bridge, emit);
    const tool = result["pi__shell"] as SDKCustomTool;

    const args = { cmd: "ls -la" };
    const promise = Promise.resolve(tool.execute(args, { toolCallId: "tc-1" }));

    // emit.start was called
    expect(emit.calls[0]).toEqual(["start", "tc-1", `shell:${JSON.stringify(args)}`]);

    // The returned promise should NOT be resolved yet (it's the bridge's pending promise)
    let resolved = false;
    promise.then(() => { resolved = true; });

    // Give microtask a chance
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);

    // Now resolve via bridge
    bridge.resolveFromToolResults([{ toolCallId: "tc-1", text: "output here" }]);

    const sdkResult = await promise;
    expect(sdkResult).toEqual({
      content: [{ type: "text", text: "output here" }],
    });
  });

  it("bridge rejection -> execute resolves to isError: true (caught)", async () => {
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [
      { function: { name: "shell" } },
    ];

    const result = buildCustomTools(tools, bridge, emit);
    const tool = result["pi__shell"] as SDKCustomTool;

    const promise = tool.execute({ cmd: "bad" }, { toolCallId: "tc-err" });

    // Reject the bridge
    bridge.rejectAll(new Error("connection lost"));

    const sdkResult = (await promise) as { content: Array<{ type: "text"; text: string }>; isError: boolean };
    expect(sdkResult.isError).toBe(true);
    expect(sdkResult.content[0].text).toBe("connection lost");
  });

  it("tool with no parameters -> no inputSchema", () => {
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [
      { function: { name: "list_dir" } },
    ];

    const result = buildCustomTools(tools, bridge, emit);
    const tool = result["pi__list_dir"] as SDKCustomTool;
    expect(tool.description).toBeUndefined();
    expect(tool.inputSchema).toBeUndefined();
  });
});
