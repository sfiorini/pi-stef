import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePlanTarget } from "../src/resume/resolve-plan-target";
import { ResumeTargetNotFoundError } from "../src/resume/errors";
import { upsertEntry } from "../src/resume/plan-index";

let tmpDir: string;
let originalHome: string;
const testHome = path.join(os.tmpdir(), `cascade-test-${process.pid}-${Date.now()}`);

function makeWorkflowJson(planRoot: string, slug: string): void {
  const dir = path.join(planRoot, slug, ".pi", "sf", "agent-workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workflow.json"), "{}", "utf8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-"));
  originalHome = os.homedir();
  Object.defineProperty(os, "homedir", { value: () => testHome, configurable: true });
  fs.mkdirSync(path.join(testHome, ".pi", "sf", "team"), { recursive: true });
});

afterEach(() => {
  Object.defineProperty(os, "homedir", { value: () => originalHome, configurable: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("resolvePlanTarget slug cascade", () => {
  const slug = "2026-05-26-my-task";

  it("prompt candidatePlanRoots[0] wins over all others", async () => {
    const promptRoot = path.join(tmpDir, "prompt-plans");
    const configRoot = path.join(tmpDir, "config-plans");
    const cwdRoot = path.join(tmpDir, "cwd-plans");
    makeWorkflowJson(promptRoot, slug);
    makeWorkflowJson(configRoot, slug);
    makeWorkflowJson(cwdRoot, slug);

    const result = await resolvePlanTarget({
      repoRoot: tmpDir,
      target: slug,
      candidatePlanRoots: [promptRoot, configRoot, cwdRoot],
    });

    expect(result.folderPath).toBe(path.join(promptRoot, slug));
  });

  it("second candidate wins when first has no workflow.json", async () => {
    const promptRoot = path.join(tmpDir, "prompt-plans"); // no workflow.json
    const configRoot = path.join(tmpDir, "config-plans");
    makeWorkflowJson(configRoot, slug);

    const result = await resolvePlanTarget({
      repoRoot: tmpDir,
      target: slug,
      candidatePlanRoots: [promptRoot, configRoot],
    });

    expect(result.folderPath).toBe(path.join(configRoot, slug));
  });

  it("falls through to global plan-index when all explicit candidates miss", async () => {
    const indexRoot = path.join(tmpDir, "index-plans");
    makeWorkflowJson(indexRoot, slug);
    upsertEntry(slug, { planRoot: indexRoot, tool: "sf_team_plan" });

    const result = await resolvePlanTarget({
      repoRoot: tmpDir,
      target: slug,
      candidatePlanRoots: [],
    });

    // planRoot is normalized via realpathSync, so compare normalized paths
    const normalizedRoot = fs.realpathSync(indexRoot);
    expect(result.folderPath).toBe(path.join(normalizedRoot, slug));
  });

  it("throws ResumeTargetNotFoundError(kind='ambiguous') when index has 2 live entries", async () => {
    const root1 = path.join(tmpDir, "plans-one");
    const root2 = path.join(tmpDir, "plans-two");
    makeWorkflowJson(root1, slug);
    makeWorkflowJson(root2, slug);
    upsertEntry(slug, { planRoot: root1, tool: "sf_team_plan" });
    upsertEntry(slug, { planRoot: root2, tool: "sf_team_plan" });

    const normalizedRoot1 = fs.realpathSync(root1);
    const normalizedRoot2 = fs.realpathSync(root2);

    await expect(
      resolvePlanTarget({ repoRoot: tmpDir, target: slug, candidatePlanRoots: [] }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ResumeTargetNotFoundError &&
        e.kind === "ambiguous" &&
        e.candidates.includes(normalizedRoot1) &&
        e.candidates.includes(normalizedRoot2),
    );
  });

  it("throws ResumeTargetNotFoundError(kind='not-found') when no candidate matches", async () => {
    await expect(
      resolvePlanTarget({ repoRoot: tmpDir, target: slug, candidatePlanRoots: [] }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ResumeTargetNotFoundError && e.kind === "not-found",
    );
  });

  it("absolute-path target still resolves directly (existing behavior)", async () => {
    const absFolder = path.join(tmpDir, "plans", slug);
    fs.mkdirSync(absFolder, { recursive: true });

    const result = await resolvePlanTarget({
      repoRoot: tmpDir,
      target: absFolder,
    });

    expect(result.folderPath).toBe(absFolder);
    expect(result.targetKind).toBe("absolute-path");
  });
});
