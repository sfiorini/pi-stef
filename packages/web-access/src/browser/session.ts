import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WebAccessConfig } from "../types";

const SESSION_METADATA = "sf-session.json";

export interface SessionInfo {
  metadata?: Record<string, unknown>;
  mtimeMs: number;
  name: string;
  path: string;
}

export interface ClearSessionResult {
  name: string;
  path: string;
  removed: boolean;
}

export function profilePath(config: WebAccessConfig, profile = "default"): string {
  return path.join(config.profilesDir, sanitizeProfileName(profile));
}

export async function ensureProfileDir(config: WebAccessConfig, profile = "default"): Promise<string> {
  const dir = profilePath(config, profile);
  await mkdir(dir, { mode: 0o700, recursive: true });
  await chmodPrivate(dir);
  return dir;
}

export async function writeSessionMetadata(
  config: WebAccessConfig,
  profile: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const dir = await ensureProfileDir(config, profile);
  const file = path.join(dir, SESSION_METADATA);
  await writeFile(file, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await chmodPrivate(file);
  return file;
}

export async function listSessions(config: WebAccessConfig): Promise<SessionInfo[]> {
  let entries;
  try {
    entries = await readdir(config.profilesDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sessions: SessionInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionPath = path.join(config.profilesDir, entry.name);
    const stats = await stat(sessionPath);
    sessions.push({
      metadata: await readMetadata(sessionPath),
      mtimeMs: stats.mtimeMs,
      name: entry.name,
      path: sessionPath,
    });
  }
  return sessions.sort((a, b) => a.name.localeCompare(b.name));
}

export async function clearSession(config: WebAccessConfig, profile: string, yes: boolean): Promise<ClearSessionResult> {
  const target = profilePath(config, profile);
  if (!yes) {
    throw new Error(`Clearing session ${sanitizeProfileName(profile)} requires confirmation`);
  }
  await rm(target, { force: true, recursive: true });
  return { name: sanitizeProfileName(profile), path: target, removed: true };
}

export function sanitizeProfileName(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "default";
}

async function readMetadata(sessionPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path.join(sessionPath, SESSION_METADATA), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function chmodPrivate(target: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await import("node:fs/promises").then(({ chmod }) => chmod(target, target.endsWith(SESSION_METADATA) ? 0o600 : 0o700));
}
