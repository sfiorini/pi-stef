import { describe, expect, it } from "vitest";
import { requireGitOrSkip } from "../src/worktree/validate";
import { GitRepoMissingError } from "../src/worktree/validate";

type MinCtx = { repoRoot: string; gitMode: "on" | "off"; __testGitProbe?: (cwd: string) => boolean };

describe("requireGitOrSkip", () => {
  it("gitMode='on' + git repo present → no throw", () => {
    const ctx: MinCtx = { repoRoot: "/repo", gitMode: "on", __testGitProbe: () => true };
    expect(() => requireGitOrSkip(ctx, "sf_team_task")).not.toThrow();
  });

  it("gitMode='on' + not a git repo → throws GitRepoMissingError", () => {
    const ctx: MinCtx = { repoRoot: "/not-a-repo", gitMode: "on", __testGitProbe: () => false };
    expect(() => requireGitOrSkip(ctx, "sf_team_task")).toThrow(GitRepoMissingError);
  });

  it("gitMode='off' + git repo present → no throw (skipped)", () => {
    const ctx: MinCtx = { repoRoot: "/repo", gitMode: "off", __testGitProbe: () => true };
    expect(() => requireGitOrSkip(ctx, "sf_team_task")).not.toThrow();
  });

  it("gitMode='off' + not a git repo → no throw (skipped)", () => {
    const ctx: MinCtx = { repoRoot: "/not-a-repo", gitMode: "off", __testGitProbe: () => false };
    expect(() => requireGitOrSkip(ctx, "sf_team_task")).not.toThrow();
  });
});
