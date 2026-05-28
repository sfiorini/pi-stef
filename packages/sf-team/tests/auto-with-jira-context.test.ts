import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamAuto } from "../src/tools/auto";
import type { JiraContextResult } from "../src/research/jira-context";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
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

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-auto-jira-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "x");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  mkdirSync(path.join(root, "ai_plan"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

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

describe("sf_team_auto with Atlassian Jira context", () => {
  it("invokes deps.fetchJiraContext exactly once across the full plan + implement chain", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember, _task: AgentTask) => {
        if (member.role === "planner") return fakeRun(validPlanText("auto-jira"));
        if (member.role === "developer") return fakeRun("dev done");
        return fakeRun(APPROVED);
      });
      const fetchJiraContext = vi.fn(
        async (): Promise<JiraContextResult> => ({
          status: "used",
          detectedKeys: ["ABC-123"],
          confluenceUrls: [],
          fetchedCount: 1,
          markdown: "# ABC-123\nRendered.",
        }),
      );
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamAuto({
        spawnAgent: spawnAgent as never,
        runReviewLoop,
        fetchJiraContext: fetchJiraContext as never,
      });
      const ui = {
        select: async () => undefined,
        input: async () => "8080",
        confirm: async () => true,
        notify: () => undefined,
      } as never;
      // The implement phase may fail later (the developer stub doesn't stage a
      // real change). We only care that fetchJiraContext was called exactly
      // once before any failure: by the inner plan call, NOT by implement.
      try {
        await tool(
          { title: "Auto ABC-123", brief: "Resolve ABC-123", verifyCommand: false },
          { repoRoot: root, ui },
        );
      } catch {
        // expected — implement may bail when the developer stages nothing
      }
      expect(fetchJiraContext).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });

  it("propagates implement verification output when auto fails during verification", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "planner") return fakeRun(validPlanText("auto-verify"));
        if (member.role === "developer") {
          const cwd = task.cwd ?? root;
          const rel = "auto-verification-touch.md";
          writeFileSync(path.join(cwd, rel), "changed\n");
          spawnSync("git", ["add", rel], { cwd });
          return fakeRun("dev done");
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamAuto({ spawnAgent: spawnAgent as never, runReviewLoop });
      const ui = {
        select: async () => undefined,
        input: async () => "8080",
        confirm: async () => true,
        notify: () => undefined,
      } as never;

      let thrown: Error | null = null;
      try {
        await tool(
          {
            title: "Auto verify output",
            brief: "Force verification to fail",
            verifyCommand: {
              cmd: process.execPath,
              args: ["-e", "console.error('auto stderr marker'); console.log('auto stdout marker'); process.exit(7)"],
            },
          },
          { repoRoot: root, ui },
        );
      } catch (e) {
        thrown = e instanceof Error ? e : new Error(String(e));
      }

      expect(thrown).not.toBeNull();
      expect(thrown!.message).toContain("sf_team_implement: verification gate failed");
      expect(thrown!.message).toContain("cwd:");
      expect(thrown!.message).toContain("auto stderr marker");
      expect(thrown!.message).toContain("auto stdout marker");
    } finally {
      dispose();
    }
  });
});
