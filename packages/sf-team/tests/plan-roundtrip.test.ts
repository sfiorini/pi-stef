import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { captureBaseline, loadBaseline } from "../src/plan/baseline";
import { acquireLock, isLockStale, LockHeldError, readLockMetadata, releaseLock } from "../src/plan/lock";
import { EXECUTION_STRATEGY_FILE, FIVE_FILE_NAMES, planFolderPath, PLAN_FOLDER_ROOT } from "../src/plan/paths";
import { readPlanFolder } from "../src/plan/read";
import { detectResumeState } from "../src/plan/resume";
import { slugify } from "../src/plan/slug";
import { parseStoryTracker, parseTrackerText, updateStoryTracker } from "../src/plan/tracker";
import { writePlanFolder } from "../src/plan/write";

function tmp(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-plan-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("M6 slugify", () => {
  it("produces YYYY-MM-DD-<kebab>", () => {
    const slug = slugify("My Cool Plan!", new Date("2026-05-01T12:00:00Z"));
    expect(slug).toBe("2026-05-01-my-cool-plan");
  });

  it("collapses whitespace and strips punctuation", () => {
    expect(slugify("Hello, World!", new Date("2026-05-01"))).toBe("2026-05-01-hello-world");
    expect(slugify("a   b   c", new Date("2026-05-01"))).toBe("2026-05-01-a-b-c");
  });

  it("throws on empty / non-slug input", () => {
    expect(() => slugify("!@#$", new Date("2026-05-01"))).toThrow(/no slug-able/);
    expect(() => slugify("", new Date("2026-05-01"))).toThrow(/no slug-able/);
  });
});

describe("M6 writePlanFolder + readPlanFolder round-trip", () => {
  it("five-file layout: writes all 5 files then reads them back", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = slugify("Round Trip Test", new Date("2026-05-01"));
      const files: Record<(typeof FIVE_FILE_NAMES)[number], string> = {
        "original-plan.md": "# orig",
        "milestone-plan.md": "# mile",
        "story-tracker.md": "# stories",
        "continuation-runbook.md": "# run",
        "final-transcript.md": "# transcript",
      };
      await writePlanFolder(root, { kind: "five-file", slug, files });
      const r = await readPlanFolder(root, slug);
      expect(r.fiveFile).toEqual(files);
      expect(r.executionStrategyJson).toBeUndefined();
      expect(r.folder).toBe(planFolderPath(root, slug));
    } finally {
      dispose();
    }
  });

  it("five-file layout: can carry optional execution-strategy.json without changing the canonical five", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = slugify("Round Trip Strategy", new Date("2026-05-01"));
      const files: Record<(typeof FIVE_FILE_NAMES)[number], string> = {
        "original-plan.md": "# orig",
        "milestone-plan.md": "# mile",
        "story-tracker.md": "# stories",
        "continuation-runbook.md": "# run",
        "final-transcript.md": "# transcript",
      };
      const executionStrategyJson = JSON.stringify({
        version: 1,
        maxParallelMilestones: 1,
        maxParallelStoriesPerMilestone: 1,
        milestoneWaves: [{ id: "W1", milestones: ["M1"] }],
        stories: {},
      }, null, 2);
      await writePlanFolder(root, { kind: "five-file", slug, files, executionStrategyJson });
      const r = await readPlanFolder(root, slug);
      expect(FIVE_FILE_NAMES).toHaveLength(5);
      expect(FIVE_FILE_NAMES).not.toContain(EXECUTION_STRATEGY_FILE as never);
      expect(r.fiveFile).toEqual(files);
      expect(r.executionStrategyJson).toBe(executionStrategyJson);
    } finally {
      dispose();
    }
  });

  it("task layout: writes 1 file", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = slugify("My Task", new Date("2026-05-01"));
      await writePlanFolder(root, { kind: "task", slug, files: { "task-plan.md": "# task body" } });
      const r = await readPlanFolder(root, slug);
      expect(r.taskPlan).toBe("# task body");
      expect(r.fiveFile).toBeUndefined();
    } finally {
      dispose();
    }
  });

  // The "followup overlay" code path was removed: sf_team_followup now
  // writes its own task-plan.md under a brand-new
  // ai_plan/<date>-followup-<slug>/ folder via the shared task workflow,
  // not an overlay file inside the parent's folder. The discriminated
  // union `WritePlanFolderInput["kind"]` is now just "five-file" | "task".
});

