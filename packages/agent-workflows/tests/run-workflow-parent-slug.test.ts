import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createWorkflowMetadata,
  planFolderPath,
  readWorkflowMetadata,
  runWorkflow,
  writeWorkflowMetadata,
} from "../src";

const noopReporter = () => ({
  message: (text: string) => text,
  clearMessage: () => undefined,
  dispose: () => undefined,
});

describe("runWorkflow parentSlug threading", () => {
  it("persists parentSlug into workflow.json on first start when provided", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-ps-"));
    try {
      await runWorkflow(
        {
          repoRoot: root,
          slug: "child-slug",
          toolName: "sf_team_followup",
          useWorktree: false,
          parentSlug: "parent-slug",
          promptForResume: async () => ({ resume: true }),
          createReporter: noopReporter,
        },
        async () => "ok",
      );
      const meta = await readWorkflowMetadata(root, "child-slug");
      expect(meta?.parentSlug).toBe("parent-slug");
      expect(meta?.ownerTool).toBe("sf_team_followup");
      expect(meta?.slug).toBe("child-slug");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT set parentSlug when not provided", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-ps-none-"));
    try {
      await runWorkflow(
        {
          repoRoot: root,
          slug: "stand-alone",
          toolName: "sf_team_task",
          useWorktree: false,
          promptForResume: async () => ({ resume: true }),
          createReporter: noopReporter,
        },
        async () => "ok",
      );
      const meta = await readWorkflowMetadata(root, "stand-alone");
      expect(meta?.parentSlug).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves parentSlug across resume — input parentSlug is ignored when metadata already has one", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wf-ps-resume-"));
    try {
      // First run: write parentSlug=A
      await runWorkflow(
        {
          repoRoot: root,
          slug: "child-slug",
          toolName: "sf_team_followup",
          useWorktree: false,
          parentSlug: "parent-A",
          promptForResume: async () => ({ resume: true }),
          createReporter: noopReporter,
        },
        async () => "ok",
      );
      // Second run (resume): try to override with parent-B; the existing
      // parent-A must win.
      await runWorkflow(
        {
          repoRoot: root,
          slug: "child-slug",
          toolName: "sf_team_followup",
          useWorktree: false,
          parentSlug: "parent-B",
          resumeMode: true,
          promptForResume: async () => ({ resume: true }),
          createReporter: noopReporter,
        },
        async () => "ok",
      );
      const meta = await readWorkflowMetadata(root, "child-slug");
      expect(meta?.parentSlug).toBe("parent-A");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("createWorkflowMetadata preserves parentSlug across write/read roundtrip", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wm-ps-"));
    try {
      const meta = createWorkflowMetadata({
        slug: "child",
        folderPath: planFolderPath(root, "child"),
        ownerTool: "sf_team_followup",
        currentTool: "sf_team_followup",
        phase: "running",
        parentSlug: "parent",
      });
      await writeWorkflowMetadata(root, meta);
      const read = await readWorkflowMetadata(root, "child");
      expect(read?.parentSlug).toBe("parent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
