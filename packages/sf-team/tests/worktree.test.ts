import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const installSpy = vi.hoisted(() =>
  vi.fn((_worktreePath: string) => ({
    kind: "skipped" as const,
    reason: "no_package_json" as const,
  })),
);

vi.mock("../src/worktree/install-deps", () => ({
  installDependenciesIfMissing: installSpy,
}));

import { acquireLock } from "../src/plan/lock";
import { planFolderPath } from "../src/plan/paths";
import { cleanupWorktreeAndLock, removeRolledUpWorktree, removeWorktreeIfEmpty } from "../src/worktree/cleanup";
import { createWorktree, WorktreeCreationError } from "../src/worktree/create";
import { findExistingWorktree } from "../src/worktree/find";
import { pickWorktreeDir } from "../src/worktree/pick-dir";
import { assertIsGitRepo, GitRepoMissingError, validateRepoState } from "../src/worktree/validate";

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-wt-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  run("git", ["init", "-q", "-b", "main"], repo);
  run("git", ["config", "user.email", "a@b"], repo);
  run("git", ["config", "user.name", "tester"], repo);
  writeFileSync(path.join(repo, "README.md"), "hi");
  run("git", ["add", "."], repo);
  run("git", ["commit", "-q", "-m", "init"], repo);
  return { root: repo, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
}

