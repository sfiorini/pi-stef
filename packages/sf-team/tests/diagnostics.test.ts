import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { writeDiagnostics } from "../src/orchestrator/diagnostics";
import { planFolderPath } from "../src/plan/paths";

describe("M9 writeDiagnostics (S-904)", () => {
  it("returns undefined when no slug is provided (caller logs to console instead)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-diag-"));
    try {
      const r = await writeDiagnostics(root, { toolName: "sf_team_task" });
      expect(r).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a timestamped diagnostics file under the plan folder with stderr tail + last events", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-diag-"));
    try {
      const slug = "2026-05-01-diag";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const file = await writeDiagnostics(
        root,
        {
          slug,
          toolName: "sf_team_task",
          notes: "ran out of patience",
          error: new Error("boom"),
          agentRuns: [
            {
              state: "failed",
              pid: 42,
              parentPid: 1,
              childPids: [43],
              metrics: {
                startedAtMs: 1_000,
                spawnedAtMs: 1_010,
                firstStdoutAtMs: 1_025,
                firstTextDeltaAtMs: 1_050,
                firstToolEventAtMs: 1_060,
                agentEndAtMs: 1_080,
                closeAtMs: 1_100,
                totalDurationMs: 100,
                timeToFirstStdoutMs: 25,
                timeToFirstTextDeltaMs: 50,
                timeFromAgentEndToCloseMs: 20,
              },
              exitCode: 1,
              finalText: "",
              events: [
                { kind: "exit", exitCode: 1, signal: null },
                { kind: "error", message: "boom" },
              ],
              eventsCompacted: false,
              eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
              toolCalls: [],
              stderrTail: "panic: boom\n",
              reason: "boom",
            },
          ],
        },
        new Date("2026-05-01T08:00:00Z"),
      );
      expect(file).toBeDefined();
      expect(file).toMatch(/[/\\]diagnostics[/\\]diagnostics-2026-05-01T08-00-00-000Z\.log$/);
      const body = readFileSync(file as string, "utf8");
      expect(body).toContain("# sf-team diagnostics — sf_team_task");
      expect(body).toContain("ran out of patience");
      expect(body).toContain("name: Error");
      expect(body).toContain("message: boom");
      expect(body).toContain("pid=42 state=failed");
      expect(body).toContain("stderr-tail:");
      expect(body).toContain("panic: boom");
      expect(body).toContain("metrics:");
      expect(body).toContain("totalDurationMs=100");
      expect(body).toContain("timeToFirstTextDeltaMs=50");
      expect(body).toContain("last-events:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
