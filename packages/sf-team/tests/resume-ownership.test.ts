import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createWorkflowMetadata, writeWorkflowMetadata } from "@pi-stef/agent-workflows";

import { createSfTeamImplement } from "../src/tools/implement";
import { createSfTeamPlan } from "../src/tools/plan";

function makeRepo(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "resume-ownership-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: root });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: root });
  mkdirSync(path.join(root, "ai_plan"), { recursive: true });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

async function writeOwner(root: string, slug: string, ownerTool: Parameters<typeof createWorkflowMetadata>[0]["ownerTool"]): Promise<void> {
  const folder = path.join(root, "ai_plan", slug);
  mkdirSync(folder, { recursive: true });
  await writeWorkflowMetadata(root, createWorkflowMetadata({
    slug,
    folderPath: folder,
    ownerTool,
    currentTool: ownerTool,
    phase: "test",
  }));
}

describe("resume ownership", () => {
  it("rejects same-folder resume before spawning when the owner tool differs", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-06-owned-by-task";
      await writeOwner(root, slug, "sf_team_task");
      const spawnAgent = vi.fn();
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never });

      await expect(tool({ resume: slug } as never, { repoRoot: root })).rejects.toThrow(
        /owned by sf_team_task.*sf_team_plan/,
      );
      expect(spawnAgent).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("rejects auto-owned plans through sf_team_implement resume before spawning", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "2026-05-06-owned-by-auto";
      await writeOwner(root, slug, "sf_team_auto");
      const spawnAgent = vi.fn();
      const tool = createSfTeamImplement({ spawnAgent: spawnAgent as never });

      await expect(tool({ resume: slug, verifyCommand: false } as never, { repoRoot: root })).rejects.toThrow(
        /owned by sf_team_auto.*sf_team_implement/,
      );
      expect(spawnAgent).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("rejects neither-input and both-input shapes with friendly errors before spawning", async () => {
    const { root, dispose } = makeRepo();
    try {
      const spawnAgent = vi.fn();
      const tool = createSfTeamPlan({ spawnAgent: spawnAgent as never });

      await expect(tool({} as never, { repoRoot: root })).rejects.toThrow(/provide either title or resume/);
      await expect(tool({ title: "New plan", resume: "old-plan" } as never, { repoRoot: root })).rejects.toThrow(
        /provide either title or resume, not both/,
      );
      expect(spawnAgent).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });
});
