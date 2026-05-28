import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSfTeamAuto } from "../../src/tools/auto";
import { resolveDefaults } from "../../src/config/load";
import { validPlanText } from "../helpers/valid-plan";
import type { AgentRun, AgentTask, TeamMember } from "../../src/runtime/types";

/* M8 S-801: full happy-path sf_team_auto run in a tmpdir repo with
 * canned planner/reviewer/developer responses. Asserts the 5-file plan
 * folder is populated and pr-description.md is generated. */

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

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-e2e-smoke-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("S-801 sf_team_auto smoke (full happy path)", () => {
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => repo.dispose());

  it("plans + writes the 5-file folder; milestone-plan and original-plan are non-empty", async () => {
    let devCount = 0;
    const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
      if (member.role === "planner") {
        return fakeRun(validPlanText("e2e-smoke"));
      }
      if (member.role === "developer") {
        devCount++;
        const cwd = task.cwd ?? repo.root;
        // Make a real change so commit can succeed.
        const fs = await import("node:fs");
        fs.writeFileSync(path.join(cwd, `dev-${devCount}.md`), `dev ${devCount}\n`);
        spawnSync("git", ["add", `dev-${devCount}.md`], { cwd });
        return fakeRun("dev done");
      }
      return fakeRun(APPROVED);
    });
    const runReviewLoop = (await import("../../src/review/loop")).runReviewLoop;
    const auto = createSfTeamAuto({ spawnAgent: spawnAgent as never, runReviewLoop });

    const result = await auto(
      { title: "Smoke Test", brief: "go", analysisOverride: null, answersOverride: {} } as never,
      {
        repoRoot: repo.root,
        configDefaults: resolveDefaults({
          auto: { use_worktree: false, pause_between_milestones: false },
        }),
      },
    );

    expect(result.slug).toMatch(/^\d{4}-\d{2}-\d{2}-smoke-test$/);
    expect(result.researcherDecision).toBeDefined();
    expect(result.agentSettings.developer).toMatchObject({ model: "claude-sonnet-4-6", thinking: "medium", heartbeatMs: 600_000 });

    const folder = path.join(repo.root, "ai_plan", result.slug);
    expect(existsSync(folder)).toBe(true);

    // S-801 acceptance: plan files non-empty.
    const milestonePlan = readFileSync(path.join(folder, "milestone-plan.md"), "utf8");
    expect(milestonePlan.length).toBeGreaterThan(200);
    expect(milestonePlan).toContain("M0");
    expect(milestonePlan).toContain("M1");

    const originalPlan = readFileSync(path.join(folder, "original-plan.md"), "utf8");
    expect(originalPlan).toBe(milestonePlan);

    // Story-tracker count: validPlanText emits 2 stories under M0
    // (S-001, S-002) and 1 story under M1 (S-101). The smoke test
    // asserts the EXACT count, not just presence.
    const tracker = readFileSync(path.join(folder, "story-tracker.md"), "utf8");
    expect(tracker).toContain("### M0");
    expect(tracker).toContain("### M1");
    expect(tracker).toContain("S-001");
    expect(tracker).toContain("S-002");
    expect(tracker).toContain("S-101");
    // Three story rows total (one per S- id).
    const storyRows = tracker.split("\n").filter((line) => /^\| S-\d{3} \|/.test(line));
    expect(storyRows).toHaveLength(3);

    // pr-description.md (note hyphen) was generated.
    expect(result.implement.prDescriptionPath).toBeDefined();
    expect(path.basename(result.implement.prDescriptionPath!)).toBe("pr-description.md");
    // The pr-description file was actually written.
    expect(existsSync(result.implement.prDescriptionPath!)).toBe(true);

    // BOTH milestones (M0 + M1) ran to completion via the all-milestones
    // mode + pause_between_milestones=false defaults of sf_team_auto.
    expect(result.implement.milestones).toHaveLength(2);
    expect(result.implement.milestones.every((m) => m.approved)).toBe(true);
    expect(result.implement.milestones.map((m) => m.id)).toEqual(["M0", "M1"]);
  });
});