describe("M6 parseStoryTracker / updateStoryTracker", () => {
  const SAMPLE_TRACKER = `# Story Tracker

## Milestones

### M0: Vertical spike

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | foo | pending | |
| S-002 | bar | in-dev | wip |
| S-003 | baz | completed | abc1234 |

**Approval Status:** approved

### M1: Scaffolding

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | one | pending | |

**Approval Status:** pending
`;

  it("parses milestones and stories with statuses", () => {
    const t = parseTrackerText(SAMPLE_TRACKER);
    expect(t.milestones).toHaveLength(2);
    expect(t.milestones[0].stories[0]).toMatchObject({ id: "S-001", status: "pending" });
    expect(t.milestones[0].stories[1]).toMatchObject({ id: "S-002", status: "in-dev", notes: "wip" });
    expect(t.milestones[0].stories[2]).toMatchObject({ id: "S-003", status: "completed", notes: "abc1234" });
    expect(t.milestones[0].approvalStatus).toBe("approved");
  });

  it("updates a single row atomically without disturbing others", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = slugify("Tracker Update", new Date("2026-05-01"));
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      writeFileSync(path.join(planFolderPath(root, slug), "story-tracker.md"), SAMPLE_TRACKER);
      await updateStoryTracker(root, { slug, storyId: "S-001", status: "in-dev", notes: "kicking off" });
      const reread = await parseStoryTracker(root, slug);
      const s001 = reread.milestones[0].stories[0];
      expect(s001).toMatchObject({ id: "S-001", status: "in-dev", notes: "kicking off" });
      // Other rows untouched
      expect(reread.milestones[0].stories[1]).toMatchObject({ status: "in-dev", notes: "wip" });
      expect(reread.milestones[0].stories[2]).toMatchObject({ status: "completed", notes: "abc1234" });
    } finally {
      dispose();
    }
  });
});

describe("M6 acquireLock / releaseLock with rich metadata", () => {
  it("acquires + releases lock cleanly on a fresh folder", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-01-fresh";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const meta = await acquireLock(root, slug, "sf_team_plan");
      expect(meta.pid).toBe(process.pid);
      expect(meta.slug).toBe(slug);
      const re = await readLockMetadata(root, slug);
      expect(re).toMatchObject({ pid: process.pid, slug, command: "sf_team_plan" });
      await releaseLock(root, slug);
      expect(await readLockMetadata(root, slug)).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("LockHeldError when lock is alive (current pid + matching hostname)", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-01-contended";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      await acquireLock(root, slug, "sf_team_plan");
      await expect(acquireLock(root, slug, "sf_team_implement")).rejects.toBeInstanceOf(LockHeldError);
    } finally {
      dispose();
    }
  });

  it("takes over a stale lock (dead pid)", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-01-stale";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      // Build a stale lockdir manually: directory + metadata.json with a pid
      // that's almost certainly dead.
      const lockDir = path.join(planFolderPath(root, slug), ".sf-team.lock");
      mkdirSync(lockDir);
      writeFileSync(
        path.join(lockDir, "metadata.json"),
        JSON.stringify({
          pid: 999_999,
          startedAt: "2020-01-01T00:00:00.000Z",
          processStartedAt: "",
          hostname: require("node:os").hostname(),
          command: "old",
          slug,
        }),
      );
      const meta = await acquireLock(root, slug, "sf_team_plan");
      expect(meta.pid).toBe(process.pid);
    } finally {
      dispose();
    }
  });

  it("treats different-host locks as stale (cross-host plan-folder use is undefined)", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-01-otherhost";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const lockDir = path.join(planFolderPath(root, slug), ".sf-team.lock");
      mkdirSync(lockDir);
      writeFileSync(
        path.join(lockDir, "metadata.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2020-01-01T00:00:00.000Z",
          processStartedAt: "",
          hostname: "some-other-host",
          command: "old",
          slug,
        }),
      );
      const meta = await acquireLock(root, slug, "sf_team_plan", { hostnameOverride: "current-host" });
      expect(meta.pid).toBe(process.pid);
    } finally {
      dispose();
    }
  });

  it("isLockStale: alive on same host with current pid (empty processStartedAt -> degrade to alive)", async () => {
    const meta = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      processStartedAt: "",
      hostname: require("node:os").hostname(),
      command: "x",
      slug: "y",
    };
    expect(await isLockStale(meta)).toBe(false);
  });

  it("PID-reuse: lock's processStartedAt disagrees with current OS lstart -> stale", async () => {
    // Defends against the false-positive where a PID was reused: the
    // processStartedAt field captured at lock acquisition won't match the OS
    // lstart of the (different) current process.
    const meta = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      processStartedAt: "Mon Jan  1 00:00:00 1970",
      hostname: require("node:os").hostname(),
      command: "x",
      slug: "y",
    };
    // Skip if the host can't query ps lstart (sandbox). In that case isLockStale
    // intentionally degrades to "alive" — there's no portable fallback.
    const r = require("node:child_process").spawnSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout || r.stdout.trim().length === 0) {
      // No lstart support — degrade test to assert the safe-default behavior.
      expect(await isLockStale(meta)).toBe(false);
      return;
    }
    expect(await isLockStale(meta)).toBe(true);
  });

  it("acquireLock is atomic under racing concurrent callers", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-01-race";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const promises = Array.from({ length: 10 }, () =>
        acquireLock(root, slug, "sf_team_plan").then(
          (v) => ({ ok: true as const, v }),
          (err) => ({ ok: false as const, err }),
        ),
      );
      const results = await Promise.all(promises);
      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(9);
      for (const l of losses) {
        expect((l as { err: unknown }).err).toBeInstanceOf(LockHeldError);
      }
    } finally {
      dispose();
    }
  });

  it("recovers from crash residue: empty lockdir (no metadata.json) is reclaimed after backoff", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-01-crash-residue";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      // Simulate a process that died between mkdir and writeFile of metadata.
      mkdirSync(path.join(planFolderPath(root, slug), ".sf-team.lock"));
      // Acquire should reclaim the empty lockdir without blocking forever.
      const meta = await acquireLock(root, slug, "sf_team_plan");
      expect(meta.pid).toBe(process.pid);
    } finally {
      dispose();
    }
  });

  it("stale-takeover race: 10 concurrent acquires against an existing STALE lock — exactly 1 wins", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-01-stale-race";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      // Plant a stale lockdir (pid=999_999, no processStartedAt) so all
      // contenders agree it is stale.
      const lockDir = path.join(planFolderPath(root, slug), ".sf-team.lock");
      mkdirSync(lockDir);
      writeFileSync(
        path.join(lockDir, "metadata.json"),
        JSON.stringify({
          pid: 999_999,
          startedAt: "2020-01-01T00:00:00.000Z",
          processStartedAt: "",
          hostname: require("node:os").hostname(),
          command: "old",
          slug,
        }),
      );
      const promises = Array.from({ length: 10 }, () =>
        acquireLock(root, slug, "sf_team_plan").then(
          (v) => ({ ok: true as const, v }),
          (err) => ({ ok: false as const, err }),
        ),
      );
      const results = await Promise.all(promises);
      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(9);
      for (const l of losses) {
        expect((l as { err: unknown }).err).toBeInstanceOf(LockHeldError);
      }
    } finally {
      dispose();
    }
  });
});

