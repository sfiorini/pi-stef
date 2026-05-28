import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  createWorkflowMetadata,
  planFolderPath as workflowPlanFolderPath,
  writeWorkflowMetadata,
} from "@pi-stef/agent-workflows";

import { createSfTeamFollowup } from "../src/tools/followup";
import { planFolderPath } from "../src/plan/paths";

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "fh-followup-resume-parent-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  writeFileSync(path.join(root, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function plantParentPlan(root: string, slug: string, body = "# Parent Plan\nstuff\n"): void {
  const folder = planFolderPath(root, slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, "milestone-plan.md"), body);
}

async function plantFollowupMetadata(
  root: string,
  followupSlug: string,
  parentSlug: string | undefined,
): Promise<void> {
  // Pre-create the followup folder + workflow metadata so the
  // resume codepath can read it without running through a full
  // start cycle.
  const folder = planFolderPath(root, followupSlug);
  mkdirSync(folder, { recursive: true });
  const meta = createWorkflowMetadata({
    slug: followupSlug,
    folderPath: workflowPlanFolderPath(root, followupSlug),
    ownerTool: "sf_team_followup",
    currentTool: "sf_team_followup",
    phase: "running",
    parentSlug,
  });
  await writeWorkflowMetadata(root, meta);
}

describe("sf_team_followup resume parent-context", () => {
  it("throws when the metadata is missing parentSlug", async () => {
    const { root, dispose } = makeRepo();
    try {
      await plantFollowupMetadata(root, "2026-05-08-followup-orphan", undefined);
      const tool = createSfTeamFollowup();
      await expect(
        tool({ resume: "2026-05-08-followup-orphan" }, { repoRoot: root }),
      ).rejects.toThrow(/missing parentSlug/i);
    } finally {
      dispose();
    }
  });

  it("throws when the slug is owned by a different tool (e.g. sf_team_task)", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-08-not-followup";
      const folder = planFolderPath(root, slug);
      mkdirSync(folder, { recursive: true });
      const meta = createWorkflowMetadata({
        slug,
        folderPath: workflowPlanFolderPath(root, slug),
        ownerTool: "sf_team_task",
        currentTool: "sf_team_task",
        phase: "running",
      });
      await writeWorkflowMetadata(root, meta);
      const tool = createSfTeamFollowup();
      await expect(
        tool({ resume: slug }, { repoRoot: root }),
      // The ownership check fires in resume-target analysis (upstream of
      // followup.ts), so the error wording is "owned by X; Y cannot
      // resume it". Either upstream message is acceptable as long as it
      // names the wrong owner.
      ).rejects.toThrow(/owned by sf_team_task/);
    } finally {
      dispose();
    }
  });

  it("throws an actionable error when the parent's milestone-plan.md is missing", async () => {
    const { root, dispose } = makeRepo();
    try {
      // parentSlug is set in metadata, but the parent folder has no
      // milestone-plan.md (the parent was never persisted as a five-file
      // plan, or the file was deleted out from under us).
      await plantFollowupMetadata(root, "2026-05-08-followup-orphan2", "2026-05-01-missing-parent");
      mkdirSync(planFolderPath(root, "2026-05-01-missing-parent"), { recursive: true });
      const tool = createSfTeamFollowup();
      await expect(
        tool({ resume: "2026-05-08-followup-orphan2" }, { repoRoot: root }),
      ).rejects.toThrow(/parent milestone-plan\.md not found/i);
    } finally {
      dispose();
    }
  });

  it("accepts an absolute path to the followup folder as the resume input", async () => {
    const { root, dispose } = makeRepo();
    try {
      const followupSlug = "2026-05-08-followup-fix-stuff";
      const parentSlug = "2026-05-01-the-parent";
      plantParentPlan(root, parentSlug);
      await plantFollowupMetadata(root, followupSlug, parentSlug);
      const tool = createSfTeamFollowup();
      const absolutePath = planFolderPath(root, followupSlug);
      // We don't run the full workflow here — we just want to confirm
      // resume target resolution + parent-slug lookup don't throw the
      // missing-metadata / wrong-owner / missing-parentSlug errors. The
      // workflow will fail downstream when the planner can't spawn, but
      // the FIRST guard it hits is the metadata read. We assert the
      // error is NOT one of the contract checks above.
      await expect(
        tool({ resume: absolutePath }, { repoRoot: root }),
      ).rejects.not.toThrow(/missing parentSlug|owned by|parent milestone-plan\.md not found/i);
    } finally {
      dispose();
    }
  });
});
