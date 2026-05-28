import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { acquireLock, sweepStaleLockDirs } from "../src/plan/lock";

/**
 * Audit fix #9: stale lockdirs across `ai_plan/<*>/` are reaped on
 * acquireLock when their mtime is > 24h AND they have no live holder.
 */
describe("audit fix #9: stale lockdir sweep", () => {
  it("sweepStaleLockDirs removes empty lockdirs older than 24h", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-sweep-"));
    try {
      const lockDir = path.join(root, "ai_plan", "old-slug", ".sf-team.lock");
      mkdirSync(lockDir, { recursive: true });
      // Backdate the lockdir mtime to 30h ago.
      const past = (Date.now() - 30 * 60 * 60 * 1000) / 1000;
      utimesSync(lockDir, past, past);

      const removed = await sweepStaleLockDirs(root);
      expect(removed).toContain(lockDir);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT touch a fresh lockdir (mtime within 24h) even with no metadata", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-sweep-fresh-"));
    try {
      const lockDir = path.join(root, "ai_plan", "fresh-slug", ".sf-team.lock");
      mkdirSync(lockDir, { recursive: true });
      // mtime is now (default) — within 24h.
      const removed = await sweepStaleLockDirs(root);
      expect(removed).toEqual([]);
      expect(existsSync(lockDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("acquireLock sweeps stale siblings as a side-effect", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ct-sweep-acquire-"));
    try {
      // Pre-create a stale sibling lockdir.
      const staleSibling = path.join(root, "ai_plan", "old-x", ".sf-team.lock");
      mkdirSync(staleSibling, { recursive: true });
      const past = (Date.now() - 30 * 60 * 60 * 1000) / 1000;
      utimesSync(staleSibling, past, past);

      // Acquire a lock for a different slug.
      mkdirSync(path.join(root, "ai_plan"), { recursive: true });
      await acquireLock(root, "new-slug", "sf_team_plan");
      // Stale sibling should be gone after acquire's sweep.
      expect(existsSync(staleSibling)).toBe(false);
      // Our new lockdir is held.
      expect(existsSync(path.join(root, "ai_plan", "new-slug", ".sf-team.lock"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
