import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { CursorModel, CursorParameterizedModel } from "./model-config.js";

/**
 * Persisted model-discovery cache. Lets Cursor survive restarts with a fresh
 * model list when live discovery is unavailable (offline / no OAuth token /
 * GetUsableModels RPC times out), instead of falling back to the stale bundled
 * FALLBACK_MODELS (src/cursor-models-raw.json), which is missing recent models.
 *
 * Stored at ~/.pi/agent/cursor-models-cache.json. Resolved directly with
 * os.homedir() because getAgentDir() is not available from the pi-coding-agent
 * peer dependency; mirrors npmNodeModulesDir() in @pi-stef/catalog.
 */
export interface CachedCursorModels {
  rawModels: CursorModel[];
  parameterizedModels: CursorParameterizedModel[];
  savedAt: number;
  tokenHash: string;
}

const CACHE_FILENAME = "cursor-models-cache.json";

export function getCursorModelsCachePath(home: string = homedir()): string {
  return join(home, ".pi", "agent", CACHE_FILENAME);
}

export function readCachedCursorModels(home: string = homedir()): CachedCursorModels | null {
  let text: string;
  try {
    text = readFileSync(getCursorModelsCachePath(home), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.rawModels) || !Array.isArray(obj.parameterizedModels)) {
    return null;
  }
  return {
    rawModels: obj.rawModels as CursorModel[],
    parameterizedModels: obj.parameterizedModels as CursorParameterizedModel[],
    savedAt: typeof obj.savedAt === "number" ? obj.savedAt : 0,
    tokenHash: typeof obj.tokenHash === "string" ? obj.tokenHash : "",
  };
}

export function writeCachedCursorModels(
  rawModels: CursorModel[],
  parameterizedModels: CursorParameterizedModel[],
  tokenHash: string,
  home: string = homedir(),
): void {
  try {
    const cachePath = getCursorModelsCachePath(home);
    mkdirSync(dirname(cachePath), { recursive: true });
    const payload: CachedCursorModels = {
      rawModels,
      parameterizedModels,
      savedAt: Date.now(),
      tokenHash,
    };
    writeFileSync(cachePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* non-fatal: next startup falls back to FALLBACK_MODELS */
  }
}
