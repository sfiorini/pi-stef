import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { spawnAgent } from "../src/runtime/spawn";
import type { TeamMember } from "../src/runtime/types";

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PI = path.join(FIXTURE_DIR, "fixtures", "mock-pi.mjs");

const member: TeamMember = { role: "reviewer", model: "mock-model" };

/** Detect whether the host can enumerate child PIDs at all (pgrep OR ps -A). */
function pidEnumerationAvailable(): boolean {
  const pg = spawnSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" });
  if (pg.status === 0) return true;
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  return ps.status === 0 && Boolean(ps.stdout && ps.stdout.length > 0);
}

describe("M4 spawnAgent: lifecycle", () => {
  it("happy path: completes, captures finalText, observes tool_call events", async () => {
    const observedKinds: string[] = [];
    const run = await spawnAgent(
      member,
      { task: "review-please" },
      {
        piBinary: MOCK_PI,
        env: {
          ...process.env,
          MOCK_PI_MODE: "happy",
          MOCK_PI_FINAL_TEXT: "## Verdict\nVERDICT: APPROVED",
          MOCK_PI_USAGE: JSON.stringify({ input: 100, output: 25, cacheRead: 10, cacheWrite: 5, totalTokens: 140, cost: { total: 0.01 } }),
          MOCK_PI_CONTEXT_USAGE: JSON.stringify({ tokens: 12_000, contextWindow: 200_000, percent: 6 }),
        },
        onEvent: (event) => {
          observedKinds.push(event.kind);
        },
      },
    );
    expect(run.state).toBe("completed");
    expect(run.exitCode).toBe(0);
    expect(run.finalText).toContain("VERDICT: APPROVED");
    expect(run.toolCalls.map((c) => c.toolName)).toContain("read");
    expect(observedKinds).toContain("usage");
    expect(run.usage).toMatchObject({ input: 100, output: 25, cacheRead: 10, cacheWrite: 5, totalTokens: 140, costTotal: 0.01 });
    expect(run.contextUsage).toEqual({ tokens: 12_000, contextWindow: 200_000, percent: 6 });
    expect(run.toolExecutions?.[0]).toMatchObject({ toolName: "bash", command: "pnpm test", isError: false });
    expect(run.toolExecutions?.[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.metrics.startedAtMs).toBeGreaterThan(0);
    expect(run.metrics.spawnedAtMs).toBeGreaterThanOrEqual(run.metrics.startedAtMs);
    expect(run.metrics.firstStdoutAtMs).toBeGreaterThanOrEqual(run.metrics.startedAtMs);
    expect(run.metrics.firstTextDeltaAtMs).toBeGreaterThanOrEqual(run.metrics.firstStdoutAtMs ?? 0);
    expect(run.metrics.firstToolEventAtMs).toBeGreaterThanOrEqual(run.metrics.firstStdoutAtMs ?? 0);
    expect(run.metrics.agentEndAtMs).toBeGreaterThanOrEqual(run.metrics.firstStdoutAtMs ?? 0);
    expect(run.metrics.closeAtMs).toBeGreaterThanOrEqual(run.metrics.startedAtMs);
    expect(run.metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(run.metrics.timeToFirstStdoutMs).toBeGreaterThanOrEqual(0);
    expect(run.metrics.timeToFirstTextDeltaMs).toBeGreaterThanOrEqual(0);
    expect(run.metrics.timeFromAgentEndToCloseMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("resolves developer skills from the task cwd repo, not the orchestrator cwd", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "ct-spawn-skill-repo-"));
    try {
      const skillDir = path.join(repo, "skills", "mobile", "testing");
      const argvPath = path.join(repo, "argv.json");
      const piPath = path.join(repo, "mock-pi-argv.mjs");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: mobile-testing\ndescription: mobile testing\n---\n# Mobile Testing\n");
      writeFileSync(piPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.ARGV_PATH, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "implemented" }] }] }) + "\\n");\n`, { mode: 0o755 });

      const run = await spawnAgent(
        { role: "developer", model: "mock-model", skills: ["mobile-testing"] },
        { task: "implement-please", cwd: repo },
        {
          piBinary: piPath,
          env: {
            ...process.env,
            ARGV_PATH: argvPath,
          },
        },
      );

      const argv = JSON.parse(readFileSync(argvPath, "utf8")) as string[];
      expect(run.state).toBe("completed");
      expect(argv).toContain("--skill");
      expect(argv).toContain(skillDir);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  it("abort path: AbortSignal triggers killTree → state=aborted", async () => {
    const ctrl = new AbortController();
    const promise = spawnAgent(
      member,
      { task: "stall-please", signal: ctrl.signal, heartbeatMs: 60_000 },
      { piBinary: MOCK_PI, env: { ...process.env, MOCK_PI_MODE: "stall" } },
    );
    setTimeout(() => ctrl.abort(), 200);
    const run = await promise;
    expect(run.state).toBe("aborted");
    expect(run.reason).toMatch(/AbortSignal/);
  }, 30_000);

  it("stderr activity beats the watchdog — long-thinking reviewer is NOT killed mid-thought", async () => {
    // Regression for the bug surfaced by a real sf_team_plan run: pi was
    // emitting stderr during a long reasoning pass while stdout stayed
    // silent, and the 60s heartbeat fired despite the subprocess being
    // alive and working. Fix: stderr beats the watchdog too.
    const run = await spawnAgent(
      member,
      { task: "thinking", heartbeatMs: 300 },
      { piBinary: MOCK_PI, env: { ...process.env, MOCK_PI_MODE: "thinking-stderr" } },
    );
    expect(run.state).toBe("completed");
    expect(run.exitCode).toBe(0);
    expect(run.stderrTail).toContain("thinking...");
  }, 30_000);

  it("stall path: absoluteTimeout exceeded → state=stalled", async () => {
    // Reworked from the original 'heartbeat exceeded → stalled' test. The
    // multi-signal liveness change (88daba3+) means heartbeat alone no
    // longer kills a still-alive child — the watchdog now warns and keeps
    // watching until either kill -0 says the process is gone OR the
    // absolute timeout is exceeded. This test exercises the absolute-
    // timeout safety net by passing a tight `absoluteTimeoutMs`. Test
    // intent (an exhausted-budget DOES kill) is preserved.
    const run = await spawnAgent(
      member,
      { task: "stall-please", heartbeatMs: 200 },
      { piBinary: MOCK_PI, env: { ...process.env, MOCK_PI_MODE: "stall" }, absoluteTimeoutMs: 1500 },
    );
    expect(run.state).toBe("stalled");
    expect(run.reason).toMatch(/heartbeat/);
  }, 30_000);

  it("multi-signal liveness: a child whose stdout is silent but whose process stays alive emits stall-warning events; the run is killed only by absoluteTimeoutMs, not by heartbeatMs alone", async () => {
    // Regression for runs #2 and #3 of the user's sf_team_auto attempts:
    // pi went silent on stdout for several minutes during a long inference
    // call (Anthropic SSE pings consumed inside pi's HTTP layer never
    // reached pi's stdout). The old single-signal watchdog killed pi
    // every time it crossed `heartbeatMs`. The fix: at threshold expiry,
    // run a process-liveness probe; if alive, emit a stall-warning and
    // keep watching. Only kill when probe says dead OR absolute timeout
    // is exceeded.
    //
    // MOCK_PI_MODE=stall emits a `session` event then sleeps 60s with no
    // further output — perfect simulation of the silent-but-alive case.
    // We bound the test runtime with a small absoluteTimeoutMs and
    // assert TIMING (not just event order) so a broken impl that fires
    // stalled at heartbeat threshold cannot pass.
    const HEARTBEAT_MS = 200;
    const ABSOLUTE_TIMEOUT_MS = 1500;
    const startedAt = Date.now();
    // Capture the precise moment the stalled event is recorded — independent
    // of when spawnAgent's promise eventually resolves (which adds the
    // SIGTERM-grace wait of ~2s on top, blurring the timing assertion).
    let stalledFiredAtMs: number | undefined;
    const run = await spawnAgent(
      member,
      { task: "stall-please", heartbeatMs: HEARTBEAT_MS },
      {
        piBinary: MOCK_PI,
        env: { ...process.env, MOCK_PI_MODE: "stall" },
        absoluteTimeoutMs: ABSOLUTE_TIMEOUT_MS,
        onEvent: (e) => {
          if (e.kind === "stalled" && stalledFiredAtMs === undefined) {
            stalledFiredAtMs = Date.now();
          }
        },
      },
    );
    // The run IS killed (by the absolute-timeout safety net), but at least
    // one stall-warning event must be recorded BEFORE the kill so users
    // can see "pi went silent at T but was alive past T+heartbeat".
    expect(run.state).toBe("stalled");
    const stallWarnings = run.events.filter((e) => e.kind === "stall-warning");
    expect(stallWarnings.length).toBeGreaterThanOrEqual(1);
    // Each warning carries the silence duration (≥ heartbeatMs).
    for (const w of stallWarnings) {
      if (w.kind === "stall-warning") {
        expect(w.silenceMs).toBeGreaterThanOrEqual(HEARTBEAT_MS);
      }
    }
    // The warning(s) appeared BEFORE the stalled event in the event order.
    const firstWarn = run.events.findIndex((e) => e.kind === "stall-warning");
    const stallIdx = run.events.findIndex((e) => e.kind === "stalled");
    expect(firstWarn).toBeGreaterThanOrEqual(0);
    expect(stallIdx).toBeGreaterThan(firstWarn);
    // CRITICAL TIMING ASSERTION: a broken implementation that records
    // `stalled` at the heartbeat threshold (~200ms) instead of waiting
    // for the absolute timeout (~1500ms) must fail this test.
    //
    // We measure the time of the `stalled` EVENT, not spawnAgent's return,
    // because the return is delayed by the SIGTERM-grace wait (~2s). If
    // we used the return time, a broken impl killing at 200ms would still
    // appear at 200 + 2000 = 2200ms — falsely passing a "≥ 1250ms" check.
    expect(stalledFiredAtMs).toBeDefined();
    const stalledRelMs = stalledFiredAtMs! - startedAt;
    // Sampler floor is 50ms in probe-mode + heartbeat=200ms threshold +
    // absolute=1500ms; the stalled event must fire AT OR AFTER the
    // absolute timeout (with a small tolerance for sampler granularity).
    expect(stalledRelMs).toBeGreaterThanOrEqual(ABSOLUTE_TIMEOUT_MS - 100);
    expect(stalledRelMs).toBeLessThan(ABSOLUTE_TIMEOUT_MS + 1_500);
  }, 30_000);

  it("nested cleanup: grandchild dies when parent group is killed on abort", async () => {
    const ctrl = new AbortController();
    const promise = spawnAgent(
      member,
      { task: "spawn-child", signal: ctrl.signal, heartbeatMs: 60_000 },
      { piBinary: MOCK_PI, env: { ...process.env, MOCK_PI_MODE: "spawn-child" } },
    );
    // Wait for grandchild to spawn. Bumped from 800ms to 3000ms because
    // under full-suite parallel load the grandchild can take longer to fork
    // and emit its PID to stderr before the abort.
    await new Promise((r) => setTimeout(r, 3000));
    ctrl.abort();
    const run = await promise;
    expect(run.state).toBe("aborted");
    // Grandchild pid surfaced on stderr from the mock-pi script.
    expect(run.stderrTail).toMatch(/grandchild=\d+/);

    // Verify the grandchild is DEAD post-killTree (not just the direct child).
    const grandchildMatch = run.stderrTail.match(/grandchild=(\d+)/);
    expect(grandchildMatch).not.toBeNull();
    const grandchildPid = Number(grandchildMatch![1]);
    // Wait for the SIGTERM-grace + SIGKILL phase to fully drain.
    await new Promise((r) => setTimeout(r, 2_500));
    let alive = true;
    try {
      process.kill(grandchildPid, 0); // signal 0 = check existence
    } catch {
      alive = false; // ESRCH -> grandchild is gone
    }
    expect(alive).toBe(false);

    // childPids is BEST-EFFORT: it depends on the host having a working
    // child-PID enumerator (pgrep or ps -A). In sandboxes where both are
    // restricted (e.g. read-only review environments), childPids may be empty
    // even when grandchildren existed and were correctly killed. We assert
    // the populated case only when the host actually supports enumeration —
    // the cleanup contract above (grandchild dies) is the load-bearing check.
    if (pidEnumerationAvailable()) {
      expect(run.childPids.length).toBeGreaterThanOrEqual(1);
      expect(run.childPids).toContain(grandchildPid);
    } else {
      expect(run.childPids).toEqual([]);
    }
  }, 30_000);
});
