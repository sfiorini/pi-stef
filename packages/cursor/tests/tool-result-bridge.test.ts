import { describe, it, expect } from "vitest";
import {
  createToolResultBridge,
} from "../src/tool-result-bridge.js";

const argsJson = `{"path":"/tmp"}`;

describe("createToolResultBridge", () => {
  it("pending -> resolveFromToolResults returns result", async () => {
    const bridge = createToolResultBridge();
    const promise = bridge.pending("call-1", "read_file", argsJson);

    expect(bridge.hasPending()).toBe(true);
    expect(bridge.pendingToolCallIds()).toEqual(["call-1"]);

    const resolved = bridge.resolveFromToolResults([
      { toolCallId: "call-1", text: "file contents", isError: false },
    ]);
    expect(resolved).toEqual(["call-1"]);

    const result = await promise;
    expect(result).toEqual({
      content: [{ type: "text", text: "file contents" }],
      isError: false,
    });
  });

  it("pending -> rejectAll -> promise rejects", async () => {
    const bridge = createToolResultBridge();
    const promise = bridge.pending("call-2", "shell", `{"cmd":"ls"}`);

    bridge.rejectAll(new Error("aborted"));

    await expect(promise).rejects.toThrow("aborted");
  });

  it("multiple concurrent pending calls", async () => {
    const bridge = createToolResultBridge();
    const p1 = bridge.pending("a", "tool1", "{}");
    const p2 = bridge.pending("b", "tool2", "{}");

    expect(bridge.hasPending()).toBe(true);
    expect(bridge.pendingToolCallIds()).toHaveLength(2);

    const resolved = bridge.resolveFromToolResults([
      { toolCallId: "a", text: "result-a" },
      { toolCallId: "b", text: "result-b" },
    ]);
    expect(resolved).toEqual(expect.arrayContaining(["a", "b"]));
    expect(resolved).toHaveLength(2);

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.content[0].text).toBe("result-a");
    expect(r2.content[0].text).toBe("result-b");
    expect(bridge.hasPending()).toBe(false);
  });

  it("resolveFromToolResults with unknown callId is noop", () => {
    const bridge = createToolResultBridge();
    const resolved = bridge.resolveFromToolResults([
      { toolCallId: "unknown", text: "mystery" },
    ]);
    expect(resolved).toEqual([]);
  });

  it("whenPending fires on first register, re-arms after all resolved", async () => {
    const bridge = createToolResultBridge();

    // Capture the whenPending promise BEFORE any pending() call
    const wp1 = bridge.whenPending();

    // First pending() should arm/resolve whenPending
    const p1 = bridge.pending("x", "t1", "{}");

    await expect(wp1).resolves.toBeUndefined();

    // Now all resolved — whenPending should re-arm
    bridge.resolveFromToolResults([{ toolCallId: "x", text: "done" }]);
    await p1;

    expect(bridge.hasPending()).toBe(false);

    // Capture new whenPending promise after drain
    const wp2 = bridge.whenPending();

    // Second pending() should fire whenPending again
    const p2 = bridge.pending("y", "t2", "{}");

    await expect(wp2).resolves.toBeUndefined();

    bridge.resolveFromToolResults([{ toolCallId: "y", text: "done2" }]);
    await p2;
  });

  it("resolve twice on same callId is noop second time", async () => {
    const bridge = createToolResultBridge();
    const promise = bridge.pending("dup", "t", "{}");

    bridge.resolveFromToolResults([{ toolCallId: "dup", text: "first" }]);
    const result = await promise;

    // Second resolve should be noop
    const resolved = bridge.resolveFromToolResults([
      { toolCallId: "dup", text: "second" },
    ]);
    expect(resolved).toEqual([]);
    expect(result.content[0].text).toBe("first");
  });

  it("isError flag propagates to result", async () => {
    const bridge = createToolResultBridge();
    const promise = bridge.pending("err-1", "shell", "{}");

    bridge.resolveFromToolResults([
      { toolCallId: "err-1", text: "command failed", isError: true },
    ]);

    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("command failed");
  });
});
