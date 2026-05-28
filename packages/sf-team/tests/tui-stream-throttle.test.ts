import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runOrchestrator } from "../src/orchestrator/run";
import type { WidgetState } from "../src/tui/state";

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-tui-stream-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "x");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  mkdirSync(path.join(root, "ai_plan", "stream-throttle"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function cloneState(state: WidgetState): WidgetState {
  return JSON.parse(JSON.stringify(state)) as WidgetState;
}

describe("TUI stream throttling", () => {
  it("does not re-render high-volume text deltas when the widget state does not change", async () => {
    const { root, dispose } = makeRepo();
    try {
      const updates: WidgetState[] = [];
      await runOrchestrator(
        {
          repoRoot: root,
          slug: "stream-throttle",
          toolName: "sf_team_plan",
          useWorktree: true,
          tmuxManager: null,
          widget: { update: (state) => updates.push(cloneState(state)), dispose: vi.fn() },
        },
        async (bodyCtx) => {
          const sub = bodyCtx.subscribeAgent({ role: "planner", model: "x" });
          for (let i = 0; i < 1000; i += 1) {
            sub.onEvent({
              kind: "stdout-json",
              raw: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } },
            });
          }
          expect(updates).toHaveLength(2);

          sub.onEvent({ kind: "stdout-json", raw: { type: "agent_end", messages: [] } });
          expect(updates).toHaveLength(3);
          expect(updates.at(-1)?.agents[0]?.state).toBe("completed");
          return undefined;
        },
      );
    } finally {
      dispose();
    }
  });

  it("coalesces non-terminal widget updates and lets terminal events render immediately", async () => {
    const { root, dispose } = makeRepo();
    try {
      const updates: WidgetState[] = [];
      await runOrchestrator(
        {
          repoRoot: root,
          slug: "stream-throttle",
          toolName: "sf_team_plan",
          useWorktree: true,
          tmuxManager: null,
          widgetUpdateIntervalMs: 20,
          widget: { update: (state) => updates.push(cloneState(state)), dispose: vi.fn() },
        },
        async (bodyCtx) => {
          const sub = bodyCtx.subscribeAgent({ role: "planner", model: "x" });
          for (let i = 0; i < 5; i += 1) {
            sub.onEvent({ kind: "tool_call", toolName: `tool-${i}`, input: {} });
          }
          expect(updates).toHaveLength(2);

          await sleep(40);
          expect(updates).toHaveLength(3);
          expect(updates.at(-1)?.agents[0]?.activity).toBe("tool: tool-4");

          sub.onEvent({ kind: "stdout-json", raw: { type: "agent_end", messages: [] } });
          expect(updates).toHaveLength(4);
          expect(updates.at(-1)?.agents[0]?.state).toBe("completed");
          return undefined;
        },
      );
    } finally {
      dispose();
    }
  });
});
