import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resolveDefaults } from "../src/config/load";
import { planFolderPath } from "../src/plan/paths";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";
import { TmuxManager } from "../src/tmux/manager";
import { createSfTeamImplement } from "../src/tools/implement";

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

function makeRepo(): { root: string; slug: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-impl-par-tmux-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  const slug = "2026-05-04-parallel-tmux";
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "milestone-plan.md"), "### M1: Tmux\n\n- **S-101 — one.** Body.\n- **S-102 — two.** Body.\n");
  writeFileSync(path.join(folder, "continuation-runbook.md"), "# Runbook\n");
  writeFileSync(
    path.join(folder, "story-tracker.md"),
    `### M1: Tmux

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | one | pending | |
| S-102 | two | pending | |

**Approval Status:** pending
`,
  );
  writeFileSync(
    path.join(folder, "execution-strategy.json"),
    JSON.stringify({
      version: 1,
      maxParallelMilestones: 1,
      maxParallelStoriesPerMilestone: 2,
      milestoneWaves: [{ id: "W1", milestones: ["M1"], maxParallel: 1 }],
      stories: {
        M1: {
          maxParallelStories: 2,
          storyWaves: [
            {
              id: "M1-W1",
              stories: ["S-101", "S-102"],
              maxParallel: 2,
              writeSets: { "S-101": ["one.txt"], "S-102": ["two.txt"] },
            },
          ],
        },
      },
    }),
  );
  return { root, slug, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function stubTmux(): { mgr: TmuxManager; calls: string[] } {
  let pane = 10;
  const calls: string[] = [];
  const mgr = {
    nextSessionAlias(toolName: string): string {
      calls.push(`nextSessionAlias:${toolName}`);
      return `${toolName}-1`;
    },
    prepareSession(args: { sessionName: string; sessionAlias: string }) {
      calls.push(`prepareSession:${args.sessionName}->${args.sessionAlias}`);
      return { sessionName: args.sessionAlias, mainPaneId: "%1", windowId: "@7" };
    },
    openAgentPane(args: {
      agentId: string;
      paneTitle: string;
      layoutRole?: string;
      groupId?: string;
      parentGroupId?: string;
      storyId?: string;
    }) {
      pane += 1;
      calls.push(
        `open:${args.agentId}:${args.paneTitle}:${args.layoutRole ?? ""}:${args.groupId ?? ""}:${args.parentGroupId ?? ""}:${args.storyId ?? ""}`,
      );
      return { paneId: `%${pane}`, logPath: path.join(tmpdir(), `${args.agentId}.log`) };
    },
    closeAgentPane(id: string) {
      calls.push(`close:${id}`);
    },
    closeAllPanes() {
      calls.push("closeAll");
    },
  } as unknown as TmuxManager;
  return { mgr, calls };
}

describe("sf_team_implement parallel tmux panes", () => {
  it("passes story and reviewer layout metadata to tmux panes", async () => {
    const { root, slug, dispose } = makeRepo();
    const tmux = stubTmux();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        if (member.role === "developer") {
          const story = /story (S-\d+)/i.exec(task.task)?.[1] ?? "S-000";
          const cwd = task.cwd ?? root;
          writeFileSync(path.join(cwd, `${story}.txt`), `${story}\n`);
          spawnSync("git", ["add", `${story}.txt`], { cwd });
          return fakeRun(`implemented ${story}`);
        }
        return fakeRun(APPROVED);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never, runReviewLoop });
      await tool(
        {
          slug,
          mode: "single-milestone",
          useWorktree: true,
          branchPrefix: "impl/",
          verifyCommand: false,
          pauseBetweenMilestones: false,
        },
        {
          repoRoot: root,
          configDefaults: resolveDefaults({}),
          tmuxManager: tmux.mgr,
          tmuxSessionName: "fh-agent-aabbccdd",
        },
      );

      expect(tmux.calls).toContain("open:developer-M1-S101:developer-M1-S101:story:M1:M1:S-101");
      expect(tmux.calls).toContain("open:developer-M1-S102:developer-M1-S102:story:M1:M1:S-102");
      expect(tmux.calls).toContain("open:reviewer-M1:reviewer-M1:reviewer:M1::");
      expect(tmux.calls).toContain("closeAll");
    } finally {
      dispose();
    }
  });
});
