import { describe, it, expect } from "vitest";
import { createFlowTmuxController } from "../src/tmux/manager.js";

describe("flow tmux controller", () => {
  it("opens pane on created, closes on completed", () => {
    const opens: string[] = [];
    const closes: string[] = [];
    const bus = createFlowTmuxController({
      onCreated: (id) => opens.push(id),
      onTerminal: (id) => closes.push(id),
    });
    bus.emit("subagents:created", { id: "a1" });
    bus.emit("subagents:completed", { id: "a1" });
    expect(opens).toEqual(["a1"]);
    expect(closes).toEqual(["a1"]);
  });
  it("treats failed as terminal", () => {
    const closes: string[] = [];
    const bus = createFlowTmuxController({
      onCreated: () => {},
      onTerminal: (id) => closes.push(id),
    });
    bus.emit("subagents:failed", { id: "a2" });
    expect(closes).toEqual(["a2"]);
  });
  it("ignores non-terminal events", () => {
    const opens: string[] = [];
    const closes: string[] = [];
    const bus = createFlowTmuxController({
      onCreated: (id) => opens.push(id),
      onTerminal: (id) => closes.push(id),
    });
    bus.emit("subagents:started", { id: "a3" });
    bus.emit("subagents:record", { id: "a3" });
    bus.emit("subagents:compacted", { id: "a3" });
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
  });
});
