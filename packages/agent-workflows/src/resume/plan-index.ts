import fs from "node:fs";
import path from "node:path";
import { globalDir } from "@pi-stef/paths";
import { WORKFLOW_FOLDER_NAME, WORKFLOW_METADATA_FILE } from "../artifacts/paths";

export interface PlanIndexEntry {
  planRoot: string;
  lastSeenAt: string;
  lastTool: string;
}

interface PlanIndex {
  version: 1;
  entries: Record<string, PlanIndexEntry[]>;
}

function indexPath(): string {
  return path.join(globalDir("team"), "plan-index.json");
}

function emptyIndex(): PlanIndex {
  return { version: 1, entries: {} };
}

function sanitizeEntries(raw: unknown): Record<string, PlanIndexEntry[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, PlanIndexEntry[]> = {};
  for (const [slug, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(val)) continue;
    const entries = val.filter(
      (e): e is PlanIndexEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as Record<string, unknown>).planRoot === "string" &&
        typeof (e as Record<string, unknown>).lastSeenAt === "string" &&
        typeof (e as Record<string, unknown>).lastTool === "string",
    );
    out[slug] = entries;
  }
  return out;
}

export function readIndex(): PlanIndex {
  const p = indexPath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && "entries" in parsed) {
      return {
        version: 1,
        entries: sanitizeEntries((parsed as { entries: unknown }).entries),
      };
    }
    return emptyIndex();
  } catch {
    return emptyIndex();
  }
}

function writeIndex(idx: PlanIndex): void {
  const p = indexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function normalizePlanRoot(planRoot: string): string {
  try {
    return fs.realpathSync(planRoot);
  } catch {
    return planRoot;
  }
}

export function upsertEntry(slug: string, opts: { planRoot: string; tool: string }): void {
  const idx = readIndex();
  const normalizedRoot = normalizePlanRoot(opts.planRoot);
  const entries = idx.entries[slug] ?? [];

  const existingIdx = entries.findIndex((e) => {
    try {
      return normalizePlanRoot(e.planRoot) === normalizedRoot;
    } catch {
      return e.planRoot === opts.planRoot;
    }
  });

  const entry: PlanIndexEntry = {
    planRoot: normalizedRoot,
    lastSeenAt: new Date().toISOString(),
    lastTool: opts.tool,
  };

  if (existingIdx >= 0) {
    entries[existingIdx] = entry;
  } else {
    entries.push(entry);
  }

  idx.entries[slug] = entries;
  writeIndex(idx);
}

function workflowJsonExists(planRoot: string, slug: string): boolean {
  const wfPath = path.join(planRoot, slug, WORKFLOW_FOLDER_NAME, WORKFLOW_METADATA_FILE);
  try {
    fs.accessSync(wfPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function lookupEntries(slug: string): PlanIndexEntry[] {
  const idx = readIndex();
  const entries = idx.entries[slug] ?? [];
  return entries.filter((e) => workflowJsonExists(e.planRoot, slug));
}
