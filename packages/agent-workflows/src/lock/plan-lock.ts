import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, rm, rename, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { planFolderPath, planFolderPathFromRoot, PLAN_FOLDER_ROOT } from "../artifacts/paths"; // migration-allowed: legacy

export type LockTarget = string | { planRoot: string; repoRoot: string };

function resolvePlanFolder(target: LockTarget, slug: string): string {
  if (typeof target === "string") return planFolderPath(target, slug); // migration-allowed: legacy
  return planFolderPathFromRoot(target.planRoot, slug);
}

function resolveSweepRoot(target: LockTarget): string {
  if (typeof target === "string") return path.join(target, PLAN_FOLDER_ROOT); // migration-allowed: legacy
  return target.planRoot;
}

const LOCK_DIR = ".sf-team.lock";
const META_FILE = "metadata.json";
const STALE_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface LockMetadata {
  pid: number;
  /** Lock-acquired-at, ISO 8601. */
  startedAt: string;
  /**
   * Process start time as reported by `ps -p <pid> -o lstart=`. When the host
   * cannot be queried, stale checks degrade to pid-alive-only.
   */
  processStartedAt: string;
  hostname: string;
  command: string;
  slug: string;
}

export class LockHeldError extends Error {
  readonly held: LockMetadata;

  constructor(message: string, held: LockMetadata) {
    super(message);
    this.name = "LockHeldError";
    this.held = held;
  }
}

export async function acquireLock(
  target: LockTarget,
  slug: string,
  command: string,
  opts: { now?: Date; pid?: number; hostnameOverride?: string } = {},
): Promise<LockMetadata> {
  await sweepStaleLockDirs(target, opts.hostnameOverride).catch(() => undefined);

  const folder = resolvePlanFolder(target, slug);
  await mkdir(folder, { recursive: true });

  const lockDirPath = path.join(folder, LOCK_DIR);
  const metaPath = path.join(lockDirPath, META_FILE);
  const pid = opts.pid ?? process.pid;
  const meta: LockMetadata = {
    pid,
    startedAt: (opts.now ?? new Date()).toISOString(),
    processStartedAt: queryProcessStartedAt(pid),
    hostname: opts.hostnameOverride ?? hostname(),
    command,
    slug,
  };

  const uniq = `${process.pid}.${process.hrtime.bigint().toString(36)}.${Math.random().toString(36).slice(2)}`;
  const maxAttempts = 16;
  const crashResidueThreshold = 4;
  let consecutiveMissingMeta = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await mkdir(lockDirPath);
      try {
        await writeFile(metaPath, JSON.stringify(meta, null, 2), { encoding: "utf8", flag: "wx" });
        return meta;
      } catch (writeErr) {
        if (!isExistsOrNotEmpty(writeErr) && !isNoEnt(writeErr)) throw writeErr;
        await sleep(jitter());
        continue;
      }
    } catch (mkdirErr) {
      if (!isExistsOrNotEmpty(mkdirErr)) throw mkdirErr;
    }

    const existing = await readMetaIfPresent(metaPath);
    if (!existing) {
      consecutiveMissingMeta += 1;
      if (consecutiveMissingMeta < crashResidueThreshold) {
        await sleep(jitter());
        continue;
      }
    } else {
      consecutiveMissingMeta = 0;
      const stale = await isLockStale(existing, opts.hostnameOverride);
      if (!stale) {
        throw new LockHeldError(
          `sf-team plan-folder lock held by pid=${existing.pid} on ${existing.hostname} since ${existing.startedAt}`,
          existing,
        );
      }
    }

    const killedPath = path.join(folder, `${LOCK_DIR}.killed.${uniq}.${attempt}`);
    try {
      await rename(lockDirPath, killedPath);
    } catch (err) {
      if (isNoEnt(err) || isExistsOrNotEmpty(err)) {
        await sleep(jitter());
        continue;
      }
      throw err;
    }
    await rm(killedPath, { recursive: true, force: true }).catch(() => undefined);
    consecutiveMissingMeta = 0;
  }

  const held = (await readMetaIfPresent(metaPath)) ?? meta;
  throw new LockHeldError(
    `sf-team plan-folder lock contended after ${maxAttempts} attempts (current: pid=${held.pid} on ${held.hostname})`,
    held,
  );
}

export async function releaseLock(target: LockTarget, slug: string): Promise<void> {
  const lockDirPath = path.join(resolvePlanFolder(target, slug), LOCK_DIR);
  await rm(lockDirPath, { recursive: true, force: true });
}

export async function readLockMetadata(target: LockTarget, slug: string): Promise<LockMetadata | undefined> {
  const metaPath = path.join(resolvePlanFolder(target, slug), LOCK_DIR, META_FILE);
  return readMetaIfPresent(metaPath);
}

export async function isLockStale(meta: LockMetadata, hostnameOverride?: string): Promise<boolean> {
  const localHost = hostnameOverride ?? hostname();
  if (meta.hostname !== localHost) return true;

  try {
    process.kill(meta.pid, 0);
  } catch (err) {
    if (typeof err === "object" && err && (err as { code?: string }).code === "EPERM") {
      return false;
    }
    return true;
  }

  if (meta.processStartedAt.length === 0) return false;

  const currentStart = queryProcessStartedAt(meta.pid);
  if (currentStart.length === 0) return false;

  return currentStart !== meta.processStartedAt;
}

export async function sweepStaleLockDirs(target: LockTarget, hostnameOverride?: string): Promise<string[]> {
  const removed: string[] = [];
  const root = resolveSweepRoot(target);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return removed;
  }

  const now = Date.now();
  for (const slug of entries) {
    const lockDir = path.join(root, slug, LOCK_DIR);
    let st;
    try {
      st = await stat(lockDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (now - st.mtimeMs <= STALE_SWEEP_MAX_AGE_MS) continue;

    const meta = await readMetaIfPresent(path.join(lockDir, META_FILE));
    if (meta) {
      const stale = await isLockStale(meta, hostnameOverride).catch(() => false);
      if (!stale) continue;
    }

    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    removed.push(lockDir);
  }

  return removed;
}

async function readMetaIfPresent(metaPath: string): Promise<LockMetadata | undefined> {
  try {
    const raw = await readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as LockMetadata;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.processStartedAt === "string" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.command === "string" &&
      typeof parsed.slug === "string"
    ) {
      return parsed;
    }
  } catch {
    // Missing or corrupt metadata is treated as no metadata.
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(): number {
  return 5 + Math.floor(Math.random() * 10);
}

function isExistsOrNotEmpty(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "EPERM";
}

function isNoEnt(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function queryProcessStartedAt(pid: number): string {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return "";
  return r.stdout.trim();
}
