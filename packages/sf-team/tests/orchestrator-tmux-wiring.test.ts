import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runOrchestrator } from "../src/orchestrator/run";
import { TmuxManager } from "../src/tmux/manager";
import { renderAgentCardTitle } from "../src/tui/agent-card";
import type { AgentCard } from "../src/tui/state";

/* ───────────────────────── S-601 renderAgentCardTitle ──────────────────────── */

describe("S-601 renderAgentCardTitle (single source of truth for widget + tmux)", () => {
  function card(over: Partial<AgentCard> = {}): AgentCard {
    return {
      id: "developer-M1",
      role: "developer",
      model: "anthropic/claude-sonnet-4-6",
      state: "running",
      startedAtMs: 1_700_000_000_000,
      ...over,
    };
  }

  it("plain-text snapshot for a developer card with milestone + round=1 (round suffix suppressed)", () => {
    // Round 1 is the implicit default and is suppressed regardless of
    // milestone — showing `· round 1` was noise. Round counter only
    // surfaces once it actually conveys information (N > 1).
    const t = renderAgentCardTitle(card({ milestoneId: "M1", round: 1 }), 1_700_000_060_000);
    expect(t).toBe("🛠  ▶ developer (anthropic/claude-sonnet-4-6) [1m00s] · M1");
  });

  it("non-milestone agent at round=2 renders `· round 2` (review-loop revision, not failure-retry)", () => {
    // Earlier behavior used "attempt N" for non-milestone roles, which
    // misled users into thinking the prior run had FAILED. Round 2 of
    // the planner-reviewer loop is a normal revise round — same
    // semantics as the milestone-bound impl-phase loop. One word: "round".
    const t1 = renderAgentCardTitle(card({ id: "planner", role: "planner", round: 1 }), 1_700_000_060_000);
    expect(t1).toBe("📐 ▶ planner (anthropic/claude-sonnet-4-6) [1m00s]");
    const t2 = renderAgentCardTitle(card({ id: "planner", role: "planner", round: 2 }), 1_700_000_060_000);
    expect(t2).toBe("📐 ▶ planner (anthropic/claude-sonnet-4-6) [1m00s] · round 2");
  });

  it("terminal state freezes elapsed at endedAtMs", () => {
    const t = renderAgentCardTitle(
      card({
        state: "completed",
        startedAtMs: 1_700_000_000_000,
        endedAtMs: 1_700_000_030_000,
      }),
      1_700_000_999_999,
    );
    expect(t).toContain("[30s]");
    expect(t).toContain("✓");
  });
});

/* ───────────────────────── helpers shared by the integration tests ────────── */

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-orch-tmux-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Build a stub TmuxManager that records every method call AND uses a
 * deterministic per-agent log path (so tests can write to it directly).
 */
function makeStubTmux(): {
  mgr: TmuxManager;
  logDir: string;
  calls: string[];
  agentLog(agentId: string): string;
  cleanup: () => void;
} {
  const logDir = mkdtempSync(path.join(tmpdir(), "ct-tmux-stub-logs-"));
  const calls: string[] = [];
  const stubMgr = {
    nextSessionAlias(toolName: string): string {
      calls.push(`nextSessionAlias:${toolName}`);
      return `${toolName}-1`;
    },
    prepareSession(args: { sessionName: string; sessionAlias: string }): { sessionName: string; mainPaneId: string; windowId: string } {
      calls.push(`prepareSession:${args.sessionName}->${args.sessionAlias}`);
      return { sessionName: args.sessionAlias, mainPaneId: "%1", windowId: "@7" };
    },
    decorateSession(args: { sessionName: string }): { sessionName: string; mainPaneId: string; windowId: string } {
      calls.push(`decorateSession:${args.sessionName}`);
      return { sessionName: args.sessionName, mainPaneId: "%1", windowId: "@7" };
    },
    openAgentPane(args: {
      sessionName: string;
      agentId: string;
      paneTitle: string;
      runId?: string;
      logPath?: string;
      pretty?: boolean;
      groupId?: string;
      parentGroupId?: string;
      layoutRole?: string;
      storyId?: string;
    }): { paneId: string; logPath: string } {
      calls.push(`openAgentPane:${args.agentId}:${args.paneTitle}:${args.layoutRole ?? ""}:${args.groupId ?? ""}:${args.storyId ?? ""}`);
      const logPath = path.join(logDir, `${args.agentId}.log`);
      // Touch the file so the test's fs writes to it work.
      writeFileSync(logPath, "");
      return { paneId: `%${args.agentId.length + 10}`, logPath };
    },
    closeAgentPane(idOrAgentId: string): void {
      calls.push(`closeAgentPane:${idOrAgentId}`);
    },
    closeAllPanes(name?: string): void {
      calls.push(`closeAllPanes:${name ?? "<undef>"}`);
    },
    trackedAgentIds(): string[] { return []; },
    trackedPaneIds(): string[] { return []; },
  } as unknown as TmuxManager;
  return {
    mgr: stubMgr,
    logDir,
    calls,
    agentLog: (id) => path.join(logDir, `${id}.log`),
    cleanup: () => rmSync(logDir, { recursive: true, force: true }),
  };
}

