import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { finalizeWorktree } from "../../src/worktree/finalize.js";

// Helper to create a throwaway git repo with a worktree on branch flow/test.
function makeRepo(): { repo: string; wtPath: string } {
  const repo = mkdtempSync(join(tmpdir(), "flow-fin-"));
  execSync("git init -b main", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  execSync("git commit --allow-empty -m init", { cwd: repo });
  const wtParent = mkdtempSync(join(tmpdir(), "flow-fin-wt-"));
  rmSync(wtParent, { recursive: true });
  const wtPath = join(wtParent, "wt-test");
  execSync(`git worktree add -b flow/test ${wtPath} HEAD`, { cwd: repo });
  return { repo, wtPath };
}

describe("finalizeWorktree (flow)", () => {
  let repo: string;
  let wtPath: string;

  beforeAll(() => {
    const r = makeRepo();
    repo = r.repo;
    wtPath = r.wtPath;
  });

  afterAll(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(wtPath, { recursive: true, force: true });
    } catch {}
  });

  it("removes the worktree directory but preserves the flow/<slug> branch", async () => {
    expect(existsSync(wtPath)).toBe(true);
    await finalizeWorktree(wtPath, repo);
    expect(existsSync(wtPath)).toBe(false);
    // Branch still exists
    execSync("git rev-parse --verify flow/test", { cwd: repo, stdio: "pipe" });
  });
});
