import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runOrchestrator } from "../../src/orchestrator/run";
import { renderAgentCards } from "../../src/tui/agent-card";
import type { TmuxManager } from "../../src/tmux/manager";

/* M8 S-804 — when no `tmuxManager` is injected AND no `$TMUX` env is
 * present (the production no-tmux path), runOrchestrator MUST NOT
 * touch any tmux machinery, AND subscribeAgent MUST NOT thread a
 * rawLogPath into spawn calls. The widget snapshot still renders the
 * agent cards exactly the way it did before M6 wiring landed. */

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-e2e-no-tmux-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("S-804 no-tmux path: zero manager calls + widget snapshot unchanged", () => {
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => repo.dispose());

  it("orchestrator without `tmuxManager` (auto-detect, no $TMUX): subscribe path skips all tmux work", async () => {
    // Strip $TMUX from the env so getActiveSession() returns null —
    // this is the production "no tmux" path: no manager is constructed
    // and `subscribeAgent` skips the entire pane-mirror branch.
    const savedTmux = process.env.TMUX;
    delete process.env.TMUX;

    const widgetUpdates: import("../../src/tui/state").WidgetState[] = [];
    try {
      await runOrchestrator(
        {
          repoRoot: repo.root,
          slug: "no-tmux-byte-identical",
          toolName: "sf_team_implement",
          useWorktree: true,
          // Field omitted entirely — production "no $TMUX env" path.
          widget: {
            update: (s: unknown) => widgetUpdates.push(s as never),
            dispose: vi.fn(),
          } as never,
        },
        async (bodyCtx) => {
          const sub1 = bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "developer-M1");
          const sub2 = bodyCtx.subscribeAgent({ role: "reviewer", model: "r" }, "reviewer-M1");
          // sub.rawLogPath MUST be undefined when no manager is active.
          expect(sub1.rawLogPath).toBeUndefined();
          expect(sub2.rawLogPath).toBeUndefined();
          // Even synthesizing terminal events MUST NOT crash.
          sub1.onEvent({ kind: "exit", exitCode: 0, signal: null } as never);
          sub2.onEvent({ kind: "exit", exitCode: 0, signal: null } as never);
          return "ok";
        },
      );
    } finally {
      if (savedTmux !== undefined) process.env.TMUX = savedTmux;
    }

    // The widget rendered the agent cards just like it did before M6.
    // Snapshot the LAST update (the one with the most state).
    const finalState = widgetUpdates[widgetUpdates.length - 1];
    const lines = renderAgentCards(finalState, { now: 1_700_000_060_000, useColor: false });
    // Two cards: developer-M1 + reviewer-M1.
    expect(lines).toHaveLength(2);
    // The widget renders the FROZEN-on-completion form: role icon +
    // glyph (✓) + role + (model) + [elapsed]. No "completed" string.
    expect(lines[0]).toMatch(/developer.*\(m\)/);
    expect(lines[0]).toContain("✓");
    expect(lines[1]).toMatch(/reviewer.*\(r\)/);
    expect(lines[1]).toContain("✓");
    // No tmux artifacts in the snapshot — no per-run log dir prefix
    // (`sf-team-<hash>-<runId>`), no launcher session name
    // (`fh-agent-<hex>`), no log file paths.
    for (const l of lines) {
      expect(l).not.toMatch(/sf-team-/);
      expect(l).not.toMatch(/fh-agent-/);
      expect(l).not.toMatch(/\.log/);
    }
  });

  it("orchestrator with `tmuxManager: null` (explicit disable): same — manager is never instantiated", async () => {
    const stubCalls: string[] = [];
    const stub = {
      ensureRightSplit() { stubCalls.push("ensureRightSplit"); },
      openAgentPane() { stubCalls.push("openAgentPane"); },
      closeAgentPane() { stubCalls.push("closeAgentPane"); },
      closeAllPanes() { stubCalls.push("closeAllPanes"); },
    } as unknown as TmuxManager;
    await runOrchestrator(
      {
        repoRoot: repo.root,
        slug: "no-tmux-explicit",
        toolName: "sf_team_implement",
        useWorktree: true,
        tmuxManager: null,
      },
      async (bodyCtx) => {
        const sub = bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "developer-M2");
        expect(sub.rawLogPath).toBeUndefined();
        return "ok";
      },
    );
    expect(stubCalls).toHaveLength(0);
  });

  it("no-tmux path still coalesces non-terminal widget updates and renders terminal state", async () => {
    const savedTmux = process.env.TMUX;
    delete process.env.TMUX;
    const widgetUpdates: import("../../src/tui/state").WidgetState[] = [];
    try {
      await runOrchestrator(
        {
          repoRoot: repo.root,
          slug: "no-tmux-throttle",
          toolName: "sf_team_plan",
          useWorktree: true,
          widgetUpdateIntervalMs: 20,
          widget: {
            update: (s: unknown) => widgetUpdates.push(JSON.parse(JSON.stringify(s))),
            dispose: vi.fn(),
          } as never,
        },
        async (bodyCtx) => {
          const sub = bodyCtx.subscribeAgent({ role: "planner", model: "m" }, "planner");
          expect(sub.rawLogPath).toBeUndefined();
          for (let i = 0; i < 5; i += 1) {
            sub.onEvent({ kind: "tool_call", toolName: `tool-${i}`, input: {} } as never);
          }
          expect(widgetUpdates).toHaveLength(2);

          await sleep(40);
          expect(widgetUpdates).toHaveLength(3);
          expect(widgetUpdates.at(-1)?.agents[0]?.activity).toBe("tool: tool-4");

          sub.onEvent({ kind: "stdout-json", raw: { type: "agent_end", messages: [] } } as never);
          expect(widgetUpdates.at(-1)?.agents[0]?.state).toBe("completed");
          return "ok";
        },
      );
    } finally {
      if (savedTmux !== undefined) process.env.TMUX = savedTmux;
    }
  });
});
