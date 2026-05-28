import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { loadBaseline } from "../src/plan/baseline";
import { planFolderPath, PLAN_FOLDER_ROOT } from "../src/plan/paths";
import { runOrchestrator } from "../src/orchestrator/run";
import type { AgentRun } from "../src/runtime/types";

function makeRepo(): { root: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-orch-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return { root: dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("M9 runOrchestrator baseline matrix (S-911)", () => {
  it("useWorktree=false → baseline.json is written before body runs", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-01-baseline-true";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const body = vi.fn(async (ctx) => {
        // Body sees the baseline.
        expect(ctx.baseline?.headSha).toMatch(/^[0-9a-f]{40}$/);
        return "ok";
      });
      const { result } = await runOrchestrator(
        { repoRoot: root, slug, toolName: "sf_team_task", useWorktree: false },
        body,
      );
      expect(result).toBe("ok");
      const reloaded = await loadBaseline(path.join(root, PLAN_FOLDER_ROOT), slug);
      expect(reloaded?.headSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      dispose();
    }
  });

  it("useWorktree=true → baseline.json is NOT written", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-01-baseline-skip";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const body = vi.fn(async (ctx) => {
        expect(ctx.baseline).toBeUndefined();
        return "ok";
      });
      await runOrchestrator(
        { repoRoot: root, slug, toolName: "sf_team_implement", useWorktree: true },
        body,
      );
      const reloaded = await loadBaseline(path.join(root, PLAN_FOLDER_ROOT), slug);
      expect(reloaded).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("useWorktree=true on a RESUMED run with prior baseline → loads it", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-01-baseline-resume";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      // Plant a baseline as if a prior run had captured it.
      const baselinePath = path.join(planFolderPath(root, slug), "baseline.json");
      writeFileSync(baselinePath, JSON.stringify({ headSha: "deadbeef".repeat(5), porcelainStatus: "", capturedAt: "2026-05-01T00:00:00Z" }));
      let observedHeadSha: string | undefined;
      await runOrchestrator(
        { repoRoot: root, slug, toolName: "sf_team_followup", useWorktree: true },
        async (ctx) => {
          observedHeadSha = ctx.baseline?.headSha;
          return undefined;
        },
      );
      expect(observedHeadSha).toBe("deadbeef".repeat(5));
    } finally {
      dispose();
    }
  });
});

describe("M9 runOrchestrator teardown (S-902/S-903)", () => {
  it("releases the lock + disposes the widget on the SUCCESS path", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-01-teardown-ok";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const widgetDispose = vi.fn();
      await runOrchestrator(
        {
          repoRoot: root,
          slug,
          toolName: "sf_team_task",
          useWorktree: false,
          widget: { update: vi.fn(), dispose: widgetDispose },
        },
        async () => "done",
      );
      expect(widgetDispose).toHaveBeenCalledTimes(1);
      // Lock file should be gone.
      const lockPath = path.join(planFolderPath(root, slug), ".sf-team.lock");
      expect(spawnSync("test", ["-d", lockPath]).status).not.toBe(0);
    } finally {
      dispose();
    }
  });

  it("on SUCCESS: writes a performance report with recorded agent timings", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-01-performance-ok";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const fakeRun: AgentRun = {
        state: "completed",
        pid: 123,
        parentPid: 456,
        childPids: [],
        metrics: {
          startedAtMs: 1_000,
          totalDurationMs: 2_500,
          timeToFirstTextDeltaMs: 300,
          timeFromAgentEndToCloseMs: 25,
        },
        exitCode: 0,
        finalText: "done",
        events: [],
        eventsCompacted: false,
        eventSummary: { textDeltaCount: 7, thinkingDeltaCount: 0, compactedEventCount: 0 },
        toolCalls: [{ toolName: "read", input: { path: "README.md" } }],
        usage: { input: 1_000, output: 200, cacheRead: 50, cacheWrite: 25, totalTokens: 1_275, costTotal: 0.02 },
        contextUsage: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
        toolExecutions: [{ toolName: "bash", command: "pnpm test", startedAtMs: 1_100, finishedAtMs: 2_100, durationMs: 1_000, isError: false }],
        stderrTail: "",
      };
      const out = await runOrchestrator(
        {
          repoRoot: root,
          slug,
          toolName: "sf_team_plan",
          useWorktree: true,
          workflowProfile: "headless",
          reviewRoundLimits: { maxRounds: 4, planMaxRounds: 3, implementationMaxRounds: 4 },
        },
        async (ctx) => {
          ctx.recordRun(fakeRun, { role: "planner", model: "test-model", thinking: "low" }, "planner-1");
          return "done";
        },
      );
      expect(out.performanceReportPath).toMatch(/[/\\]reports[/\\]performance-.*\.md$/);
      const body = readFileSync(out.performanceReportPath!, "utf8");
      const sidecar = JSON.parse(readFileSync(out.performanceReportPath!.replace(/\.md$/, ".json"), "utf8"));
      expect(body).toContain("# sf-team performance — sf_team_plan");
      expect(body).toContain("- **owner tool**: sf_team_plan");
      expect(body).toContain("- **run cost**: $0.02");
      expect(body).toContain("- **total cost including prior**: $0.02");
      expect(body).toContain("planner-1 | planner | test-model | completed");
      expect(body).toContain("2.50s");
      expect(body).toContain("workflow profile**: headless");
      expect(body).toContain("review round limits**: fallback=4, plan=3, implementation=4");
      expect(body).toContain("## Token Usage");
      expect(body).toContain("1,275");
      expect(body).toContain("## Tool Execution Timing");
      expect(body).toContain("pnpm test");
      expect(body).toContain("12,000/200,000 (6.0%)");
      expect(body).toContain("## Phase Totals");
      expect(body).toContain("## Role Totals");
      expect(sidecar).toMatchObject({
        schemaVersion: 1,
        slug,
        toolName: "sf_team_plan",
        ownerTool: "sf_team_plan",
        status: "completed",
        runUsage: { totalTokens: 1_275, costTotal: 0.02, knownCostCount: 1 },
        costSummary: { total: { totalTokens: 1_275, costTotal: 0.02, knownCostCount: 1 } },
      });
    } finally {
      dispose();
    }
  });

  it("on ERROR: writes diagnostics + releases lock + disposes widget BEFORE error propagates", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-01-teardown-error";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const widgetDispose = vi.fn();
      const widget = { update: vi.fn(), dispose: widgetDispose };
      await expect(
        runOrchestrator(
          { repoRoot: root, slug, toolName: "sf_team_task", useWorktree: false, widget },
          async () => {
            throw new Error("synthetic body failure");
          },
        ),
      ).rejects.toThrow(/synthetic body failure/);
      expect(widgetDispose).toHaveBeenCalledTimes(1);
      // Diagnostics file should exist under diagnostics/, performance under reports/.
      const folder = planFolderPath(root, slug);
      const diagnosticsLs = spawnSync("ls", [path.join(folder, "diagnostics")], { encoding: "utf8" });
      expect(diagnosticsLs.stdout).toMatch(/diagnostics-/);
      const reportsLs = spawnSync("ls", [path.join(folder, "reports")], { encoding: "utf8" });
      expect(reportsLs.stdout).toMatch(/performance-/);
      const performanceFile = reportsLs.stdout.split("\n").find((line) => /^performance-.*\.md$/.test(line));
      expect(performanceFile).toBeTruthy();
      const performanceBody = readFileSync(path.join(folder, "reports", performanceFile!), "utf8");
      expect(performanceBody).toContain("- **status**: failed");
      expect(performanceBody).toContain("Error: synthetic body failure");
    } finally {
      dispose();
    }
  });
});

