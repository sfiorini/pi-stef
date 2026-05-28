/**
 * S-403: RED test for plan-tool aiPlanPath wiring.
 *
 * Verifies that when `aiPlanPath` is supplied:
 *   1. The 5-file plan folder is written under aiPlanPath/<slug>/, not under repoRoot/ai_plan/<slug>/.
 *   2. The handler accepts aiPlanPath in its input (type check).
 *
 * Confirm RED before S-404/S-405 land.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../src/tools/plan";
import { validPlanText } from "./helpers/valid-plan";

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

function makeGitRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-ai-plan-path-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "x");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("plan tool aiPlanPath wiring", () => {
  it("writes 5-file folder under aiPlanPath/<slug>/, not under repoRoot/ai_plan/", async () => {
    const { root: repoRoot, dispose: disposeRepo } = makeGitRepo();
    const plansRoot = mkdtempSync(path.join(tmpdir(), "ct-plans-root-"));
    try {
      const spawnAgent = vi.fn(async (member: { role: string }) => {
        if (member.role === "planner") return fakeRun(validPlanText("ai-plan-path-test"));
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });

      const result = await tool(
        { title: "AI Plan Path Test", aiPlanPath: plansRoot },
        { repoRoot },
      );

      expect(result.approved).toBe(true);

      // The plan folder must be under plansRoot, not under repoRoot/ai_plan
      const folderUnderAiPlanPath = path.join(plansRoot, result.slug);
      const folderUnderRepoAiPlan = path.join(repoRoot, "ai_plan", result.slug);

      expect(existsSync(path.join(folderUnderAiPlanPath, "milestone-plan.md"))).toBe(true);
      expect(existsSync(path.join(folderUnderRepoAiPlan, "milestone-plan.md"))).toBe(false);

      // folderPath in result must also reflect the aiPlanPath location
      expect(result.folderPath).toBe(folderUnderAiPlanPath);
    } finally {
      disposeRepo();
      rmSync(plansRoot, { recursive: true, force: true });
    }
  });
});
