import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { acquireLock, isLockStale, LockHeldError, planFolderPath, readLockMetadata, releaseLock, sweepStaleLockDirs } from "../src";

function tmp(): { root: string; dispose: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workflows-lock-"));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("plan-folder lock", () => {
  it("acquires, reads, and releases lock metadata", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-06-lock";
      const meta = await acquireLock(root, slug, "sf_team_plan");

      expect(meta).toMatchObject({ pid: process.pid, slug, command: "sf_team_plan" });
      await expect(acquireLock(root, slug, "sf_team_implement")).rejects.toBeInstanceOf(LockHeldError);
      expect(await readLockMetadata(root, slug)).toMatchObject({ pid: process.pid, slug });

      await releaseLock(root, slug);
      expect(await readLockMetadata(root, slug)).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("takes over a stale lock from a dead pid", async () => {
    const { root, dispose } = tmp();
    try {
      const slug = "2026-05-06-stale";
      const lockDir = path.join(planFolderPath(root, slug), ".sf-team.lock");
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(
        path.join(lockDir, "metadata.json"),
        JSON.stringify({
          pid: 999_999,
          startedAt: "2020-01-01T00:00:00.000Z",
          processStartedAt: "",
          hostname: hostname(),
          command: "old",
          slug,
        }),
      );

      const meta = await acquireLock(root, slug, "sf_team_plan");
      expect(meta.pid).toBe(process.pid);
      expect(meta.command).toBe("sf_team_plan");
    } finally {
      dispose();
    }
  });

  it("sweeps stale sibling lock directories older than 24 hours", async () => {
    const { root, dispose } = tmp();
    try {
      const staleSibling = path.join(root, "ai_plan", "old-plan", ".sf-team.lock");
      mkdirSync(staleSibling, { recursive: true });
      const past = (Date.now() - 30 * 60 * 60 * 1000) / 1000;
      utimesSync(staleSibling, past, past);

      const removed = await sweepStaleLockDirs(root);
      expect(removed).toContain(staleSibling);
      expect(existsSync(staleSibling)).toBe(false);
    } finally {
      dispose();
    }
  });

  it("treats an alive same-host pid as live when process start time is unavailable", async () => {
    expect(
      await isLockStale({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        processStartedAt: "",
        hostname: hostname(),
        command: "sf_team_plan",
        slug: "live",
      }),
    ).toBe(false);
  });
});
