/**
 * S-501: Integration test — sf_team_task in a non-git tmpdir with gitMode='off'.
 *
 * Verifies:
 *   - Call succeeds without throwing (no assertIsGitRepo error)
 *   - result.approved === true
 *   - result.commitSha is undefined (no commit in no-git mode)
 *   - result.prDescriptionPath is undefined (no PR in no-git mode)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamTask } from "../../src/tools/task";

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

function fakeRun(text: string) {
  return {
    state: "completed" as const,
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

describe("sf_team_task — no-git tmpdir with gitMode='off'", () => {
  it("succeeds without throwing; commitSha and prDescriptionPath are undefined", async () => {
    // tmpdir that is NOT a git repository
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-task-no-git-"));
    try {
      const spawnAgent = vi.fn(async (member: { role: string }) => {
        if (member.role === "planner") {
          return fakeRun(`Draft a single-file task plan for: No-git task

Brief:
Test brief.

## Plan

### M0: Do the thing

**Description:** Implement the feature.

**Acceptance Criteria:**
- [ ] Feature implemented.

**Stories:**
- **S-001 — Implement feature.** Write the code.
`);
        }
        // reviewer and developer both return approval
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });

      const result = await tool(
        {
          title: "No-git task",
          brief: "Test brief.",
          verifyCommand: false,
        },
        { repoRoot, gitMode: "off" },
      );

      expect(result.approved).toBe(true);
      expect(result.commitSha).toBeUndefined();
      expect(result.prDescriptionPath).toBeUndefined();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
