import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock, readLockMetadata } from "../src/lock/plan-lock";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-planroot-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("acquireLock with explicit planRoot", () => {
  it("lock dir lives under <planRoot>/<slug>/ not <repoRoot>/ai_plan/<slug>/", async () => {
    const planRoot = path.join(tmpDir, "custom-plans");
    const repoRoot = tmpDir;
    const slug = "2026-05-26-test-task";
    fs.mkdirSync(planRoot, { recursive: true });

    await acquireLock({ planRoot, repoRoot }, slug, "test");

    const lockDir = path.join(planRoot, slug, ".sf-team.lock");
    expect(fs.existsSync(lockDir)).toBe(true);

    // The old path (under repoRoot/ai_plan) must NOT be created
    const oldPath = path.join(repoRoot, "ai_plan", slug, ".sf-team.lock");
    expect(fs.existsSync(oldPath)).toBe(false);

    await releaseLock({ planRoot, repoRoot }, slug);
  });

  it("releaseLock removes lock dir under planRoot", async () => {
    const planRoot = path.join(tmpDir, "plans");
    const slug = "2026-05-26-release-test";
    fs.mkdirSync(planRoot, { recursive: true });

    await acquireLock({ planRoot, repoRoot: tmpDir }, slug, "test");
    const lockDir = path.join(planRoot, slug, ".sf-team.lock");
    expect(fs.existsSync(lockDir)).toBe(true);

    await releaseLock({ planRoot, repoRoot: tmpDir }, slug);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("readLockMetadata returns metadata from planRoot", async () => {
    const planRoot = path.join(tmpDir, "plans");
    const slug = "2026-05-26-meta-test";
    fs.mkdirSync(planRoot, { recursive: true });

    await acquireLock({ planRoot, repoRoot: tmpDir }, slug, "meta-test-command");
    const meta = await readLockMetadata({ planRoot, repoRoot: tmpDir }, slug);
    expect(meta?.slug).toBe(slug);
    expect(meta?.command).toBe("meta-test-command");

    await releaseLock({ planRoot, repoRoot: tmpDir }, slug);
  });
});

describe("acquireLock back-compat (string repoRoot only)", () => {
  it("still works with legacy string signature (defaults planRoot to repoRoot/ai_plan)", async () => {
    const slug = "2026-05-26-legacy";
    await acquireLock(tmpDir, slug, "legacy-test");
    const defaultLock = path.join(tmpDir, "ai_plan", slug, ".sf-team.lock");
    expect(fs.existsSync(defaultLock)).toBe(true);
    await releaseLock(tmpDir, slug);
  });
});
