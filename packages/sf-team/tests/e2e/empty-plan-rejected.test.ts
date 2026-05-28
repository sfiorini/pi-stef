import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSfTeamPlan } from "../../src/tools/plan";
import { EmptyPlanError } from "../../src/orchestrator/empty-plan-error";
import { slugify } from "../../src/plan/slug";
import { planFolderPath } from "../../src/plan/paths";
import type { AgentRun, AgentTask, TeamMember } from "../../src/runtime/types";

/* M8 S-802: end-to-end rejection of the user's actual failing PID-40957
 * refusal transcript through the validators. Asserts EmptyPlanError +
 * ui.notify + transcript file. */

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

const REFUSAL_FIXTURE = path.resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "fixtures",
  "planner-refusal-pid40957.md",
);

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-e2e-reject-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("S-802 empty-plan rejection (S-107 fixture, end-to-end)", () => {
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => repo.dispose());

  it("user's PID-40957 refusal fixture: EmptyPlanError thrown + ui.notify called + transcript written", async () => {
    const refusalText = readFileSync(REFUSAL_FIXTURE, "utf8");
    const spawnAgent = vi.fn(async (member: TeamMember) =>
      fakeRun(member.role === "planner" ? refusalText : APPROVED),
    );
    const runReviewLoop = (await import("../../src/review/loop")).runReviewLoop;
    const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never, runReviewLoop });
    const ui = {
      notify: vi.fn(),
      confirm: async () => true,
      select: async () => undefined,
      input: async () => "",
    } as never;

    let caught: unknown;
    try {
      await tool(
        { title: "Refusal Smoke", brief: "go", analysisOverride: null, answersOverride: {} },
        { repoRoot: repo.root, ui },
      );
    } catch (err) {
      caught = err;
    }

    // 1. EmptyPlanError thrown.
    expect(caught).toBeInstanceOf(EmptyPlanError);

    // 2. ui.notify was called with an error-level message pointing at diagnostics.
    const notify = (ui as { notify: ReturnType<typeof vi.fn> }).notify;
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/empty\/refusal plan/i);
    expect(notify.mock.calls[0][1]).toBe("error");

    // 3. transcript/<NNNN>-system-validation-failed-FAILED.md exists.
    const slug = slugify("Refusal Smoke");
    const transcriptDir = path.join(planFolderPath(repo.root, slug), "transcript", "planning");
    expect(existsSync(transcriptDir)).toBe(true);
    const files = readdirSync(transcriptDir);
    const validation = files.find((f) => /system-validation-failed-FAILED\.md$/.test(f));
    expect(validation, `expected validation-failed transcript; got ${files.join(", ")}`).toBeDefined();
    const body = readFileSync(path.join(transcriptDir, validation!), "utf8");
    expect(body).toContain("PID 40957"); // raw payload preserved

    // 4. diagnostics file written by runOrchestrator's catch block, now
    // bucketed under the diagnostics/ subfolder of the plan root.
    const planFolder = planFolderPath(repo.root, slug);
    const diagnosticsFolder = path.join(planFolder, "diagnostics");
    expect(existsSync(diagnosticsFolder)).toBe(true);
    const diagnosticsEntries = readdirSync(diagnosticsFolder);
    const diagnostics = diagnosticsEntries.find((f) => /^diagnostics-.*\.log$/.test(f));
    expect(
      diagnostics,
      `expected diagnostics-*.log under ${diagnosticsFolder}; got ${diagnosticsEntries.join(", ")}`,
    ).toBeDefined();
    const diagText = readFileSync(path.join(diagnosticsFolder, diagnostics!), "utf8");
    // Diagnostics include the error context (EmptyPlanError) and at
    // least one recorded AgentRun (the planner's refusal output).
    expect(diagText).toMatch(/EmptyPlanError/i);
  });
});
