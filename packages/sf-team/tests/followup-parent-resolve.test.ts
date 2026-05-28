/**
 * Live failure 2026-05-08:
 *
 * 1. The user passed an absolute path to `sf_team_followup`'s
 *    `parentPlan`. `resolveParentPlan` did `path.join(repoRoot,
 *    PLAN_FOLDER_ROOT, opts.plan)` which silently concatenated the
 *    absolute path INSIDE `<repoRoot>/ai_plan/`, producing a broken
 *    path like `<repoRoot>/ai_plan/Users/.../2026-05-08-...`.
 *
 * 2. After the agent retried with a bare slug, the followup tool
 *    rejected with `workflow metadata for <slug> is owned by
 *    sf_team_auto; sf_team_followup cannot run it`. Followup is
 *    by-design ADDITIVE on top of an existing plan folder, so it
 *    should be allowed to take over from any of the other workflow
 *    tools.
 *
 * Tests:
 *   A) resolveParentPlan accepts a bare slug (existing behavior pin).
 *   B) resolveParentPlan accepts an absolute path.
 *   C) resolveParentPlan accepts a relative path.
 *   D) Followup can claim ownership of a plan folder that was
 *      previously owned by sf_team_auto / sf_team_plan /
 *      sf_team_implement / sf_team_task.
 *   E) Followup_resume still enforces ownership (no accidental
 *      cross-tool resume).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkflowMetadata,
  writeWorkflowMetadata,
  type WorkflowToolName,
} from "@pi-stef/agent-workflows";

import { resolveParentPlan } from "../src/tools/followup-resolve";
import { createSfTeamFollowup } from "../src/tools/followup";

// --- A/B/C: resolveParentPlan path handling --------------------------------

function makeRepoWithPlan(slug: string): { root: string; folder: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-followup-resolve-"));
  const folder = path.join(root, "ai_plan", slug);
  mkdirSync(folder, { recursive: true });
  return { root, folder, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("resolveParentPlan: parentPlan input accepts slug | absolute path | relative path", () => {
  it("A) bare slug → resolves to <repoRoot>/ai_plan/<slug>", async () => {
    const slug = "2026-05-08-bare-slug";
    const { root, folder, dispose } = makeRepoWithPlan(slug);
    try {
      const resolved = await resolveParentPlan(root, { plan: slug });
      expect(resolved.slug).toBe(slug);
      expect(resolved.folder).toBe(folder);
    } finally {
      dispose();
    }
  });

  it("B) absolute path → preserved as-is, slug derived from basename", async () => {
    const slug = "2026-05-08-abs-path";
    const { root, folder, dispose } = makeRepoWithPlan(slug);
    try {
      // Absolute path — what the user typed in the failing run.
      const resolved = await resolveParentPlan(root, { plan: folder });
      expect(resolved.slug).toBe(slug);
      expect(resolved.folder).toBe(folder);
    } finally {
      dispose();
    }
  });

  it("C) relative path with leading ./ → resolved against repoRoot", async () => {
    const slug = "2026-05-08-rel-path";
    const { root, folder, dispose } = makeRepoWithPlan(slug);
    try {
      const resolved = await resolveParentPlan(root, { plan: `./ai_plan/${slug}` });
      expect(resolved.slug).toBe(slug);
      expect(resolved.folder).toBe(folder);
    } finally {
      dispose();
    }
  });

  it("regression pin: missing folder still throws with a useful message including the resolved path", async () => {
    const { root, dispose } = makeRepoWithPlan("placeholder");
    try {
      await expect(resolveParentPlan(root, { plan: "does-not-exist" })).rejects.toThrow(
        /not found at .*ai_plan\/does-not-exist/,
      );
    } finally {
      dispose();
    }
  });
});

// --- D/E: ownership boundary -----------------------------------------------

function makeGitRepoWithPlan(slug: string, ownerTool: WorkflowToolName): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "ct-followup-owner-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  // Need at least one commit so worktree creation has a base ref.
  const readme = path.join(root, "README.md");
  spawnSync("touch", [readme]);
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  const folder = path.join(root, "ai_plan", slug);
  mkdirSync(folder, { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

async function seedOwnerMetadata(root: string, slug: string, ownerTool: WorkflowToolName): Promise<void> {
  const folder = path.join(root, "ai_plan", slug);
  await writeWorkflowMetadata(
    root,
    createWorkflowMetadata({
      slug,
      folderPath: folder,
      ownerTool,
      currentTool: ownerTool,
      phase: "test",
    }),
  );
}

describe("sf_team_followup ownership: takeover allowed from prior workflow tools (D); resume still strict (E)", () => {
  /**
   * D) Cross-product: an existing plan folder owned by any of the
   * four other workflow tools must be a valid TARGET for a fresh
   * sf_team_followup. The tool reaches the parent-plan resolution
   * and orchestrator startup without throwing the
   * "owned by X, sf_team_followup cannot run it" error.
   *
   * We don't drive the full orchestrator (it would spawn agents and
   * create real worktrees). Instead we observe that the metadata
   * takeover rule passes by stubbing spawnAgent. If the takeover
   * still rejected, the call would throw before any spawn happens.
   */
  for (const owner of ["sf_team_plan", "sf_team_implement", "sf_team_task", "sf_team_auto"] as const) {
    it(`D) followup can claim a plan folder previously owned by ${owner} (no ownership rejection on start)`, async () => {
      const slug = `2026-05-08-owned-by-${owner.replace(/^sf_team_/, "")}`;
      const { root, dispose } = makeGitRepoWithPlan(slug, owner);
      try {
        await seedOwnerMetadata(root, slug, owner);

        // Stub spawnAgent: if the test reaches it, the takeover
        // succeeded. We make spawnAgent throw a sentinel so the test
        // detects "we got past the ownership guard" without running
        // the whole orchestrator end-to-end.
        const spawnAgent = vi.fn(async () => {
          throw new Error("__sentinel-past-ownership-guard__");
        });
        const tool = createSfTeamFollowup({ spawnAgent: spawnAgent as never });

        let caught: unknown;
        try {
          await tool(
            {
              title: "Add nicer animations",
              parentPlan: slug,
              verifyCommand: false,
            } as never,
            { repoRoot: root },
          );
        } catch (err) {
          caught = err;
        }
        // Expectation: the run threw the sentinel (or some downstream
        // orchestration error), NOT the ownership-mismatch line.
        const message = caught instanceof Error ? caught.message : String(caught);
        expect(message, `start against ${owner}-owned plan must NOT trip the ownership rejection`).not.toMatch(
          /owned by .*; sf_team_followup cannot run it/,
        );
      } finally {
        dispose();
      }
    });
  }

  it("E) followup_resume against an auto-owned plan still rejects (resume is strict)", async () => {
    const slug = "2026-05-08-auto-owned-no-followup-yet";
    const { root, dispose } = makeGitRepoWithPlan(slug, "sf_team_auto");
    try {
      await seedOwnerMetadata(root, slug, "sf_team_auto");
      const spawnAgent = vi.fn();
      const tool = createSfTeamFollowup({ spawnAgent: spawnAgent as never });
      // resume input → resume policy enforces ownerTool === "sf_team_followup"
      // and rejects because there's no prior followup_start to resume.
      await expect(tool({ resume: slug } as never, { repoRoot: root })).rejects.toThrow(
        /owned by sf_team_auto.*sf_team_followup cannot resume it/,
      );
      expect(spawnAgent).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
