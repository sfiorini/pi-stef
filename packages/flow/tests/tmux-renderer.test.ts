import { describe, it, expect } from "vitest";
import { renderPane, NOOP_WHEN_DISABLED } from "../src/tmux/renderer.js";

describe("tmux renderer", () => {
  it("NOOP_WHEN_DISABLED is true (byte-identical no-op contract)", () => {
    expect(NOOP_WHEN_DISABLED).toBe(true);
  });
  it("renderPane produces a header line with phase/agent/status/pct", () => {
    const out = renderPane({
      phase: "scan",
      agent: "scanner",
      status: "running",
      tokPct: 42,
      model: "haiku",
      theme: "codex",
    });
    expect(out.header).toContain("scan");
    expect(out.header).toContain("scanner");
    expect(out.header).toContain("running");
    expect(out.header).toContain("42%");
  });
  it("theme plain has no ansi codes", () => {
    const out = renderPane({
      phase: "scan",
      agent: "scanner",
      status: "done",
      tokPct: 100,
      model: "haiku",
      theme: "plain",
    });
    expect(out.header).not.toMatch(/\x1b\[/);
  });
  it("theme codex uses ansi color codes", () => {
    const out = renderPane({
      phase: "scan",
      agent: "scanner",
      status: "running",
      tokPct: 10,
      model: "haiku",
      theme: "codex",
    });
    expect(out.header).toMatch(/\x1b\[/);
  });
});
