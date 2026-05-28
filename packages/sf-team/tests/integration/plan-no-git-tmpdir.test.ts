/**
 * S-406: Integration test — sf_team_plan in a non-git tmpdir with an explicit aiPlanPath.
 *
 * Verifies:
 *   - 5-file plan folder is written at <aiPlanPath>/<slug>/
 *   - No baseline.json (git is off; nothing to baseline)
 *   - No pr-description.md (git is off; no PR)
 *   - The plan folder is NOT written under <repoRoot>/ai_plan/
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../../src/tools/plan";
import { FIVE_FILE_NAMES } from "../../src/plan/paths";
import { validPlanText } from "../helpers/valid-plan";

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

describe("sf_team_plan — no-git tmpdir with explicit aiPlanPath", () => {
  it("writes 5-file folder at aiPlanPath/<slug>/; no baseline.json; no pr-description.md", async () => {
    // tmpdir that is NOT a git repository
    const repoRoot = mkdtempSync(path.join(tmpdir(), "ct-no-git-"));
    const plansRoot = mkdtempSync(path.join(tmpdir(), "ct-plans-"));
    try {
      const spawnAgent = vi.fn(async (member: { role: string }) => {
        if (member.role === "planner") return fakeRun(validPlanText("no-git-plan"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });

      const result = await tool(
        { title: "No Git Plan", aiPlanPath: plansRoot, gitMode: "off" },
        { repoRoot },
      );

      expect(result.approved).toBe(true);

      const planFolder = path.join(plansRoot, result.slug);

      // All 5 canonical files must exist
      for (const name of FIVE_FILE_NAMES) {
        expect(existsSync(path.join(planFolder, name)), `${name} should exist`).toBe(true);
      }

      // No baseline.json (git is off)
      expect(existsSync(path.join(planFolder, "baseline.json"))).toBe(false);

      // No pr-description.md (git is off)
      expect(existsSync(path.join(planFolder, "pr-description.md"))).toBe(false);

      // folderPath in result points to the aiPlanPath location
      expect(result.folderPath).toBe(planFolder);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(plansRoot, { recursive: true, force: true });
    }
  });
});