describe("M9 runOrchestrator signal forwarding (S-902)", () => {
  it("forwards ctx.signal into the body context (same object reference)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-01-signal";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const ctrl = new AbortController();
      let observed: AbortSignal | undefined;
      await runOrchestrator(
        { repoRoot: root, slug, toolName: "sf_team_task", useWorktree: false, signal: ctrl.signal },
        async (bodyCtx) => {
          observed = bodyCtx.signal;
          return "ok";
        },
      );
      // Same object reference: bodyCtx.signal === ctx.signal. This is the
      // load-bearing contract — every callee that takes an AbortSignal will
      // share the same source of truth.
      expect(observed).toBe(ctrl.signal);
    } finally {
      dispose();
    }
  });

  it("an aborted parent signal is observable INSIDE the body via the forwarded signal", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-01-signal-aborted";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const ctrl = new AbortController();
      ctrl.abort(); // pre-aborted before runOrchestrator
      await runOrchestrator(
        { repoRoot: root, slug, toolName: "sf_team_task", useWorktree: false, signal: ctrl.signal },
        async (bodyCtx) => {
          expect(bodyCtx.signal?.aborted).toBe(true);
          return "ok";
        },
      );
    } finally {
      dispose();
    }
  });
});

describe("M9 runOrchestrator declined-resume short-circuit (S-906)", () => {
  it("returns declinedResume=true without acquiring lock or running body when user says no", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-01-decline";
      const folder = planFolderPath(root, slug);
      mkdirSync(folder, { recursive: true });
      // Plant tracker with an in-dev story so the resume prompt fires.
      writeFileSync(
        path.join(folder, "story-tracker.md"),
        `### M0: First

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | x | in-dev | wip |

**Approval Status:** pending
`,
      );
      writeFileSync(path.join(folder, "task-plan.md"), "# task");
      const body = vi.fn(async () => "should-not-run");
      const ui = {
        confirm: vi.fn().mockResolvedValue(false),
        notify: vi.fn(),
        select: vi.fn(),
        input: vi.fn(),
        setWidget: vi.fn(),
      } as unknown as Parameters<typeof runOrchestrator>[0]["ui"];
      const result = await runOrchestrator(
        { repoRoot: root, slug, toolName: "sf_team_task", useWorktree: false, ui },
        body,
      );
      expect(result.declinedResume).toBe(true);
      expect(body).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
