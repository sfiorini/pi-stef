import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SteeringWorkflowKind } from "./path-safety";

export type ActiveWorkflowToolName =
  | "sf_team_plan"
  | "sf_team_implement"
  | "sf_team_auto"
  | "sf_team_task"
  | "sf_team_followup";

export interface ActiveWorkflowRecord {
  workflowId: string;
  workflowKind: SteeringWorkflowKind;
  toolName: ActiveWorkflowToolName;
  planSlug?: string;
  repoRoot: string;
  steeringRoot: string;
  startedAt: string;
  updatedAt: string;
  pid: number;
}

export interface ActiveWorkflowCandidate {
  workflowId: string;
  workflowKind: SteeringWorkflowKind;
  toolName: ActiveWorkflowToolName;
  planSlug?: string;
  steeringRoot: string;
  startedAt: string;
}

export type ActiveWorkflowResolution =
  | { status: "resolved"; record: ActiveWorkflowRecord }
  | { status: "none" }
  | { status: "ambiguous"; candidates: ActiveWorkflowCandidate[] };

export interface ActiveWorkflowRegistry {
  readonly filePath: string;
  register(input: Omit<ActiveWorkflowRecord, "toolName" | "startedAt" | "updatedAt" | "pid"> & {
    toolName?: ActiveWorkflowToolName;
    startedAt?: string;
    updatedAt?: string;
    pid?: number;
  }): Promise<ActiveWorkflowRecord>;
  unregister(workflowId: string): Promise<void>;
  list(): Promise<ActiveWorkflowRecord[]>;
  resolve(target?: { workflowId?: string; planSlug?: string }): Promise<ActiveWorkflowResolution>;
}

interface ActiveWorkflowFile {
  version: number;
  records: ActiveWorkflowRecord[];
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

const REGISTRY_MUTEXES = new Map<string, AsyncMutex>();

export function activeWorkflowRegistryPath(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), ".sf-team", "active-workflows.json");
}

export function createActiveWorkflowRegistry(repoRoot: string): ActiveWorkflowRegistry {
  const filePath = activeWorkflowRegistryPath(repoRoot);
  const mutex = REGISTRY_MUTEXES.get(filePath) ?? new AsyncMutex();
  REGISTRY_MUTEXES.set(filePath, mutex);
  return new FileActiveWorkflowRegistry(filePath, mutex);
}

export function workflowKindFromToolName(toolName: string): SteeringWorkflowKind | undefined {
  switch (toolName) {
    case "sf_team_plan":
    case "sf_team_plan_resume":
      return "plan";
    case "sf_team_implement":
    case "sf_team_implement_resume":
      return "implement";
    case "sf_team_auto":
    case "sf_team_auto_resume":
      return "auto";
    case "sf_team_task":
    case "sf_team_task_resume":
      return "task";
    case "sf_team_followup":
    case "sf_team_followup_resume":
      return "followup";
    default:
      return undefined;
  }
}

export function baseToolNameFromKind(kind: SteeringWorkflowKind): ActiveWorkflowToolName {
  switch (kind) {
    case "plan":
      return "sf_team_plan";
    case "implement":
      return "sf_team_implement";
    case "auto":
      return "sf_team_auto";
    case "task":
      return "sf_team_task";
    case "followup":
      return "sf_team_followup";
  }
}

class FileActiveWorkflowRegistry implements ActiveWorkflowRegistry {
  constructor(
    readonly filePath: string,
    private readonly mutex: AsyncMutex,
  ) {}

  async register(input: Omit<ActiveWorkflowRecord, "toolName" | "startedAt" | "updatedAt" | "pid"> & {
    toolName?: ActiveWorkflowToolName;
    startedAt?: string;
    updatedAt?: string;
    pid?: number;
  }): Promise<ActiveWorkflowRecord> {
    return await this.mutex.run(async () => {
      const current = await this.readFile();
      const now = new Date().toISOString();
      const record: ActiveWorkflowRecord = {
        ...input,
        toolName: input.toolName ?? baseToolNameFromKind(input.workflowKind),
        repoRoot: path.resolve(input.repoRoot),
        startedAt: input.startedAt ?? now,
        updatedAt: input.updatedAt ?? now,
        pid: input.pid ?? process.pid,
      };
      const records = current.records.filter((existing) => existing.workflowId !== record.workflowId);
      records.push(record);
      await writeJsonAtomic(this.filePath, { version: current.version + 1, records } satisfies ActiveWorkflowFile);
      return record;
    });
  }

  async unregister(workflowId: string): Promise<void> {
    await this.mutex.run(async () => {
      const current = await this.readFile();
      await writeJsonAtomic(this.filePath, {
        version: current.version + 1,
        records: current.records.filter((record) => record.workflowId !== workflowId),
      } satisfies ActiveWorkflowFile);
    });
  }

  async list(): Promise<ActiveWorkflowRecord[]> {
    return await this.mutex.run(async () => (await this.readFile()).records);
  }

  async resolve(target: { workflowId?: string; planSlug?: string } = {}): Promise<ActiveWorkflowResolution> {
    const records = await this.list();
    let matches = records;
    if (target.workflowId) matches = matches.filter((record) => record.workflowId === target.workflowId);
    if (target.planSlug) matches = matches.filter((record) => record.planSlug === target.planSlug);

    if (matches.length === 0) return { status: "none" };
    if (matches.length === 1) return { status: "resolved", record: matches[0] };
    return { status: "ambiguous", candidates: matches.map(toCandidate) };
  }

  private async readFile(): Promise<ActiveWorkflowFile> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as ActiveWorkflowFile;
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
        return { version: 0, records: [] };
      }
      throw err;
    }
  }
}

function toCandidate(record: ActiveWorkflowRecord): ActiveWorkflowCandidate {
  return {
    workflowId: record.workflowId,
    workflowKind: record.workflowKind,
    toolName: record.toolName,
    planSlug: record.planSlug,
    steeringRoot: record.steeringRoot,
    startedAt: record.startedAt,
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}