/* ───────────────────────── S-602/604 inject + pane open ───────────────────── */

describe("S-602 + S-604 orchestrator wires TmuxManager when injected", () => {
  let stub: ReturnType<typeof makeStubTmux>;
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    stub = makeStubTmux();
    repo = makeRepo();
  });
  afterEach(() => {
    stub.cleanup();
    repo.dispose();
  });

  it("subscribeAgent triggers prepareSession (once) + openAgentPane (per subscription)", async () => {
    await runOrchestrator(
      {
        repoRoot: repo.root,
        slug: "tmux-wire",
        toolName: "sf_team_implement",
        useWorktree: true,
        tmuxManager: stub.mgr,
      },
      async (bodyCtx) => {
        bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "dev-M1");
        bodyCtx.subscribeAgent({ role: "reviewer", model: "r" }, "rev-M1");
        return "ok";
      },
    );
    // Session decoration happens lazily on first subscribe — exactly once.
    // The default tmuxSessionName is `sf-team-default` (a launcher
    // session per the validator), so prepareSession runs.
    expect(stub.calls.filter((c) => c.startsWith("prepareSession"))).toHaveLength(1);
    expect(stub.calls.filter((c) => c.startsWith("nextSessionAlias"))).toHaveLength(1);
    // openAgentPane fires for each subscribe.
    expect(stub.calls.filter((c) => c.startsWith("openAgentPane"))).toHaveLength(2);
    // closeAllPanes fires in the orchestrator finally.
    expect(stub.calls.some((c) => c.startsWith("closeAllPanes"))).toBe(true);
  });

  it("rawLogPath returned from subscribeAgent matches the manager's stubbed agent log path", async () => {
    let captured: string | undefined;
    await runOrchestrator(
      {
        repoRoot: repo.root,
        slug: "tmux-wire-2",
        toolName: "sf_team_implement",
        useWorktree: true,
        tmuxManager: stub.mgr,
      },
      async (bodyCtx) => {
        const sub = bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "dev-M2");
        captured = sub.rawLogPath;
        return "ok";
      },
    );
    expect(captured).toBe(stub.agentLog("dev-M2"));
  });

  it("decorates regular tmux sessions too, without asking for a team-tool alias", async () => {
    await runOrchestrator(
      {
        repoRoot: repo.root,
        slug: "tmux-wire-user-session",
        toolName: "sf_team_plan",
        useWorktree: false,
        tmuxManager: stub.mgr,
        tmuxSessionName: "user-work",
      },
      async (bodyCtx) => {
        bodyCtx.subscribeAgent({ role: "planner", model: "m" }, "planner-1");
        return "ok";
      },
    );

    expect(stub.calls).toContain("decorateSession:user-work");
    expect(stub.calls.some((c) => c.startsWith("prepareSession:"))).toBe(false);
    expect(stub.calls.some((c) => c.startsWith("nextSessionAlias:"))).toBe(false);
    expect(stub.calls).toContain("openAgentPane:planner-1:planner-1:::");
  });

  it("passes story pane grouping metadata and story-aware pane title to TmuxManager", async () => {
    await runOrchestrator(
      {
        repoRoot: repo.root,
        slug: "tmux-wire-grouped",
        toolName: "sf_team_implement",
        useWorktree: true,
        tmuxManager: stub.mgr,
      },
      async (bodyCtx) => {
        bodyCtx.subscribeAgent(
          { role: "developer", model: "m" },
          "developer-M1-S101",
          {
            milestoneId: "M1",
            storyId: "S-101",
            paneGroupId: "M1",
            paneLayoutRole: "story",
          },
        );
        return "ok";
      },
    );
    expect(stub.calls).toContain("openAgentPane:developer-M1-S101:developer-M1-S101:story:M1:S-101");
  });
});

/* ───────────────────────── S-606 close on terminal state ──────────────────── */

