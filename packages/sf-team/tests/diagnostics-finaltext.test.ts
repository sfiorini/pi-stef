import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { writeDiagnostics } from "../src/orchestrator/diagnostics";
import type { AgentRun } from "../src/runtime/types";

function fakeRun(finalText: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    state: "completed",
    pid: 42,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: 0,
    finalText,
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    stderrTail: "",
    ...overrides,
  };
}

describe("audit fix: writeDiagnostics includes per-run finalText", () => {
  it("writes finalText for each agent run under a `final-text:` block", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "diag-finaltext-"));
    try {
      const out = await writeDiagnostics(repoRoot, {
        slug: "x",
        toolName: "sf_team_plan",
        agentRuns: [
          fakeRun("planner draft body here"),
          fakeRun("reviewer ## Verdict\nVERDICT: REVISE"),
        ],
      });
      expect(out).toBeDefined();
      const body = readFileSync(out!, "utf8");
      expect(body).toContain("final-text:");
      expect(body).toContain("planner draft body here");
      expect(body).toContain("VERDICT: REVISE");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("truncates finalText > 4096 bytes with a marker", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "diag-finaltext-trunc-"));
    try {
      const huge = "x".repeat(8000);
      const out = await writeDiagnostics(repoRoot, {
        slug: "x",
        toolName: "sf_team_plan",
        agentRuns: [fakeRun(huge)],
      });
      const body = readFileSync(out!, "utf8");
      expect(body).toMatch(/truncated; finalText was 8000 bytes/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
