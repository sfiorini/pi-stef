import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createWorkflowMetadata,
  readWorkflowMetadata,
  writeWorkflowMetadata,
} from "../src";

function tmp(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "wf-persist-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("workflow.json persistence — planRootPath, gitMode, tddMode", () => {
  it("round-trips planRootPath, gitMode, tddMode when supplied", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-26-persist-test";
      const planRootPath = path.join(root, "my-plans");
      const metadata = createWorkflowMetadata({
        slug,
        folderPath: path.join(planRootPath, slug),
        ownerTool: "sf_team_plan",
        currentTool: "sf_team_plan",
        phase: "planner",
        planRootPath,
        gitMode: "off",
        tddMode: "auto",
      });

      expect(metadata.planRootPath).toBe(planRootPath);
      expect(metadata.gitMode).toBe("off");
      expect(metadata.tddMode).toBe("auto");

      await writeWorkflowMetadata(root, metadata);
      const reread = await readWorkflowMetadata(root, slug);
      expect(reread?.planRootPath).toBe(planRootPath);
      expect(reread?.gitMode).toBe("off");
      expect(reread?.tddMode).toBe("auto");
    } finally {
      dispose();
    }
  });

  it("legacy files without planRootPath/gitMode/tddMode fall back to defaults", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-26-legacy-test";
      // Create metadata without new fields (simulates a file written by old code)
      const metadata = createWorkflowMetadata({
        slug,
        folderPath: path.join(root, "ai_plan", slug),
        ownerTool: "sf_team_task",
        currentTool: "sf_team_task",
        phase: "developer",
      });

      await writeWorkflowMetadata(root, metadata);
      const reread = await readWorkflowMetadata(root, slug);
      // Legacy defaults: planRootPath = path.join(repoRoot, 'ai_plan'), gitMode = 'on', tddMode = 'auto'
      expect(reread?.gitMode).toBe("on");
      expect(reread?.tddMode).toBe("auto");
      // planRootPath default is derived from folderPath's parent (or may be undefined)
      // Key assertion: no throw, gitMode and tddMode are defined strings
      expect(typeof reread?.gitMode).toBe("string");
      expect(typeof reread?.tddMode).toBe("string");
    } finally {
      dispose();
    }
  });
});