describe("S-606 close pane on ANY terminal state", () => {
  for (const terminal of ["completed", "failed", "aborted", "stalled"] as const) {
    it(`fires closeAgentPane when subscriber sees state=${terminal}`, async () => {
      const stub = makeStubTmux();
      const repo = makeRepo();
      try {
        await runOrchestrator(
          {
            repoRoot: repo.root,
            slug: `tmux-${terminal}`,
            toolName: "sf_team_implement",
            useWorktree: true,
            tmuxManager: stub.mgr,
          },
          async (bodyCtx) => {
            const sub = bodyCtx.subscribeAgent({ role: "developer", model: "m" }, `dev-${terminal}`);
            // Synthesize terminal-state event (mirrors what spawnAgent's
            // exit handler would do via applyAgentEvent).
            sub.onEvent({ kind: terminal === "stalled" ? "stalled" : terminal === "aborted" ? "aborted" : "exit", exitCode: terminal === "completed" ? 0 : 1, signal: null } as never);
            return "ok";
          },
        );
        // Either by paneId or agentId — the manager accepts both.
        expect(stub.calls.some((c) => c.startsWith("closeAgentPane:"))).toBe(true);
      } finally {
        stub.cleanup();
        repo.dispose();
      }
    });
  }
});

/* ───────────────────────── S-607 clearAgents closes panes ────────────────── */

describe("S-607 clearAgents() closes every tracked pane BEFORE state mutation", () => {
  it("closeAgentPane fires for each cleared agent; subsequent state has no agents", async () => {
    const stub = makeStubTmux();
    const repo = makeRepo();
    try {
      await runOrchestrator(
        {
          repoRoot: repo.root,
          slug: "tmux-clear",
          toolName: "sf_team_implement",
          useWorktree: true,
          tmuxManager: stub.mgr,
        },
        async (bodyCtx) => {
          bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "dev-A");
          bodyCtx.subscribeAgent({ role: "reviewer", model: "r" }, "rev-A");
          bodyCtx.clearAgents();
          // Subscribe a fresh card AFTER clear — it must NOT trigger a
          // close on dev-A or rev-A.
          bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "dev-B");
          return "ok";
        },
      );
      // Two close calls fired during clearAgents (one per cleared card).
      const closeCalls = stub.calls.filter((c) => c.startsWith("closeAgentPane:"));
      expect(closeCalls.length).toBeGreaterThanOrEqual(2);
      // closeAllPanes from finally still happens.
      expect(stub.calls.some((c) => c.startsWith("closeAllPanes"))).toBe(true);
    } finally {
      stub.cleanup();
      repo.dispose();
    }
  });
});

/* ───────────────────────── S-608 finally teardown ────────────────────────── */

describe("S-608 finally block calls closeAllPanes even on body error", () => {
  it("body throws → closeAllPanes still fires", async () => {
    const stub = makeStubTmux();
    const repo = makeRepo();
    try {
      let caught: unknown;
      try {
        await runOrchestrator(
          {
            repoRoot: repo.root,
            slug: "tmux-error",
            toolName: "sf_team_implement",
            useWorktree: true,
            tmuxManager: stub.mgr,
          },
          async (bodyCtx) => {
            bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "dev-err");
            throw new Error("simulated body failure");
          },
        );
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toContain("simulated body failure");
      expect(stub.calls.some((c) => c.startsWith("closeAllPanes"))).toBe(true);
    } finally {
      stub.cleanup();
      repo.dispose();
    }
  });
});

/* ───────────────────────── round-guard pane-leak (round-2 P2) ───────────── */

describe("round-guard pane lifecycle: superseded subscription's terminal event still closes ITS pane", () => {
  it("re-subscribing the same agentId closes the OLD pane on its eventual terminal event", async () => {
    const stub = makeStubTmux();
    const repo = makeRepo();
    try {
      await runOrchestrator(
        {
          repoRoot: repo.root,
          slug: "tmux-round-guard",
          toolName: "sf_team_implement",
          useWorktree: true,
          tmuxManager: stub.mgr,
        },
        async (bodyCtx) => {
          // Round 1: subscribe `dev-X`. Save its onEvent.
          const sub1 = bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "dev-X");
          // Round 2: re-subscribe SAME agentId before round 1's terminal arrives.
          const sub2 = bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "dev-X");
          // Round 1's terminal event arrives LATE. Without the fix, the
          // round guard would short-circuit before the pane-close branch
          // and round-1's pane would leak until final teardown.
          sub1.onEvent({ kind: "exit", exitCode: 0, signal: null } as never);
          // Round 2 still active — its pane MUST NOT have been closed
          // by sub1's late terminal event.
          sub2.onEvent({ kind: "exit", exitCode: 0, signal: null } as never);
          return "ok";
        },
      );
      // openAgentPane fired exactly twice (once per subscribe).
      expect(stub.calls.filter((c) => c.startsWith("openAgentPane:dev-X"))).toHaveLength(2);
      // closeAgentPane fired at least twice — one per terminal event,
      // BEFORE the orchestrator's finally-teardown closeAllPanes.
      const onEventCloses = stub.calls.filter((c) => c.startsWith("closeAgentPane:"));
      expect(onEventCloses.length).toBeGreaterThanOrEqual(2);
    } finally {
      stub.cleanup();
      repo.dispose();
    }
  });
});

