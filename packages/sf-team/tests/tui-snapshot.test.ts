import { describe, expect, it, vi } from "vitest";

import { renderAgentCards } from "../src/tui/agent-card";
import { mountWidget } from "../src/tui/dispose";
import { renderMilestoneStrip } from "../src/tui/milestone-strip";
import { renderResumeBanner } from "../src/tui/resume-banner";
import { applyAgentEvent, applyTrackerFile, newAgentCard, projectTracker } from "../src/tui/wiring";
import { emptyState, setMilestones, setResume, upsertAgent, type WidgetState } from "../src/tui/state";

describe("M8 renderAgentCards", () => {
  it("placeholder when no agents", () => {
    const lines = renderAgentCards(emptyState(), { useColor: false });
    expect(lines).toEqual(["(no active agents)"]);
  });

  it("renders top-level agent with role icon, state glyph, model, and elapsed", () => {
    let s = emptyState();
    s = upsertAgent(s, {
      id: "a1",
      role: "planner",
      model: "claude-opus-4-7",
      state: "running",
      startedAtMs: 1_000_000,
    });
    const lines = renderAgentCards(s, { now: 1_002_500, useColor: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("📐");
    expect(lines[0]).toContain("▶");
    expect(lines[0]).toContain("planner");
    expect(lines[0]).toContain("claude-opus-4-7");
    expect(lines[0]).toContain("[2s]");
  });

  it("tree-indents children under parent (S-803)", () => {
    let s = emptyState();
    s = upsertAgent(s, { id: "p1", role: "planner", model: "p", state: "running" });
    s = upsertAgent(s, { id: "r1", role: "reviewer", model: "r", state: "running", parentId: "p1" });
    s = upsertAgent(s, { id: "r2", role: "reviewer", model: "r", state: "running", parentId: "p1" });
    const lines = renderAgentCards(s, { useColor: false });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^├─ /);
    expect(lines[2]).toMatch(/^└─ /);
  });

  it("renders DEEPLY nested grandchildren at the right depth", () => {
    let s = emptyState();
    s = upsertAgent(s, { id: "p", role: "planner", model: "m", state: "running" });
    s = upsertAgent(s, { id: "d", role: "developer", model: "m", state: "running", parentId: "p" });
    s = upsertAgent(s, { id: "r", role: "reviewer", model: "m", state: "running", parentId: "d" });
    const lines = renderAgentCards(s, { useColor: false });
    expect(lines).toHaveLength(3);
    // Top-level
    expect(lines[0]).not.toMatch(/^[├└│]/);
    // Direct child gets last-branch prefix
    expect(lines[1]).toMatch(/^└─ /);
    // Grandchild gets `   └─ ` (continuation + last-branch).
    expect(lines[2]).toMatch(/^ {3}└─ /);
  });

  it("color-coded states + error border on failed/aborted (S-808)", () => {
    let s = emptyState();
    s = upsertAgent(s, { id: "f", role: "developer", model: "m", state: "failed" });
    const lines = renderAgentCards(s, { useColor: true });
    // ANSI red color and error background framing.
    expect(lines[0]).toContain("\x1b[31m"); // red
    expect(lines[0]).toContain("\x1b[41m"); // error bg framing
  });
});

describe("M8 renderMilestoneStrip", () => {
  it("renders a per-milestone bar and approvalStatus", () => {
    const lines = renderMilestoneStrip([
      { id: "M0", title: "spike", completed: 5, inDev: 0, total: 5, approvalStatus: "approved" },
      { id: "M1", title: "scaffold", completed: 4, inDev: 1, total: 8 },
      { id: "M2", title: "config", completed: 0, inDev: 0, total: 8 },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("M0[█████]");
    expect(lines[0]).toContain("approved");
    expect(lines[1]).toContain("M1[████~···]");
    expect(lines[2]).toContain("M2[········]");
  });
});

describe("M8 resume banner", () => {
  it("shows custom text when banner.show=true", () => {
    expect(renderResumeBanner({ show: true, text: "Resume from S-201?" })).toEqual(["⏵ Resume from S-201?"]);
  });
  it("returns empty when not shown", () => {
    expect(renderResumeBanner({ show: false })).toEqual([]);
  });
});

describe("M8 applyAgentEvent (S-806 wiring)", () => {
  it("agent_start → state=running with startedAtMs", () => {
    let s = emptyState();
    s = upsertAgent(s, { id: "a", role: "planner", model: "m", state: "idle" });
    s = applyAgentEvent(s, "a", { kind: "stdout-json", raw: { type: "agent_start" } });
    expect(s.agents[0].state).toBe("running");
    expect(s.agents[0].startedAtMs).toBeGreaterThan(0);
  });
  it("tool_call → activity hint", () => {
    let s = emptyState();
    s = upsertAgent(s, { id: "a", role: "developer", model: "m", state: "running" });
    s = applyAgentEvent(s, "a", { kind: "tool_call", toolName: "read", input: { path: "/x" } });
    expect(s.agents[0].activity).toBe("tool: read");
  });
  it("stalled / aborted / exit-nonzero map to expected states", () => {
    let s = emptyState();
    s = upsertAgent(s, { id: "a", role: "reviewer", model: "m", state: "running" });
    s = applyAgentEvent(s, "a", { kind: "stalled", lastEventAtMs: 0 });
    expect(s.agents[0].state).toBe("stalled");
    // Reset to running so the aborted check is clean
    s = upsertAgent(s, { id: "a", role: "reviewer", model: "m", state: "running" });
    s = applyAgentEvent(s, "a", { kind: "aborted" });
    expect(s.agents[0].state).toBe("aborted");
    // After aborted, a trailing exit event must NOT relabel the state.
    s = applyAgentEvent(s, "a", { kind: "exit", exitCode: 1, signal: null });
    expect(s.agents[0].state).toBe("aborted");
  });

  it("a trailing exit event does NOT overwrite a pre-existing stalled state", () => {
    let s = emptyState();
    s = upsertAgent(s, { id: "a", role: "reviewer", model: "m", state: "running" });
    s = applyAgentEvent(s, "a", { kind: "stalled", lastEventAtMs: 0 });
    expect(s.agents[0].state).toBe("stalled");
    s = applyAgentEvent(s, "a", { kind: "exit", exitCode: null, signal: "SIGTERM" });
    expect(s.agents[0].state).toBe("stalled");
  });
});

describe("M8 watchTrackerFile (S-807 live fs.watch projection)", () => {
  it("catches atomic-rename mutations from updateStoryTracker (production path)", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { watchTrackerFile } = await import("../src/tui/wiring");
    const { updateStoryTracker } = await import("../src/plan/tracker");
    const root = mkdtempSync(path.join(tmpdir(), "ct-tui-watch-rename-"));
    try {
      const slug = "2026-05-01-watcher";
      const planFolder = path.join(root, "ai_plan", slug);
      await import("node:fs").then((fs) => fs.mkdirSync(planFolder, { recursive: true }));
      const file = path.join(planFolder, "story-tracker.md");
      writeFileSync(
        file,
        `### M0: First

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | a | pending | |

**Approval Status:** pending
`,
      );
      const updates: WidgetState[] = [];
      // Use a fast polling fallback so the test passes in environments where
      // fs.watch is unavailable (sandboxes hitting EMFILE / ENOSPC).
      const stop = watchTrackerFile(file, emptyState(), (next) => updates.push(next), { pollIntervalMs: 50 });

      // Wait until the initial projection arrives (await-until helper).
      await waitUntil(() => updates.length >= 1, 5_000);
      const baseline = updates[updates.length - 1];
      expect(baseline.milestones[0]).toMatchObject({ total: 1, completed: 0 });

      // Mutate via the PRODUCTION updater (atomic rename).
      await updateStoryTracker(root, { slug, storyId: "S-001", status: "completed", notes: "abc" });
      await waitUntil(
        () => updates[updates.length - 1]?.milestones[0]?.completed === 1,
        5_000,
      );
      const after = updates[updates.length - 1];
      expect(after.milestones[0]).toMatchObject({ total: 1, completed: 1 });

      // Mutate AGAIN (catches the dead-inode-after-rename regression).
      writeFileSync(
        file + ".tmp",
        `### M0: First

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | a | completed | abc |
| S-002 | b | in-dev | wip |

**Approval Status:** pending
`,
      );
      await import("node:fs/promises").then((fs) => fs.rename(file + ".tmp", file));
      await waitUntil(
        () =>
          updates[updates.length - 1]?.milestones[0]?.total === 2 &&
          updates[updates.length - 1]?.milestones[0]?.inDev === 1,
        5_000,
      );
      const second = updates[updates.length - 1];
      expect(second.milestones[0]).toMatchObject({ total: 2, completed: 1, inDev: 1 });

      stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("emits an initial render then updates when the tracker file changes", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { watchTrackerFile } = await import("../src/tui/wiring");
    const root = mkdtempSync(path.join(tmpdir(), "ct-tui-watch-"));
    try {
      const file = path.join(root, "story-tracker.md");
      writeFileSync(
        file,
        `### M0: First

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | a | pending | |

**Approval Status:** pending
`,
      );
      const updates: WidgetState[] = [];
      const initialState = emptyState();
      const stop = watchTrackerFile(file, initialState, (next) => updates.push(next), { pollIntervalMs: 50 });
      await waitUntil(() => updates.length >= 1, 5_000);
      const initial = updates[updates.length - 1];
      expect(initial.milestones[0]).toMatchObject({ total: 1, completed: 0, inDev: 0 });

      writeFileSync(
        file,
        `### M0: First

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | a | completed | hash |

**Approval Status:** approved
`,
      );
      await waitUntil(
        () => updates[updates.length - 1]?.milestones[0]?.completed === 1,
        5_000,
      );
      const after = updates[updates.length - 1];
      expect(after.milestones[0]).toMatchObject({ total: 1, completed: 1, inDev: 0 });
      stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitUntil: timed out after ${timeoutMs}ms`);
}

describe("M8 applyTrackerFile (one-shot read)", () => {
  it("projects a tracker file's milestones into state.milestones", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(path.join(tmpdir(), "ct-tui-"));
    try {
      const tracker = `### M0: First

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | a | completed | x |
| S-002 | b | in-dev | y |
| S-003 | c | pending | |

**Approval Status:** pending
`;
      const file = path.join(root, "story-tracker.md");
      writeFileSync(file, tracker);
      const next = await applyTrackerFile(emptyState(), file);
      expect(next.milestones).toHaveLength(1);
      expect(next.milestones[0]).toMatchObject({ id: "M0", total: 3, completed: 1, inDev: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("M8 mountWidget orchestrator-pattern (S-809: dispose on success/error/abort)", () => {
  /**
   * The production orchestrator (M9) will call mountWidget at tool entry and
   * always dispose() in a finally block. This test sketches that pattern
   * three times — success path, throwing-error path, and AbortSignal-cancel
   * path — to lock the dispose contract in regardless of which production
   * tool ends up using it.
   */
  it("disposes on the SUCCESS path (orchestrator pattern)", async () => {
    const setWidget = vi.fn();
    const ui = { setWidget } as unknown as Parameters<typeof mountWidget>[0];
    const handle = mountWidget(ui, { useColor: false });
    try {
      handle.update(emptyState());
      // Pretend the tool finished successfully.
    } finally {
      handle.dispose();
    }
    expect(setWidget).toHaveBeenLastCalledWith("sf-team", undefined);
  });

  it("disposes on the ERROR path (synchronous throw inside try block)", () => {
    const setWidget = vi.fn();
    const ui = { setWidget } as unknown as Parameters<typeof mountWidget>[0];
    const handle = mountWidget(ui, { useColor: false });
    let caught: Error | undefined;
    try {
      handle.update(emptyState());
      throw new Error("simulated tool failure");
    } catch (err) {
      caught = err as Error;
    } finally {
      handle.dispose();
    }
    expect(caught?.message).toBe("simulated tool failure");
    expect(setWidget).toHaveBeenLastCalledWith("sf-team", undefined);
  });

  it("disposes on the ABORT path (signal aborted while widget is up)", async () => {
    const setWidget = vi.fn();
    const ui = { setWidget } as unknown as Parameters<typeof mountWidget>[0];
    const handle = mountWidget(ui, { useColor: false });
    const ctrl = new AbortController();
    const aborted = new Promise<void>((resolve) => ctrl.signal.addEventListener("abort", () => resolve()));
    try {
      handle.update(emptyState());
      ctrl.abort();
      await aborted;
    } finally {
      handle.dispose();
    }
    expect(setWidget).toHaveBeenLastCalledWith("sf-team", undefined);
  });
});

describe("M8 mountWidget dispose internals", () => {
  it("update() forwards string[] to ui.setWidget; dispose() unmounts; re-dispose is idempotent", () => {
    const setWidget = vi.fn();
    const ui = { setWidget } as unknown as Parameters<typeof mountWidget>[0];
    const handle = mountWidget(ui, { useColor: false });
    let s = emptyState();
    s = upsertAgent(s, { id: "p", role: "planner", model: "m", state: "running" });
    s = setMilestones(s, [{ id: "M0", title: "spike", completed: 1, inDev: 0, total: 5 }]);
    handle.update(s);
    expect(setWidget).toHaveBeenCalledWith("sf-team", expect.any(Array));
    const lines = setWidget.mock.calls[0][1] as string[];
    expect(lines.join("\n")).toContain("M0[█····]");
    expect(lines.join("\n")).toContain("planner");

    handle.dispose();
    expect(setWidget).toHaveBeenCalledWith("sf-team", undefined);
    handle.dispose(); // idempotent — no extra calls
    expect(setWidget).toHaveBeenCalledTimes(2);
  });

  it("dispose runs even if a later update() is called (no zombie widget on abort/error path)", () => {
    const setWidget = vi.fn();
    const ui = { setWidget } as unknown as Parameters<typeof mountWidget>[0];
    const handle = mountWidget(ui, { useColor: false });
    handle.dispose();
    handle.update(emptyState());
    // No additional setWidget call after dispose.
    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(setWidget).toHaveBeenLastCalledWith("sf-team", undefined);
  });
});

describe("M8 visual snapshot (S-810)", () => {
  it("composite render includes resume banner + milestone strip + agent cards in fixed order", () => {
    const setWidget = vi.fn();
    const ui = { setWidget } as unknown as Parameters<typeof mountWidget>[0];
    // Pin "now" so elapsed=0s for the snapshot.
    const handle = mountWidget(ui, { useColor: false, now: () => 1_000_000 });
    let s = emptyState();
    s = setResume(s, { show: true, text: "Resume from S-201?" });
    s = setMilestones(s, [
      { id: "M0", title: "spike", completed: 5, inDev: 0, total: 5, approvalStatus: "approved" },
      { id: "M1", title: "scaffold", completed: 4, inDev: 1, total: 8 },
    ]);
    s = upsertAgent(s, { id: "p1", role: "planner", model: "claude-opus-4-7", state: "running", startedAtMs: 1_000_000 });
    s = upsertAgent(s, { id: "r1", role: "reviewer", model: "claude-opus-4-7", state: "running", parentId: "p1", startedAtMs: 1_000_000 });
    handle.update(s);
    const out = (setWidget.mock.calls[0][1] as string[]).join("\n");
    expect(out).toMatchInlineSnapshot(`
"── sf-team ────
⏵ Resume from S-201?

M0[█████] (approved) spike
M1[████~···] scaffold

📐 ▶ planner (claude-opus-4-7) [0s]
└─ 🔎 ▶ reviewer (claude-opus-4-7) [0s]"
`);
  });
});

describe("M8 newAgentCard + projectTracker convenience (S-806/S-807)", () => {
  it("newAgentCard produces a running card with timestamp", () => {
    const card = newAgentCard({ id: "x", role: "developer", model: "m" });
    expect(card.state).toBe("running");
    expect(card.startedAtMs).toBeGreaterThan(0);
  });

  it("projectTracker counts completed/in-dev correctly", () => {
    const projection = projectTracker({
      raw: "",
      milestones: [
        {
          id: "M0",
          title: "x",
          stories: [
            { id: "S-001", description: "a", status: "completed", notes: "" },
            { id: "S-002", description: "b", status: "in-dev", notes: "" },
            { id: "S-003", description: "c", status: "pending", notes: "" },
          ],
          approvalStatus: undefined,
        },
      ],
    });
    expect(projection[0]).toMatchObject({ total: 3, completed: 1, inDev: 1 });
  });
});

// Touch a state-only helper to keep imports honest under tsc unused-locals.
void _suppress(emptyState());
function _suppress<T>(v: T): T {
  return v;
}

// Reference WidgetState explicitly so its import isn't elided by tsc.
const _widgetStateRef: WidgetState | undefined = undefined;
void _widgetStateRef;
