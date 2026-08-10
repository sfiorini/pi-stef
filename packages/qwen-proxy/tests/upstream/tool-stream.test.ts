import { describe, it, expect } from "vitest";
import { ToolStreamDetector } from "../../src/upstream/tool-stream";

describe("ToolStreamDetector", () => {
  it("passes through normal text content (no tool_calls tag)", () => {
    const det = new ToolStreamDetector();
    const r1 = det.push("Hello ");
    const r2 = det.push("world!");
    // "Hello " = 6 chars ≤ 12 → held back, content = ""
    expect(r1.content).toBe("");
    // "Hello world!" = 12 chars = TAG_OPEN_LEN → still held back, content = ""
    expect(r2.content).toBe("");
    // finalize flushes the remaining buffer
    expect(det.finalize().content).toBe("Hello world!");
  });

  it("detects <tool_calls> tag in a single push and transitions to SEALED", () => {
    const det = new ToolStreamDetector();
    const full = '<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}}]</tool_calls>';
    const r = det.push(full);
    // Tag found immediately — no content before it, so content = ""
    expect(r.content).toBe("");
    expect(r.toolCallsReady).toBe(true);
    expect(det.completedBlock).toContain("get_weather");

    // After sealed, any more content is dropped (content field absent = undefined)
    const r2 = det.push("more text after");
    expect(r2.content).toBeUndefined();
  });

  it("detects <tool_calls> tag split across multiple pushes", () => {
    const det = new ToolStreamDetector();
    // "Hello <too" = 10 chars ≤ 12 → all held back, content = ""
    const r1 = det.push("Hello <too");
    expect(r1.content).toBe("");

    // Now buffer = "Hello <too" + "l_calls>[1]</tool_calls>" = "Hello <tool_calls>[1]</tool_calls>"
    // Tag found at index 6 → emit "Hello " before tag → SEALED
    const r2 = det.push("l_calls>[1]</tool_calls>");
    expect(r2.content).toBe("Hello ");
    expect(r2.toolCallsReady).toBe(true);
    expect(det.completedBlock).toContain("l_calls>");
  });

  it("discards partial tag on finalize (mid-tag end — Q4)", () => {
    const det = new ToolStreamDetector();
    // Push content that triggers BUFFERING (opens <tool_calls>) but never closes
    det.push("text before <tool_cal");
    det.push("ls>");
    // Now in BUFFERING state with partial tag — finalize should discard (content absent)
    expect(det.finalize().content).toBeUndefined();
  });

  it("suppresses content after </tool_calls> is sealed (Q5)", () => {
    const det = new ToolStreamDetector();
    det.push('<tool_calls>[{"name":"a","arguments":{}}]</tool_calls>');
    // Sealed now
    const r1 = det.push("leaked content");
    expect(r1.content).toBeUndefined();

    const r2 = det.push("more leaked");
    expect(r2.content).toBeUndefined();

    const fin = det.finalize();
    expect(fin.content).toBeUndefined();
  });

  it("handles empty tag <tool_calls>[]</tool_calls>", () => {
    const det = new ToolStreamDetector();
    const r = det.push("<tool_calls>[]</tool_calls>");
    expect(r.toolCallsReady).toBe(true);
    expect(det.completedBlock).toBe("<tool_calls>[]</tool_calls>");
  });

  it("holds back exactly 12 chars to detect partial <tool_calls> prefix", () => {
    const det = new ToolStreamDetector();
    // "<tool_calls>" is 12 chars. Push content without tag:
    // "AAAAAAAA" (8 chars) → all held back (< 12)
    const r1 = det.push("AAAAAAAA");
    expect(r1.content).toBe("");

    // "BBBBBBBB" (8 more) → total 16, emit first 4 (16-12=4)
    const r2 = det.push("BBBBBBBB");
    expect(r2.content).toBe("AAAA");

    // Buffer now holds last 12 chars: "AAAABBBBBBBB" (4 A's + 8 B's)
    // Finalize flushes the remaining buffer
    const fin = det.finalize();
    expect(fin.content).toBe("AAAABBBBBBBB");
  });

  it("completeBlock contains the full <tool_calls>...</tool_calls> span", () => {
    const det = new ToolStreamDetector();
    const tag = '<tool_calls>[{"name":"x","arguments":{}}]</tool_calls>';
    det.push("prefix " + tag + " suffix");
    expect(det.completedBlock).toBe(tag);
  });
});
