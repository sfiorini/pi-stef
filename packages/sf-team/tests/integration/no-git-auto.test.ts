/**
 * S-505: Integration test — sf_team_auto in a non-git tmpdir with gitMode='off'.
 *
 * Verifies:
 *   - Call succeeds without throwing (no assertIsGitRepo error)
 *   - result.implement.milestones contains approved milestones
 *   - commitSha on milestones is undefined (no commit in no-git mode)
 *   - result.implement.prDescriptionPath is undefined (no PR in no-git mode)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamAuto } from "../../src/tools/auto";
import { validPlanText } from "../helpers/valid-plan";
import type { AgentRun } from "../../src/runtime/types";

const APPROVED = `## Summary
ok
## Findings
### P0
- None.
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: APPROVED`;

function fakeRun(text: string): AgentRun {
  return {
    state: "completed",
    pid: 1,
    parentPid: process.pid,
    childPids: [],
    metrics: { startedAtMs: Date.now() },
    exitCode: 0,
    finalText: text,
    events: [],
    eventsCompacted: false,
    eventSummary: { textDeltaCount: 0, thinkingDeltaCount: 0, compactedEventCount: 0 },
    toolCalls: [],
    stderrTail: "",
  };
}

describe("sf_team_auto — no-git tmpdir with gitMode='off'", () => {
  it("succeeds without throwing; milestones approved; commitSha undefined; prDescriptionPath undefined", async () => {
    // tmpdir that is NOT a git repository
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-auto-no-git-"));
    try {
      const spawnAgent = vi.fn(async (member: { role: string }) => {
        if (member.role === "planner") {
          return fakeRun(validPlanText("auto-no-git"));
        }
        if (member.role === "researcher") {
          return fakeRun(
            JSON.stringify({
              agentSettings: {
                planner: { model: "claude-opus-4-5" },
                developer: { model: "claude-opus-4-5" },
                reviewer: { model: "claude-sonnet-4-5" },
              },
              decision: "proceed",
            }),
          );
        }
        // reviewer and developer both return approval
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../../src/review/loop")).runReviewLoop;
      const tool = createSfTeamAuto({ spawnAgent: spawnAgent as never, runReviewLoop });

      const result = await tool(
        {
          title: "No-git auto task",
          brief: "Test brief.",
        },
        { repoRoot, gitMode: "off" },
      );

      expect(result.implement.milestones.length).toBeGreaterThan(0);
      for (const milestone of result.implement.milestones) {
        expect(milestone.approved).toBe(true);
        expect(milestone.commitSha).toBeUndefined();
      }
      expect(result.implement.prDescriptionPath).toBeUndefined();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