describe("M6 captureBaseline (pure I/O primitive)", () => {
  it("writes baseline.json into the plan folder; loadBaseline reads it back", async () => {
    const { root, dispose } = tmp();
    try {
      // Initialize a tiny git repo so HEAD exists.
      mkdirSync(path.join(root, "repo"), { recursive: true });
      const repo = path.join(root, "repo");
      run("git", ["init", "-q"], repo);
      run("git", ["config", "user.email", "a@b"], repo);
      run("git", ["config", "user.name", "tester"], repo);
      writeFileSync(path.join(repo, "f.txt"), "hi");
      run("git", ["add", "."], repo);
      run("git", ["commit", "-q", "-m", "init"], repo);

      const slug = "2026-05-01-baseline";
      const planRoot = path.join(repo, PLAN_FOLDER_ROOT);
      mkdirSync(planFolderPath(repo, slug), { recursive: true });
      const baseline = await captureBaseline(planRoot, slug);
      expect(baseline?.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(baseline?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const reloaded = await loadBaseline(planRoot, slug);
      expect(reloaded).toEqual(baseline);
    } finally {
      dispose();
    }
  });

  it("returns empty headSha when not in a git repo (graceful, no throw)", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-01-no-git";
      const planRoot = path.join(root, PLAN_FOLDER_ROOT);
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      const b = await captureBaseline(planRoot, slug);
      expect(b?.headSha).toBe("");
    } finally {
      dispose();
    }
  });
});

describe("M6 detectResumeState", () => {
  it("exists=false when plan folder is missing", async () => {
    const { root, dispose } = tmp();
    try {
      const r = await detectResumeState(root, "2026-05-01-missing");
      expect(r.exists).toBe(false);
    } finally {
      dispose();
    }
  });

  it("collects in-dev stories and identifies first pending milestone", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-01-resume";
      const tracker = `# Story Tracker

## Milestones

### M0: First

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-001 | x | completed | hash |

**Approval Status:** approved

### M1: Second

| Story | Description | Status | Notes |
|-------|-------------|--------|-------|
| S-101 | y | in-dev | wip |
| S-102 | z | pending | |

**Approval Status:** pending
`;
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      writeFileSync(path.join(planFolderPath(root, slug), "task-plan.md"), "# task");
      writeFileSync(path.join(planFolderPath(root, slug), "story-tracker.md"), tracker);
      const r = await detectResumeState(root, slug);
      expect(r.exists).toBe(true);
      expect(r.inDev).toHaveLength(1);
      expect(r.inDev[0].id).toBe("S-101");
      expect(r.firstPendingMilestone?.id).toBe("M1");
    } finally {
      dispose();
    }
  });
});

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
}
