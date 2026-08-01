import { describe, it, expect, vi } from "vitest";
import {
  buildCustomTools,
  CURSOR_BUILTIN_TOOLS,
  type SDKCustomTool,
  type ToolCallEmitter,
} from "../src/tool-bridge.js";
import { createToolResultBridge } from "../src/tool-result-bridge.js";

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

  it("CURSOR_BUILTIN_TOOLS contains exactly the 12 sourced Cursor built-in names", () => {
    expect([...CURSOR_BUILTIN_TOOLS].sort()).toEqual([
      "codebase_search", "delete_file", "diff_history", "edit_file", "fetch_rules",
      "file_search", "grep_search", "list_dir", "read_file", "reapply",
      "run_terminal_cmd", "web_search",
    ]);
  });

  it("one tool -> name-keyed entry with description + inputSchema", () => {
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [{
      function: { name: "read", description: "Read a file from disk",
        parameters: { type: "object", properties: { path: { type: "string" } } } },
    }];
    const result = buildCustomTools(tools, bridge, emit);
    expect(Object.keys(result)).toEqual(["read"]);
    const tool = result["read"] as SDKCustomTool;
    expect(tool.description).toBe("Read a file from disk");
    expect(tool.inputSchema).toEqual({ type: "object", properties: { path: { type: "string" } } });
  });

  it("execute calls emit.start + emit.delta then returns pending promise", async () => {
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [{ function: { name: "shell", description: "Run a shell command" } }];
    const result = buildCustomTools(tools, bridge, emit);
    const tool = result["shell"] as SDKCustomTool;
    const args = { cmd: "ls -la" };
    const promise = Promise.resolve(tool.execute(args, { toolCallId: "tc-1" }));
    expect(emit.calls[0]).toEqual(["start", "tc-1", `shell:${JSON.stringify(args)}`]);
    let resolved = false;
    promise.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(resolved).toBe(false);
    bridge.resolveFromToolResults([{ toolCallId: "tc-1", text: "output here" }]);
    const sdkResult = await promise;
    expect(sdkResult).toEqual({ content: [{ type: "text", text: "output here" }] });
  });

  it("bridge rejection -> execute resolves to isError: true (caught)", async () => {
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [{ function: { name: "shell" } }];
    const result = buildCustomTools(tools, bridge, emit);
    const tool = result["shell"] as SDKCustomTool;
    const promise = tool.execute({ cmd: "bad" }, { toolCallId: "tc-err" });
    bridge.rejectAll(new Error("connection lost"));
    const sdkResult = (await promise) as { content: Array<{ type: "text"; text: string }>; isError: boolean };
    expect(sdkResult.isError).toBe(true);
    expect(sdkResult.content[0].text).toBe("connection lost");
  });

  it("tool with no parameters -> no inputSchema", () => {
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [{ function: { name: "glob" } }];
    const result = buildCustomTools(tools, bridge, emit);
    const tool = result["glob"] as SDKCustomTool;
    expect(tool.description).toBeUndefined();
    expect(tool.inputSchema).toBeUndefined();
  });

  it("tool name colliding with builtins set is skipped and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [{ function: { name: "read_file" } }];
    const result = buildCustomTools(tools, bridge, emit, new Set(["read_file"]));
    expect(Object.keys(result)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("read_file");
    warn.mockRestore();
  });

  it("default builtins set (3-arg call) skips a Cursor built-in name and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [{ function: { name: "read_file", description: "Read" } }];

    // 3-arg call — exercises the production default (CURSOR_BUILTIN_TOOLS)
    const result = buildCustomTools(tools, bridge, emit);

    expect(Object.keys(result)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("read_file");
    warn.mockRestore();
  });

  it("tool name not in explicit builtins set is registered and does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [{ function: { name: "shell" } }];
    const result = buildCustomTools(tools, bridge, emit, new Set(["read_file"]));
    expect(Object.keys(result)).toEqual(["shell"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("mixed list: only non-colliding tools registered, one warn per collision", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = createToolResultBridge();
    const emit = makeEmitter();
    const tools: PiTool[] = [
      { function: { name: "read_file" } },
      { function: { name: "list_dir" } },
      { function: { name: "shell" } },
    ];
    const result = buildCustomTools(tools, bridge, emit, new Set(["read_file", "list_dir"]));
    expect(Object.keys(result)).toEqual(["shell"]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
