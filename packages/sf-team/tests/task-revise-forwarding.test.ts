import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSfTeamTask } from "../src/tools/task";
import { resolveDefaults } from "../src/config/load";
import type { AgentRun, AgentTask, TeamMember } from "../src/runtime/types";

const REVISE_TEXT_PLAN = `## Summary
plan needs more
## Findings
### P0
- list test cases
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: REVISE`;

const REVISE_TEXT_IMPL = `## Summary
diff missing tests
## Findings
### P0
- add unit test
### P1
- None.
### P2
- None.
### P3
- None.
## Verdict
VERDICT: REVISE`;

const APPROVED_TEXT = `## Summary
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
  const root = mkdtempSync(path.join(tmpdir(), "ct-task-rf-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  mkdirSync(path.join(root, "ai_plan"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeRun(finalText: string): AgentRun {
  return {
    state: "completed",
    pid: 1,
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
  };
}

describe("M10 sf_team_task plan-revise-forwarding (S-A03)", () => {
  it("planner re-spawned on plan-review REVISE; second reviewer call sees revised plan", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const plannerOutputs = ["plan v1", "plan v2-revised"];
      let pIdx = 0;
      // Plan reviewer: REVISE then APPROVE. Then dev reviewer: APPROVE.
      const reviewerOutputs = [REVISE_TEXT_PLAN, APPROVED_TEXT, APPROVED_TEXT];
      let rIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun(plannerOutputs[Math.min(pIdx++, plannerOutputs.length - 1)]);
        if (member.role === "developer") {
          // Stage SOMETHING so the commit gate passes.
          writeFileSync(path.join(root, "feat.ts"), "// impl\n");
          spawnSync("git", ["add", "feat.ts"], { cwd: root });
          return fakeRun("dev impl text");
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Add Foo", brief: "add foo()", allowDirty: true, verifyCommand: false },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "full" } } as never) },
      );
      expect(result.approved).toBe(true);
      expect(result.rounds.plan).toBe(2);

      const plannerCalls = captured.filter((c) => c.member.role === "planner");
      expect(plannerCalls).toHaveLength(2);
      // The revise re-spawn carries the prior plan + findings.
      expect(plannerCalls[1].task.task).toContain("plan v1");
      expect(plannerCalls[1].task.task).toContain("list test cases");

      // Plan reviewer second call sees revised plan.
      const reviewerCalls = captured.filter((c) => c.member.role === "reviewer");
      expect(reviewerCalls[0].task.task).toContain("plan v1");
      expect(reviewerCalls[1].task.task).toContain("plan v2-revised");
    } finally {
      dispose();
    }
  });

  it("default patch mode applies planner patch before the second plan-review call", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      const patch = JSON.stringify({
        operations: [
          {
            op: "replace_within_section",
            target: { topLevelHeading: "Steps" },
            anchor: "old task detail",
            body: "patched task detail",
          },
        ],
      });
      const plannerOutputs = ["## Steps\nold task detail\n", patch];
      let pIdx = 0;
      const reviewerOutputs = [REVISE_TEXT_PLAN, APPROVED_TEXT, APPROVED_TEXT];
      let rIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun(plannerOutputs[Math.min(pIdx++, plannerOutputs.length - 1)]);
        if (member.role === "developer") {
          writeFileSync(path.join(root, "feat.ts"), "// impl\n");
          spawnSync("git", ["add", "feat.ts"], { cwd: root });
          return fakeRun("dev impl text");
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool(
        { title: "Patch Task Plan", brief: "add foo()", allowDirty: true, verifyCommand: false },
        { repoRoot: root, configDefaults: resolveDefaults({ performance: { plan_revision: "patch" } } as never) },
      );

      expect(result.approved).toBe(true);
      expect(result.rounds.plan).toBe(2);
      expect(captured.filter((c) => c.member.role === "planner")).toHaveLength(2);
      const reviewerCalls = captured.filter((c) => c.member.role === "reviewer");
      expect(reviewerCalls[1].task.task).toContain("patched task detail");
    } finally {
      dispose();
    }
  });
});

describe("M10 sf_team_task impl-revise-forwarding (S-A07)", () => {
  it("developer re-spawned on impl-review REVISE; second reviewer call sees the new diff", async () => {
    const { root, dispose } = makeRepo();
    try {
      const captured: { member: TeamMember; task: AgentTask }[] = [];
      // Plan reviewer: APPROVE on round 1. Then dev reviewer: REVISE then APPROVE.
      const reviewerOutputs = [APPROVED_TEXT, REVISE_TEXT_IMPL, APPROVED_TEXT];
      let rIdx = 0;
      let dIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ member, task });
        if (member.role === "planner") return fakeRun("the plan");
        if (member.role === "developer") {
          // Mutate the working tree so readStagedDiff returns DIFFERENT bytes
          // for round 1 vs round 2 — otherwise RevisionUnchangedError fires.
          const file = path.join(root, "feat.ts");
          writeFileSync(file, dIdx === 0 ? "// v1\n" : "// v2 revised\n");
          spawnSync("git", ["add", "feat.ts"], { cwd: root });
          dIdx += 1;
          return fakeRun("dev prose ignored");
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool({ title: "Add Bar", allowDirty: true, verifyCommand: false }, { repoRoot: root });
      expect(result.approved).toBe(true);
      expect(result.rounds.impl).toBe(2);

      const developerCalls = captured.filter((c) => c.member.role === "developer");
      expect(developerCalls).toHaveLength(2);
      // Developer revise carries the prior diff + findings (developer prompts
      // are unchanged — the user explicitly kept those).
      expect(developerCalls[1].task.task).toContain("// v1");
      expect(developerCalls[1].task.task).toContain("add unit test");

      // Reviewer impl-review prompts are SUMMARY-based — narrative + diff
      // stat referencing feat.ts, NOT the raw diff content. The dev's
      // finalText is "dev prose ignored".
      const reviewerCalls = captured.filter((c) => c.member.role === "reviewer");
      // Plan reviewer (1) + impl reviewer round 1 (2) + impl reviewer round 2 (3)
      expect(reviewerCalls).toHaveLength(3);
      expect(reviewerCalls[1].task.task).toContain("dev prose ignored");
      expect(reviewerCalls[1].task.task).toContain("feat.ts");
      expect(reviewerCalls[1].task.task).not.toContain("// v1");
      expect(reviewerCalls[2].task.task).toContain("dev prose ignored");
      expect(reviewerCalls[2].task.task).not.toContain("// v2 revised");
    } finally {
      dispose();
    }
  });
});

describe("M10 sf_team_task verification gate (S-A06)", () => {
  it("THROWS when verifyCommand exits non-zero — does NOT proceed to review/commit", async () => {
    const { root, dispose } = makeRepo();
    try {
      // Plan reviewer must APPROVE so we reach the dev phase + verification.
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun("plan");
        if (member.role === "developer") return fakeRun("dev");
        return fakeRun(APPROVED_TEXT); // plan reviewer
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      await expect(
        tool(
          { title: "Verify Fail", allowDirty: true, verifyCommand: { cmd: "false", args: [] } },
          { repoRoot: root },
        ),
      ).rejects.toThrow(/verification gate failed/);
    } finally {
      dispose();
    }
  });
});

describe("M10 sf_team_task impl-revise feeds REFRESHED git-diff to reviewer (S-A07)", () => {
  it("after developer revision, the next reviewer call sees the new staged diff (not developer prose)", async () => {
    const { root, dispose } = makeRepo();
    try {
      // Round 1: developer "writes" a file via filesystem (we simulate by
      // writing in spawnAgent mock). Round 2 reviewer should see THAT diff.
      const reviewerOutputs = [APPROVED_TEXT, REVISE_TEXT_IMPL, APPROVED_TEXT];
      let rIdx = 0;
      let devCallIdx = 0;
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun("the plan");
        if (member.role === "developer") {
          // Simulate developer writing files; round 0 = stage v1, round 1 = stage v2
          if (devCallIdx === 0) {
            writeFileSync(path.join(root, "feature.ts"), "// v1\n");
          } else {
            writeFileSync(path.join(root, "feature.ts"), "// v2 — addresses findings\n");
          }
          spawnSync("git", ["add", "feature.ts"], { cwd: root });
          devCallIdx += 1;
          // The developer's prose is intentionally MEANINGLESS to prove the
          // reviewer doesn't see it.
          return fakeRun("blah blah developer prose");
        }
        return fakeRun(reviewerOutputs[Math.min(rIdx++, reviewerOutputs.length - 1)]);
      });
      const captured: { role: string; task: string }[] = [];
      const wrapped = vi.fn(async (member: TeamMember, task: AgentTask) => {
        captured.push({ role: member.role, task: task.task });
        return spawnAgent(member);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: wrapped as never, runReviewLoop });
      const result = await tool(
        { title: "Refresh Diff", allowDirty: true, verifyCommand: false, shouldPush: () => false },
        { repoRoot: root },
      );
      expect(result.approved).toBe(true);
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // The impl-reviewer's prompts are now SUMMARY-based: developer
      // narrative + diff stat (referencing feature.ts), NOT the raw diff
      // content. Round-1 prompt has a "Review the implementation"
      // lead-in; round-2 verify-fixes prompt has an "ORIGINAL
      // IMPLEMENTATION SUMMARY" anchor section. Plan-review prompts
      // start with "Review this single-task plan" so we can filter them
      // out by name.
      const reviewerCalls = captured.filter(
        (c) =>
          c.role === "reviewer" &&
          (c.task.includes("Review the implementation") ||
            c.task.includes("ORIGINAL IMPLEMENTATION SUMMARY")),
      );
      expect(reviewerCalls).toHaveLength(2);
      // Both rounds reference the changed file via the diff stat.
      expect(reviewerCalls[0].task).toContain("feature.ts");
      expect(reviewerCalls[1].task).toContain("feature.ts");
      // Neither round embeds the raw diff content.
      expect(reviewerCalls[0].task).not.toContain("// v1");
      expect(reviewerCalls[1].task).not.toContain("// v2 — addresses findings");
      // The dev's narrative IS in the prompt (the new design uses it as
      // the primary review input).
      expect(reviewerCalls[0].task).toContain("blah blah developer prose");
      expect(reviewerCalls[1].task).toContain("blah blah developer prose");
    } finally {
      dispose();
    }
  });
});

describe("M10 sf_team_task commit + push (S-A08)", () => {
  it("fails loudly when staged changes can't be committed", async () => {
    const { root, dispose } = makeRepo();
    try {
      // Force git commit to fail by misconfiguring user — simplest reliable
      // way is to make a commit-msg hook that exits non-zero.
      const hookDir = path.join(root, ".git", "hooks");
      mkdirSync(hookDir, { recursive: true });
      const hookPath = path.join(hookDir, "commit-msg");
      writeFileSync(hookPath, "#!/usr/bin/env bash\nexit 1\n");
      spawnSync("chmod", ["+x", hookPath]);
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun("plan");
        if (member.role === "developer") {
          writeFileSync(path.join(root, "f.ts"), "x");
          spawnSync("git", ["add", "f.ts"], { cwd: root });
          return fakeRun("dev");
        }
        return fakeRun(APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      await expect(
        tool({ title: "Commit Fail", allowDirty: true, verifyCommand: false }, { repoRoot: root }),
      ).rejects.toThrow(/git commit failed/);
    } finally {
      dispose();
    }
  });

  it("invokes shouldPush callback when commit succeeds; pushes when callback returns true", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun("plan");
        if (member.role === "developer") {
          writeFileSync(path.join(root, "f.ts"), "x");
          spawnSync("git", ["add", "f.ts"], { cwd: root });
          return fakeRun("dev");
        }
        return fakeRun(APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      const shouldPush = vi.fn(() => false);
      const result = await tool(
        { title: "Push Skip", allowDirty: true, verifyCommand: false, shouldPush },
        { repoRoot: root },
      );
      expect(shouldPush).toHaveBeenCalledTimes(1);
      expect(result.pushed).toBe(false);
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      dispose();
    }
  });
});

describe("M10 sf_team_task dirty-worktree guard (S-A04)", () => {
  it("rejects when the worktree is dirty and allowDirty is not set", async () => {
    const { root, dispose } = makeRepo();
    try {
      // Make the tree dirty.
      writeFileSync(path.join(root, "stray.txt"), "x");
      const spawnAgent = vi.fn(async () => fakeRun(""));
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      await expect(tool({ title: "Dirty" }, { repoRoot: root })).rejects.toThrow(/dirty/);
    } finally {
      dispose();
    }
  });

  it("allowDirty=true bypasses the guard", async () => {
    const { root, dispose } = makeRepo();
    try {
      writeFileSync(path.join(root, "stray.txt"), "x");
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        if (member.role === "planner") return fakeRun("plan");
        if (member.role === "developer") {
          writeFileSync(path.join(root, "impl.ts"), "// y\n");
          spawnSync("git", ["add", "impl.ts"], { cwd: root });
          return fakeRun("diff");
        }
        return fakeRun(APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      const result = await tool({ title: "Dirty OK", allowDirty: true, verifyCommand: false }, { repoRoot: root });
      expect(result.approved).toBe(true);
    } finally {
      dispose();
    }
  });
});

describe("M10 sf_team_task refuses success without a commit (P2.2)", () => {
  it("throws when developer produces no staged changes (no silent success)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn(async (member: TeamMember) => {
        // Developer mock NEVER stages anything.
        if (member.role === "planner") return fakeRun("plan");
        if (member.role === "developer") return fakeRun("dev did nothing");
        return fakeRun(APPROVED_TEXT);
      });
      const runReviewLoop = (await import("../src/review/loop")).runReviewLoop;
      const tool = createSfTeamTask({ spawnAgent: spawnAgent as never, runReviewLoop });
      await expect(
        tool({ title: "Empty Dev", allowDirty: true, verifyCommand: false }, { repoRoot: root }),
      ).rejects.toThrow(/no staged changes/);
    } finally {
      dispose();
    }
  });
});
