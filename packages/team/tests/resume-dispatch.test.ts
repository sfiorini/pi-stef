import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { findLatestWorkflow, resolveOwnerTool } from "../src/tools/resume-dispatch";

function workflowJson(overrides: Record<string, unknown>) {
  return JSON.stringify({
    schemaVersion: 1,
    slug: "test",
    folderPath: "/tmp/test",
    ownerTool: "sf_team_plan",
    currentTool: "sf_team_plan",
    createdAt: "2026-06-04T10:00:00Z",
    updatedAt: "2026-06-04T10:00:00Z",
    status: "running",
    phase: "planning",
    checkpoints: {},
    commitIntents: {},
    ...overrides,
  });
}

async function createWorkflow(tmpDir: string, slug: string, meta: Record<string, unknown>) {
  const wfDir = path.join(tmpDir, slug, ".pi", "sf", "agent-workflows");
  await fs.mkdir(wfDir, { recursive: true });
  await fs.writeFile(path.join(wfDir, "workflow.json"), workflowJson({ slug, folderPath: path.join(tmpDir, slug), ...meta }));
}

describe("findLatestWorkflow", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when planRoot does not exist", async () => {
    const result = await findLatestWorkflow(path.join(tmpDir, "nonexistent"));
    expect(result).toBeUndefined();
  });

  it("returns undefined when planRoot is empty", async () => {
    const result = await findLatestWorkflow(tmpDir);
    expect(result).toBeUndefined();
  });

  it("returns the single workflow when one exists", async () => {
    const slug = "2026-06-04-my-plan";
    await createWorkflow(tmpDir, slug, { updatedAt: "2026-06-04T10:00:00Z" });

    const result = await findLatestWorkflow(tmpDir);
    expect(result).toEqual({ slug, folderPath: path.join(tmpDir, slug) });
  });

  it("returns the most recently updated workflow when multiple exist", async () => {
    const older = "2026-06-03-older";
    const newer = "2026-06-04-newer";

    await createWorkflow(tmpDir, older, { updatedAt: "2026-06-03T10:00:00Z" });
    await createWorkflow(tmpDir, newer, { updatedAt: "2026-06-04T12:00:00Z" });

    const result = await findLatestWorkflow(tmpDir);
    expect(result?.slug).toBe(newer);
  });

  it("skips directories without workflow.json", async () => {
    await fs.mkdir(path.join(tmpDir, "no-metadata"), { recursive: true });

    const slug = "2026-06-04-has-metadata";
    await createWorkflow(tmpDir, slug, { updatedAt: "2026-06-04T10:00:00Z" });

    const result = await findLatestWorkflow(tmpDir);
    expect(result?.slug).toBe(slug);
  });
});

describe("resolveOwnerTool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resolve-owner-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ownerTool from workflow.json", async () => {
    const slug = "test-plan";
    await createWorkflow(tmpDir, slug, { ownerTool: "sf_team_auto", currentTool: "sf_team_implement" });

    const result = await resolveOwnerTool(path.join(tmpDir, slug), slug);
    expect(result).toBe("sf_team_auto");
  });

  it("throws when workflow.json is missing", async () => {
    const folderPath = path.join(tmpDir, "no-metadata");
    await fs.mkdir(folderPath, { recursive: true });

    await expect(resolveOwnerTool(folderPath, "no-metadata")).rejects.toThrow(
      "workflow metadata not found",
    );
  });
});
