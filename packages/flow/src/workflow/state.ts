import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PhaseState {
  id: string;
  status: "success" | "blocked" | "in-progress" | "pending";
  outputs: Record<string, unknown>;
  artifacts: string[];
}
export interface StateFile {
  workflowName: string;
  workflowHash: string;
  inputHash: string;
  slug: string;
  startedAt?: string;
  phases: PhaseState[];
  worktree?: { worktreePath: string; branchName: string; baseSha?: string };
  terminalResult?: unknown;
}

/** Path of the checkpoint file for a plan dir. */
export function statePath(dir: string): string {
  return join(dir, ".flow-state.json");
}

/** Load a checkpoint, or null when none exists / unreadable. */
export function loadState(dir: string): StateFile | null {
  try {
    return JSON.parse(readFileSync(statePath(dir), "utf8")) as StateFile;
  } catch {
    return null;
  }
}

export interface WorkflowStateSeed {
  workflowName: string;
  workflowHash: string;
  inputHash: string;
  slug: string;
  /** Full ordered phase-id list — seeds pending rows so resume reflects workflow order. Not persisted. */
  phaseIds: string[];
}

/**
 * Mutable view over a `.flow-state.json`. The constructor seeds the FULL ordered
 * phase list (all "pending") from `phaseIds` so `firstIncomplete()` reflects
 * workflow order, not just phases that already ran. `phaseIds` is kept OUT of
 * the persisted shape (it is workflow metadata, not run state).
 */
export class WorkflowState {
  readonly data: StateFile;

  constructor(private dir: string, seed: WorkflowStateSeed) {
    const existing = loadState(dir);
    const { phaseIds, ...rest } = seed;
    this.data =
      existing ??
      ({
        ...rest,
        phases: phaseIds.map((id) => ({ id, status: "pending", outputs: {}, artifacts: [] })),
      });
    // forward-compat: if the workflow grew phases since the last run, represent the new ones
    for (const id of phaseIds) {
      if (!this.data.phases.find((p) => p.id === id)) {
        this.data.phases.push({ id, status: "pending", outputs: {}, artifacts: [] });
      }
    }
  }

  private find(id: string): PhaseState | undefined {
    return this.data.phases.find((p) => p.id === id);
  }

  /** Publish outputs + artifacts for a phase (in-memory; pair with write() or use complete()). */
  publish(id: string, outputs: Record<string, unknown>, artifacts: string[]): void {
    const ph = this.find(id) ?? { id, status: "in-progress" as const, outputs: {}, artifacts: [] };
    Object.assign(ph.outputs, outputs);
    ph.artifacts = [...new Set([...ph.artifacts, ...artifacts])];
    if (!this.find(id)) this.data.phases.push(ph);
  }

  /** Load the values of required names from prior publishes. Blocked when any is missing. */
  loadRequired(names: string[]): {
    status: "success" | "blocked";
    values: Record<string, unknown>;
    missing: string[];
  } {
    const values: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const n of names) {
      const found = this.data.phases.find((p) => n in p.outputs);
      if (found) values[n] = found.outputs[n];
      else missing.push(n);
    }
    return { status: missing.length ? "blocked" : "success", values, missing };
  }

  /** Set a phase status (in-memory; pair with write()). */
  mark(id: string, status: PhaseState["status"]): void {
    const ph = this.find(id) ?? { id, status, outputs: {}, artifacts: [] };
    ph.status = status;
    if (!this.find(id)) this.data.phases.push(ph);
  }

  /**
   * Atomic publish + mark success + persist — ONE tool call, ONE disk write per
   * phase. Use this in the epilogue so published values reach disk before the
   * next phase's load-required reads them (avoids the publish→write race where a
   * fresh load between two separate calls would drop the in-memory publish and
   * starve the next phase).
   */
  complete(id: string, outputs: Record<string, unknown>, artifacts: string[]): void {
    this.publish(id, outputs, artifacts);
    this.mark(id, "success");
    this.write();
  }

  /** Index of the first phase not yet "success", or -1 when all succeeded. */
  firstIncomplete(): number {
    return this.data.phases.findIndex((p) => p.status !== "success");
  }

  /** Atomically persist the state (temp + rename). */
  write(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = statePath(this.dir) + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, statePath(this.dir)); // atomic
  }
}
