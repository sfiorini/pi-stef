import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  globalWorkflowsDir,
  projectWorkflowsDir,
  resolveWorkflowPath,
  packageRoot,
  templatesDir,
  planTemplatesDir,
  resolveTemplate,
} from "../src/paths.js";

describe("workflow dir helpers", () => {
  it("globalWorkflowsDir is <home>/.pi/sf/flow/workflows", () => {
    expect(globalWorkflowsDir("/h")).toBe(join("/h", ".pi", "sf", "flow", "workflows"));
  });

  it("projectWorkflowsDir is <repo>/.pi/sf/flow/workflows", () => {
    expect(projectWorkflowsDir("/r")).toBe(join("/r", ".pi", "sf", "flow", "workflows"));
  });
});

describe("template path helpers", () => {
  it("packageRoot resolves to the flow package dir", () => {
    expect(existsSync(packageRoot())).toBe(true);
    expect(packageRoot()).toMatch(/packages[\\/]flow$/);
  });

  it("templatesDir exists and contains plan/ + workflow.yaml", () => {
    expect(existsSync(templatesDir())).toBe(true);
    expect(existsSync(join(templatesDir(), "workflow.yaml"))).toBe(true);
    expect(existsSync(join(templatesDir(), "plan"))).toBe(true);
  });

  it("planTemplatesDir resolves the four plan-file skeletons", () => {
    const dir = planTemplatesDir();
    for (const f of ["story-tracker.md", "milestone-plan.md", "original-plan.md", "continuation-runbook.md"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });

  it("resolveTemplate maps @flow/ refs into the templates dir and leaves others as-is", () => {
    expect(resolveTemplate("@flow/plan/story-tracker.md")).toBe(join(templatesDir(), "plan", "story-tracker.md"));
    expect(resolveTemplate("@flow/workflow.yaml")).toBe(join(templatesDir(), "workflow.yaml"));
    expect(resolveTemplate("ai_plan/x/original-plan.md")).toBe("ai_plan/x/original-plan.md");
    expect(resolveTemplate("/abs/path.md")).toBe("/abs/path.md");
  });
});

describe("resolveWorkflowPath", () => {
  it("returns null when the workflow exists in neither location", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-h-"));
    const repo = mkdtempSync(join(tmpdir(), "flow-r-"));
    expect(await resolveWorkflowPath("nope", repo, home)).toBeNull();
  });

  it("resolves to the global default when only the global file exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-h-"));
    const repo = mkdtempSync(join(tmpdir(), "flow-r-"));
    mkdirSync(globalWorkflowsDir(home), { recursive: true });
    writeFileSync(join(globalWorkflowsDir(home), "code-review.yaml"), "name: code-review");
    expect(await resolveWorkflowPath("code-review", repo, home)).toBe(
      join(globalWorkflowsDir(home), "code-review.yaml"),
    );
  });

  it("project override wins over global", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-h-"));
    const repo = mkdtempSync(join(tmpdir(), "flow-r-"));
    mkdirSync(globalWorkflowsDir(home), { recursive: true });
    writeFileSync(join(globalWorkflowsDir(home), "code-review.yaml"), "name: code-review");
    mkdirSync(projectWorkflowsDir(repo), { recursive: true });
    writeFileSync(join(projectWorkflowsDir(repo), "code-review.yaml"), "name: code-review # override");
    expect(await resolveWorkflowPath("code-review", repo, home)).toBe(
      join(projectWorkflowsDir(repo), "code-review.yaml"),
    );
  });

  it("resolves to the project file when only the project file exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-h-"));
    const repo = mkdtempSync(join(tmpdir(), "flow-r-"));
    mkdirSync(projectWorkflowsDir(repo), { recursive: true });
    writeFileSync(join(projectWorkflowsDir(repo), "ship-feature.yaml"), "name: ship-feature");
    expect(await resolveWorkflowPath("ship-feature", repo, home)).toBe(
      join(projectWorkflowsDir(repo), "ship-feature.yaml"),
    );
  });
});