function gitOut(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function commitFile(cwd: string, file: string, body: string, message: string): string {
  writeFileSync(path.join(cwd, file), body);
  run("git", ["add", file], cwd);
  run("git", ["commit", "-q", "-m", message], cwd);
  return gitOut(["rev-parse", "HEAD"], cwd);
}

describe("M7 validateRepoState", () => {
  it("passes on a clean repo", () => {
    const { root, dispose } = makeRepo();
    try {
      expect(() => validateRepoState(root)).not.toThrow();
    } finally {
      dispose();
    }
  });

  it("throws RepoStateError(kind=dirty-tree) when the worktree has untracked files", () => {
    const { root, dispose } = makeRepo();
    try {
      writeFileSync(path.join(root, "untracked.txt"), "hi");
      let caught: Error | undefined;
      try {
        validateRepoState(root);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect((caught as { kind?: string }).kind).toBe("dirty-tree");
    } finally {
      dispose();
    }
  });

  it("allowDirty=true skips the dirty-tree check", () => {
    const { root, dispose } = makeRepo();
    try {
      writeFileSync(path.join(root, "untracked.txt"), "hi");
      expect(() => validateRepoState(root, { allowDirty: true })).not.toThrow();
    } finally {
      dispose();
    }
  });

  it("throws kind=not-a-git-repo when called outside a repo", () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "ct-nogit-"));
    try {
      let caught: Error | undefined;
      try {
        validateRepoState(tmpRoot);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect((caught as { kind?: string }).kind).toBe("not-a-git-repo");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("assertIsGitRepo (workflow-entry preflight)", () => {
  // The lightweight preflight used at the entry of every git-touching
  // sf-team workflow (implement, auto, task, followup). It only checks
  // for the presence of a git repo — dirty state is handled later by
  // validateRepoState at worktree-creation time. The friendly error
  // message must mention the tool name AND the cwd AND a `git init`
  // suggestion so the user can self-recover.

  it("passes silently when cwd is inside a git repo", () => {
    const { root, dispose } = makeRepo();
    try {
      expect(() => assertIsGitRepo("sf_team_implement", root)).not.toThrow();
    } finally {
      dispose();
    }
  });

  it("passes even when the repo has uncommitted changes (dirty state is NOT this preflight's job)", () => {
    const { root, dispose } = makeRepo();
    try {
      writeFileSync(path.join(root, "untracked.txt"), "hi");
      expect(() => assertIsGitRepo("sf_team_implement", root)).not.toThrow();
    } finally {
      dispose();
    }
  });

  it("throws GitRepoMissingError when called outside any git repo (and the message is friendly)", () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "preflight-nogit-"));
    try {
      let caught: Error | undefined;
      try {
        assertIsGitRepo("sf_team_implement", tmpRoot);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeInstanceOf(GitRepoMissingError);
      const err = caught as GitRepoMissingError;
      expect(err.tool).toBe("sf_team_implement");
      expect(err.cwd).toBe(tmpRoot);
      expect(err.message).toContain("sf_team_implement");
      expect(err.message).toContain(tmpRoot);
      expect(err.message).toContain("git init");
      expect(err.message).toContain("not a git repository");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("the error name is GitRepoMissingError so callers can switch on it without a string-match", () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "preflight-nogit-name-"));
    try {
      let caught: Error | undefined;
      try {
        assertIsGitRepo("sf_team_auto", tmpRoot);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught?.name).toBe("GitRepoMissingError");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("each tool name flows into the error so the user knows which workflow tripped", () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "preflight-nogit-tools-"));
    try {
      for (const tool of ["sf_team_implement", "sf_team_auto", "sf_team_task", "sf_team_followup"]) {
        let caught: Error | undefined;
        try {
          assertIsGitRepo(tool, tmpRoot);
        } catch (err) {
          caught = err as Error;
        }
        expect(caught).toBeDefined();
        expect((caught as GitRepoMissingError).tool).toBe(tool);
        expect(caught!.message).toContain(tool);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("non-repo cwd throws with cause='not-a-repo' (default) and the message suggests `git init`", () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "preflight-cause-notrepo-"));
    try {
      let caught: GitRepoMissingError | undefined;
      try {
        assertIsGitRepo("sf_team_implement", tmpRoot);
      } catch (err) {
        caught = err as GitRepoMissingError;
      }
      expect(caught).toBeDefined();
      expect(caught!.cause).toBe("not-a-repo");
      expect(caught!.message).toContain("git init");
      expect(caught!.message).not.toContain("brew install");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("ENOENT (git CLI missing) throws with cause='git-missing' and a different friendly message", () => {
    // We can't actually unlink git on the test host. Instead, simulate the
    // ENOENT path by pointing PATH at an empty directory so child_process
    // can't resolve `git`. spawnSync then fails with ENOENT.
    const emptyDir = mkdtempSync(path.join(tmpdir(), "preflight-empty-path-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "preflight-empty-cwd-"));
    const prevPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      let caught: GitRepoMissingError | undefined;
      try {
        assertIsGitRepo("sf_team_implement", cwd);
      } catch (err) {
        caught = err as GitRepoMissingError;
      }
      expect(caught).toBeDefined();
      expect(caught!.cause).toBe("git-missing");
      expect(caught!.message).toContain("`git` CLI not found");
      expect(caught!.message).not.toContain("git init");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      rmSync(emptyDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("strips GIT_DIR from the child env so a stale shell export can't fool the preflight", () => {
    // Set GIT_DIR to a real .git directory while running the preflight from
    // an unrelated empty cwd. Without the env strip, git rev-parse would
    // honor GIT_DIR and report `true`. With the strip, it correctly reports
    // the cwd as non-repo.
    const { root, dispose } = makeRepo();
    const otherCwd = mkdtempSync(path.join(tmpdir(), "preflight-gitdir-leak-"));
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(root, ".git");
    try {
      let caught: GitRepoMissingError | undefined;
      try {
        assertIsGitRepo("sf_team_implement", otherCwd);
      } catch (err) {
        caught = err as GitRepoMissingError;
      }
      expect(caught).toBeDefined();
      expect(caught!.cause).toBe("not-a-repo");
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
      rmSync(otherCwd, { recursive: true, force: true });
      dispose();
    }
  });
});

describe("M7 pickWorktreeDir", () => {
  it("defaults to sibling <repoRoot>/../<repoBase>-worktrees/<slug> (outside the repo)", () => {
    const { root, dispose } = makeRepo();
    try {
      const repoBase = path.basename(root);
      const p = pickWorktreeDir(root, "2026-05-01-foo");
      expect(p).toBe(path.join(path.dirname(root), `${repoBase}-worktrees`, "2026-05-01-foo"));
    } finally {
      dispose();
    }
  });

  it("honors a pre-existing inside-repo .worktrees/ (opt-in by user creating the dir)", () => {
    const { root, dispose } = makeRepo();
    try {
      mkdirSync(path.join(root, ".worktrees"));
      const p = pickWorktreeDir(root, "2026-05-01-foo");
      expect(p).toBe(path.join(root, ".worktrees", "2026-05-01-foo"));
    } finally {
      dispose();
    }
  });

  it("appends -2 / -3 on collision", () => {
    const { root, dispose } = makeRepo();
    try {
      const repoBase = path.basename(root);
      const baseDir = path.join(path.dirname(root), `${repoBase}-worktrees`);
      mkdirSync(path.join(baseDir, "2026-05-01-foo"), { recursive: true });
      const p1 = pickWorktreeDir(root, "2026-05-01-foo");
      expect(p1).toBe(path.join(baseDir, "2026-05-01-foo-2"));
      mkdirSync(p1, { recursive: true });
      const p2 = pickWorktreeDir(root, "2026-05-01-foo");
      expect(p2).toBe(path.join(baseDir, "2026-05-01-foo-3"));
    } finally {
      dispose();
    }
  });
});

describe("M7 createWorktree", () => {
  it("creates a new worktree on a fresh branch off HEAD (sibling-by-default)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const repoBase = path.basename(root);
      const result = await createWorktree({
        repoRoot: root,
        slug: "2026-05-01-feat",
        branchPrefix: "implement/",
      });
      expect(result.branch).toBe("implement/2026-05-01-feat");
      expect(result.worktreePath).toBe(
        path.join(path.dirname(root), `${repoBase}-worktrees`, "2026-05-01-feat"),
      );
      const list = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
      expect(list.stdout).toContain(result.worktreePath);
    } finally {
      dispose();
    }
  });

  it("calls installDependenciesIfMissing(worktreePath) after `git worktree add` succeeds", async () => {
    const { root, dispose } = makeRepo();
    installSpy.mockClear();
    try {
      const result = await createWorktree({
        repoRoot: root,
        slug: "2026-05-01-install-wiring",
        branchPrefix: "implement/",
      });
      expect(installSpy).toHaveBeenCalledTimes(1);
      expect(installSpy).toHaveBeenCalledWith(result.worktreePath);
    } finally {
      dispose();
    }
  });

  it("rejects branch collision with WorktreeCreationError(stage='branch-collision')", async () => {
    const { root, dispose } = makeRepo();
    try {
      run("git", ["branch", "implement/2026-05-01-feat"], root);
      let caught: WorktreeCreationError | undefined;
      try {
        await createWorktree({ repoRoot: root, slug: "2026-05-01-feat", branchPrefix: "implement/" });
      } catch (err) {
        caught = err as WorktreeCreationError;
      }
      expect(caught).toBeInstanceOf(WorktreeCreationError);
      expect(caught?.stage).toBe("branch-collision");
    } finally {
      dispose();
    }
  });

  it("rejects dirty repo unless allowDirty=true", async () => {
    const { root, dispose } = makeRepo();
    try {
      writeFileSync(path.join(root, "untracked.txt"), "x");
      let caught: WorktreeCreationError | undefined;
      try {
        await createWorktree({ repoRoot: root, slug: "2026-05-01-dirty", branchPrefix: "implement/" });
      } catch (err) {
        caught = err as WorktreeCreationError;
      }
      expect(caught).toBeInstanceOf(WorktreeCreationError);
      expect(caught?.stage).toBe("validate");

      // With allowDirty=true, succeeds.
      const ok = await createWorktree({
        repoRoot: root,
        slug: "2026-05-01-dirty",
        branchPrefix: "implement/",
        allowDirty: true,
      });
      expect(ok.branch).toBe("implement/2026-05-01-dirty");
    } finally {
      dispose();
    }
  });
});

describe("M7 findExistingWorktree", () => {
  it("returns metadata for a registered worktree by branch name", async () => {
    const { root, dispose } = makeRepo();
    try {
      const created = await createWorktree({ repoRoot: root, slug: "2026-05-01-find", branchPrefix: "implement/" });
      const found = findExistingWorktree(root, created.branch);
      // git worktree list returns the realpath; on macOS /tmp -> /private/tmp.
      const { realpathSync } = require("node:fs");
      expect(found?.path).toBe(realpathSync(created.worktreePath));
      expect(found?.branch).toBe(created.branch);
    } finally {
      dispose();
    }
  });

  it("returns undefined when no worktree matches", () => {
    const { root, dispose } = makeRepo();
    try {
      expect(findExistingWorktree(root, "nope/none")).toBeUndefined();
    } finally {
      dispose();
    }
  });
});

describe("M7 removeWorktreeIfEmpty + cleanupWorktreeAndLock", () => {
  it("removes a freshly-created (empty) worktree", async () => {
    const { root, dispose } = makeRepo();
    try {
      const created = await createWorktree({ repoRoot: root, slug: "2026-05-01-rm", branchPrefix: "implement/" });
      const removed = await removeWorktreeIfEmpty(root, created.worktreePath);
      expect(removed).toBe(true);
      expect(findExistingWorktree(root, created.branch)).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("refuses to remove a non-empty worktree (porcelain status non-empty)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const created = await createWorktree({ repoRoot: root, slug: "2026-05-01-busy", branchPrefix: "implement/" });
      writeFileSync(path.join(created.worktreePath, "new.txt"), "modified");
      const removed = await removeWorktreeIfEmpty(root, created.worktreePath);
      expect(removed).toBe(false);
      expect(findExistingWorktree(root, created.branch)).toBeDefined();
    } finally {
      dispose();
    }
  });

  it("refuses to remove a worktree that has commits ahead of main/master", async () => {
    const { root, dispose } = makeRepo();
    try {
      const created = await createWorktree({ repoRoot: root, slug: "2026-05-01-ahead", branchPrefix: "implement/" });
      writeFileSync(path.join(created.worktreePath, "ahead.txt"), "ahead");
      run("git", ["add", "."], created.worktreePath);
      run("git", ["commit", "-q", "-m", "ahead-of-main"], created.worktreePath);
      const removed = await removeWorktreeIfEmpty(root, created.worktreePath);
      expect(removed).toBe(false);
      expect(findExistingWorktree(root, created.branch)).toBeDefined();
    } finally {
      dispose();
    }
  });

  it("createWorktree returns a resolved SHA in baseRef so cleanup's ahead check is meaningful inside the child", async () => {
    const { root, dispose } = makeRepo();
    try {
      const created = await createWorktree({ repoRoot: root, slug: "2026-05-01-sha", branchPrefix: "implement/" });
      // baseRef is a 40-char hex SHA, NOT the literal string "HEAD".
      expect(created.baseRef).toMatch(/^[0-9a-f]{40}$/);
      // Make a commit inside the child; explicit-baseRef cleanup must refuse.
      writeFileSync(path.join(created.worktreePath, "x.txt"), "x");
      run("git", ["add", "."], created.worktreePath);
      run("git", ["commit", "-q", "-m", "child-only commit"], created.worktreePath);
      const removed = await removeWorktreeIfEmpty(root, created.worktreePath, { baseRef: created.baseRef });
      expect(removed).toBe(false);
      expect(findExistingWorktree(root, created.branch)).toBeDefined();
    } finally {
      dispose();
    }
  });

  it("two consecutive createWorktree calls succeed in any repo (no in-repo .gitignore entry needed)", async () => {
    const { root, dispose } = makeRepo();
    try {
      // No .gitignore tweak. The default sibling location keeps the parent
      // working tree clean across multiple worktree creations.
      await createWorktree({ repoRoot: root, slug: "2026-05-01-one", branchPrefix: "implement/" });
      await expect(
        createWorktree({ repoRoot: root, slug: "2026-05-01-two", branchPrefix: "implement/" }),
      ).resolves.toBeDefined();
    } finally {
      dispose();
    }
  });

  it("cleanupWorktreeAndLock: best-effort, releases both even on missing inputs", async () => {
    const { root, dispose } = makeRepo();
    try {
      // Acquire a lock; worktree absent.
      const slug = "2026-05-01-lockonly";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      await acquireLock(root, slug, "sf_team_test");
      await expect(cleanupWorktreeAndLock({ repoRoot: root, slug })).resolves.toBeUndefined();
    } finally {
      dispose();
    }
  });
});

describe("parallel lane removeRolledUpWorktree", () => {
  async function makeRolledUpLane() {
    const { root, dispose } = makeRepo();
    const target = await createWorktree({
      repoRoot: root,
      slug: "target",
      branchPrefix: "impl/",
      branchName: "impl-target",
    });
    const lane = await createWorktree({
      repoRoot: root,
      slug: "lane",
      branchPrefix: "impl/",
      branchName: "impl-target-lanes/S-101",
      baseRef: target.baseRef,
    });
    const laneHead = commitFile(lane.worktreePath, "lane.txt", "lane\n", "lane commit");
    run("git", ["merge", "--no-ff", lane.branch, "-m", "merge lane"], target.worktreePath);
    return { root, dispose, target, lane, laneHead };
  }

  it("removes a clean lane worktree whose HEAD has rolled up to the parent", async () => {
    const { root, dispose, target, lane, laneHead } = await makeRolledUpLane();
    try {
      const removed = await removeRolledUpWorktree({
        repoRoot: root,
        worktreePath: lane.worktreePath,
        targetCwd: target.worktreePath,
        expectedHead: laneHead,
      });
      expect(removed).toBe(true);
      expect(findExistingWorktree(root, lane.branch)).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("refuses to remove a rolled-up lane with uncommitted changes", async () => {
    const { root, dispose, target, lane, laneHead } = await makeRolledUpLane();
    try {
      writeFileSync(path.join(lane.worktreePath, "dirty.txt"), "dirty\n");
      const removed = await removeRolledUpWorktree({
        repoRoot: root,
        worktreePath: lane.worktreePath,
        targetCwd: target.worktreePath,
        expectedHead: laneHead,
      });
      expect(removed).toBe(false);
      expect(findExistingWorktree(root, lane.branch)).toBeDefined();
    } finally {
      dispose();
    }
  });

  it("refuses to remove a lane when the expected HEAD does not match", async () => {
    const { root, dispose, target, lane } = await makeRolledUpLane();
    try {
      const removed = await removeRolledUpWorktree({
        repoRoot: root,
        worktreePath: lane.worktreePath,
        targetCwd: target.worktreePath,
        expectedHead: target.baseRef,
      });
      expect(removed).toBe(false);
      expect(findExistingWorktree(root, lane.branch)).toBeDefined();
    } finally {
      dispose();
    }
  });

  it("refuses to remove a clean lane whose HEAD is not in the parent history", async () => {
    const { root, dispose } = makeRepo();
    try {
      const target = await createWorktree({
        repoRoot: root,
        slug: "target",
        branchPrefix: "impl/",
        branchName: "impl-target",
      });
      const lane = await createWorktree({
        repoRoot: root,
        slug: "unmerged-lane",
        branchPrefix: "impl/",
        branchName: "impl-target-lanes/S-102",
        baseRef: target.baseRef,
      });
      const laneHead = commitFile(lane.worktreePath, "lane.txt", "lane\n", "lane commit");
      const removed = await removeRolledUpWorktree({
        repoRoot: root,
        worktreePath: lane.worktreePath,
        targetCwd: target.worktreePath,
        expectedHead: laneHead,
      });
      expect(removed).toBe(false);
      expect(findExistingWorktree(root, lane.branch)).toBeDefined();
    } finally {
      dispose();
    }
  });
});
