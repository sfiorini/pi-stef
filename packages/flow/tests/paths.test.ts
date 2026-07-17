import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { globalWorkflowsDir, projectWorkflowsDir, resolveWorkflowPath } from "../src/paths.js";

describe("workflow dir helpers", () => {
  it("globalWorkflowsDir is <home>/.pi/sf/flow/workflows", () => {
    expect(globalWorkflowsDir("/h")).toBe(join("/h", ".pi", "sf", "flow", "workflows"));
  });

  it("projectWorkflowsDir is <repo>/.pi/sf/flow/workflows", () => {
    expect(projectWorkflowsDir("/r")).toBe(join("/r", ".pi", "sf", "flow", "workflows"));
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
