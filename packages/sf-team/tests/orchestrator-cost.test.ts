import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { runOrchestrator } from "../src/orchestrator/run";
import { reportsFolderPath } from "@pi-stef/agent-workflows";
import type { AgentRun, AgentTokenUsage } from "../src/runtime/types";

function makeRepo(): { root: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-orch-cost-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  mkdirSync(path.join(dir, "ai_plan"), { recursive: true });
  return { root: dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeRun(usage?: AgentTokenUsage): AgentRun {
  return {
    state: "completed",
    pid: 1,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: 0,
    finalText: "ok",
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    usage,
    stderrTail: "",
  };
}

function writeSidecar(root: string, slug: string, name: string, toolName: string, ownerTool: string, cost: number): void {
  const folder = reportsFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(`${folder}/performance-${name}.json`, JSON.stringify({
    schemaVersion: 1,
    slug,
    toolName,
    ownerTool,
    status: "completed",
    startedAt: "2026-05-12T00:00:00.000Z",
    finishedAt: "2026-05-12T00:00:01.000Z",
    runUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: cost, knownCostCount: 1, unknownCostCount: 0 },
  }));
}

describe("runOrchestrator cost aggregation", () => {
  it("tracks live usage by unique spawn key and returns a final cost summary", async () => {
    const { root, dispose } = makeRepo();
    try {
      const setFooter = vi.fn();
      const out = await runOrchestrator(
        {
          repoRoot: root,
          slug: "2026-05-12-cost-live",
          toolName: "sf_team_plan",
          useWorktree: true,
          ui: { setFooter, notify: vi.fn(), confirm: vi.fn() } as never,
        },
        async (ctx) => {
          const first = ctx.subscribeAgent({ role: "planner", model: "m" }, "planner");
          const second = ctx.subscribeAgent({ role: "planner", model: "m" }, "planner");
          expect(first.spawnKey).toBe("planner#1");
          expect(second.spawnKey).toBe("planner#2");

          first.onEvent({
            kind: "usage",
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, costTotal: 0.25 },
          });
          second.onEvent({
            kind: "usage",
            usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, costTotal: 0.5 },
          });
          first.onEvent({ kind: "exit", exitCode: 0, signal: null });
          second.onEvent({ kind: "exit", exitCode: 0, signal: null });

          ctx.recordRun(
            fakeRun({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, costTotal: 0.3 }),
            { role: "planner", model: "m" },
            "planner",
            first.spawnKey,
          );
          return "ok";
        },
      );

      expect(setFooter).toHaveBeenCalled();
      expect(out.costSummary?.settledRunCount).toBe(2);
      expect(out.costSummary?.inFlightRunCount).toBe(0);
      expect(out.costSummary?.current.costTotal).toBe(0.8);
      expect(out.costSummary?.total.costTotal).toBe(0.8);
    } finally {
      dispose();
    }
  });

  it("ignores late usage after recordRun writes authoritative final usage", async () => {
    const { root, dispose } = makeRepo();
    try {
      const out = await runOrchestrator(
        { repoRoot: root, slug: "2026-05-12-cost-late", toolName: "sf_team_task", useWorktree: true },
        async (ctx) => {
          const sub = ctx.subscribeAgent({ role: "developer", model: "m" }, "developer");
          ctx.recordRun(
            fakeRun({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 1 }),
            { role: "developer", model: "m" },
            "developer",
            sub.spawnKey,
          );
          sub.onEvent({
            kind: "usage",
            usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200, costTotal: 99 },
          });
          return "ok";
        },
      );

      expect(out.costSummary?.current.costTotal).toBe(1);
    } finally {
      dispose();
    }
  });

  it("lets recordRun overwrite usage that arrived after a terminal event for the same spawn", async () => {
    const { root, dispose } = makeRepo();
    try {
      const out = await runOrchestrator(
        { repoRoot: root, slug: "2026-05-12-cost-terminal-late", toolName: "sf_team_task", useWorktree: true },
        async (ctx) => {
          const sub = ctx.subscribeAgent({ role: "developer", model: "m" }, "developer");
          sub.onEvent({
            kind: "usage",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 1 },
          });
          sub.onEvent({ kind: "exit", exitCode: 0, signal: null });
          sub.onEvent({
            kind: "usage",
            usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, costTotal: 2 },
          });
          ctx.recordRun(
            fakeRun({ input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200, costTotal: 3 }),
            { role: "developer", model: "m" },
            "developer",
            sub.spawnKey,
          );
          return "ok";
        },
      );

      expect(out.costSummary?.settledRunCount).toBe(1);
      expect(out.costSummary?.current.costTotal).toBe(3);
    } finally {
      dispose();
    }
  });

  it("plan resume includes exact-owner prior reports plus current cost", async () => {
    const { root, dispose } = makeRepo();
    try {
      writeSidecar(root, "2026-05-12-cost-plan-resume", "plan", "sf_team_plan", "sf_team_plan", 1);
      const out = await runOrchestrator(
        { repoRoot: root, slug: "2026-05-12-cost-plan-resume", toolName: "sf_team_plan", useWorktree: true, resumeMode: true },
        async (ctx) => {
          ctx.recordRun(fakeRun({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 0.25 }));
          return "ok";
        },
      );

      expect(out.costSummary?.priorRunCount).toBe(1);
      expect(out.costSummary?.total.costTotal).toBe(1.25);
    } finally {
      dispose();
    }
  });

  it("implement resume excludes prior plan reports for the same slug", async () => {
    const { root, dispose } = makeRepo();
    try {
      writeSidecar(root, "2026-05-12-cost-implement-resume", "plan", "sf_team_plan", "sf_team_plan", 1);
      writeSidecar(root, "2026-05-12-cost-implement-resume", "implement", "sf_team_implement", "sf_team_implement", 2);
      const out = await runOrchestrator(
        { repoRoot: root, slug: "2026-05-12-cost-implement-resume", toolName: "sf_team_implement", useWorktree: true, resumeMode: true },
        async (ctx) => {
          ctx.recordRun(fakeRun({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 0.25 }));
          return "ok";
        },
      );

      expect(out.costSummary?.priorRunCount).toBe(1);
      expect(out.costSummary?.prior.costTotal).toBe(2);
      expect(out.costSummary?.total.costTotal).toBe(2.25);
    } finally {
      dispose();
    }
  });

  it("fresh auto implement phase includes the auto-owned plan report as prior baseline", async () => {
    const { root, dispose } = makeRepo();
    try {
      writeSidecar(root, "2026-05-12-cost-auto", "plan", "sf_team_plan", "sf_team_auto", 1);
      const out = await runOrchestrator(
        { repoRoot: root, slug: "2026-05-12-cost-auto", toolName: "sf_team_implement", ownerTool: "sf_team_auto", useWorktree: true },
        async (ctx) => {
          ctx.recordRun(fakeRun({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, costTotal: 0.25 }));
          return "ok";
        },
      );

      expect(out.costSummary?.priorRunCount).toBe(1);
      expect(out.costSummary?.prior.costTotal).toBe(1);
      expect(out.costSummary?.total.costTotal).toBe(1.25);
    } finally {
      dispose();
    }
  });
});