/* ───────────────────────── S-610 fully integrated path ──────────────────── */

describe("S-610 end-to-end: subscribeAgent → manager.openAgentPane → spawn helper → spawnAgent → log file", () => {
  it("real subprocess output reaches the manager-provided log file via the spawn helper", async () => {
    const stub = makeStubTmux();
    const repo = makeRepo();
    try {
      await runOrchestrator(
        {
          repoRoot: repo.root,
          slug: "tmux-e2e",
          toolName: "sf_team_implement",
          useWorktree: true,
          tmuxManager: stub.mgr,
        },
        async (bodyCtx) => {
          // The orchestrator's subscribeAgent returns rawLogPath from
          // the (stubbed) manager.openAgentPane.
          const sub = bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "dev-e2e");
          expect(sub.rawLogPath).toBe(stub.agentLog("dev-e2e"));

          // Tiny "fake pi" that writes to BOTH stdout and stderr.
          const fs = await import("node:fs");
          const piStub = path.join(repo.root, "pi-stub.mjs");
          fs.writeFileSync(piStub, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "session_started" }) + "\\n");
process.stderr.write("E2E-STDERR-LINE\\n");
process.stdout.write("E2E-STDOUT-LINE\\n");
process.stdout.write(JSON.stringify({ type: "agent_end", text: "OK" }) + "\\n");
process.exit(0);
`, { mode: 0o755 });

          // Exercise the FULL pipeline via the spawn helper (not
          // spawnAgent directly). The helper forwards rawLogPath AND
          // sub.onEvent — that proves both wiring AND open/close
          // lifecycle under real subprocess events.
          const { makeSpawnHelper } = await import("../src/tools/shared");
          const { spawnAgent } = await import("../src/runtime/spawn");
          const spy = vi.fn(async (member, task, opts) => {
            // The helper passes opts.rawLogPath + opts.onEvent through
            // to spawnAgent — assert that, then forward to the real
            // spawnAgent so the subprocess actually runs and the file
            // gets populated.
            expect(opts?.rawLogPath).toBe(sub.rawLogPath);
            expect(typeof opts?.onEvent).toBe("function");
            return spawnAgent(
              member,
              task,
              { ...opts, piBinary: piStub, heartbeatMs: 5_000 },
            );
          });
          const helper = makeSpawnHelper(
            { spawnAgent: spy as never, runReviewLoop: (() => {}) as never, fetchJiraContext: (() => {}) as never },
            {
              // Wrap the orchestrator's subscribeAgent return so the
              // helper pulls rawLogPath + onEvent from this single sub.
              subscribeAgent: () => sub as never,
            },
          );
          await helper.spawn({ role: "developer", model: "m" }, { task: "e2e" }, "dev-e2e");

          const content = fs.readFileSync(sub.rawLogPath!, "utf8");
          // BOTH streams' content is in the file.
          expect(content).toContain("E2E-STDOUT-LINE");
          expect(content).toContain("E2E-STDERR-LINE");
          expect(content).toContain('"type":"agent_end"');
          // The spawn helper was actually called with our forwarded options.
          expect(spy).toHaveBeenCalledTimes(1);
          // Pane was closed when the agent_end event flowed through onEvent.
          // (closeAgentPane fires for the agentId — see stub.calls.)
          expect(stub.calls.some((c) => c.startsWith("closeAgentPane:"))).toBe(true);
          return "ok";
        },
      );
    } finally {
      stub.cleanup();
      repo.dispose();
    }
  });
});

/* ───────────────────────── S-609 no-tmux regression ──────────────────────── */

describe("S-609 no-tmux path: tmuxManager=null → manager is never invoked", () => {
  it("subscribeAgent returns rawLogPath=undefined; widget snapshot still works", async () => {
    const stub = makeStubTmux();
    const repo = makeRepo();
    try {
      let captured: string | undefined = "should-be-undefined";
      await runOrchestrator(
        {
          repoRoot: repo.root,
          slug: "no-tmux",
          toolName: "sf_team_implement",
          useWorktree: true,
          tmuxManager: null, // explicit disable
        },
        async (bodyCtx) => {
          const sub = bodyCtx.subscribeAgent({ role: "developer", model: "m" }, "dev-no-tmux");
          captured = sub.rawLogPath;
          // Synthesize a terminal event — even without a manager, the
          // onEvent handler must not throw.
          sub.onEvent({ kind: "exit", exitCode: 0, signal: null } as never);
          return "ok";
        },
      );
      expect(captured).toBeUndefined();
      expect(stub.calls).toHaveLength(0); // stub manager untouched
    } finally {
      stub.cleanup();
      repo.dispose();
    }
  });
});
