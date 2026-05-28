import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { readWorkflowMetadata } from "@pi-stef/agent-workflows";

import { planFolderPath } from "../src/plan/paths";
import { runOrchestrator } from "../src/orchestrator/run";

function makeRepo(): { root: string; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-orch-ps-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "a@b"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "tester"], { cwd: dir });
  writeFileSync(path.join(dir, "README.md"), "hi");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return { root: dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("runOrchestrator parentSlug threading", () => {
  it("forwards parentSlug into the workflow.json metadata", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "child-followup";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      await runOrchestrator(
        {
          repoRoot: root,
          slug,
          toolName: "sf_team_followup",
          useWorktree: false,
          parentSlug: "the-parent-plan",
        },
        async () => "ok",
      );
      const meta = await readWorkflowMetadata(root, slug);
      expect(meta?.parentSlug).toBe("the-parent-plan");
    } finally {
      dispose();
    }
  });

  it("does NOT set parentSlug for stand-alone tasks", async () => {
    const { root, dispose } = makeRepo();
    try {
      const slug = "stand-alone-task";
      mkdirSync(planFolderPath(root, slug), { recursive: true });
      await runOrchestrator(
        {
          repoRoot: root,
          slug,
          toolName: "sf_team_task",
          useWorktree: false,
        },
        async () => "ok",
      );
      const meta = await readWorkflowMetadata(root, slug);
      expect(meta?.parentSlug).toBeUndefined();
    } finally {
      dispose();
    }
  });
});
