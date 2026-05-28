import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  TRANSCRIPT_FOLDER_NAME,
  TRANSCRIPT_IMPLEMENTATION_PHASE,
  TRANSCRIPT_PLANNING_PHASE,
  type TranscriptPhase,
  transcriptPhaseFolderPath,
} from "@pi-stef/agent-workflows";

/**
 * Per-orchestrator-run transcript: agent handoffs (researcher analysis,
 * planner draft, reviewer verdict, planner revision, etc.) get persisted
 * to `ai_plan/<slug>/transcript/<phase>/NNNN-<role>-<label>[...].md` so
 * the user can audit a long planner↔reviewer loop after the fact.
 *
 * The handle is exposed on `OrchestratorBodyContext.transcript`; tools
 * call `setPhase("implementation")` at the moment the workflow leaves the
 * planning phase (e.g. just before the developer agent is spawned). On
 * resume, each phase's counter is initialized from existing files so a
 * resumed run never overwrites old transcripts (`max+1`).
 *
 * Filename convention (alphabetical = chronological; 4-digit padding):
 *
 *   transcript/planning/0001-researcher-analysis-OK.md
 *   transcript/planning/0002-planner-draft.md
 *   transcript/planning/0003-reviewer-review-round-1-REVISE.md
 *   ...
 *   transcript/implementation/0001-developer-impl.md
 *   transcript/implementation/0002-reviewer-review-impl-round-1-REVISE.md
 *   ...
 *
 * Best-effort writes: a failed `mkdir`/`writeFile` never breaks the workflow.
 */
export interface TranscriptEntry {
  /** Who produced this output. `system` for orchestrator-emitted notes. */
  role: "researcher" | "planner" | "reviewer" | "developer" | "system";
  /** What kind of output: 'draft' | 'revision' | 'review' | 'impl' | 'analysis' | 'note' | etc. */
  label: string;
  /** Full body text (the agent's `finalText`, the verdict raw text, the diff, etc.). */
  body: string;
  /** Optional 1-indexed round number; appears in the filename when present. */
  round?: number;
  /** Optional terminal status; appears in the filename UPPER-CASED when present. */
  status?: "APPROVED" | "REVISE" | "ERROR" | "OK" | string;
  /** Optional metadata header lines prepended above `body` in the file. */
  meta?: Record<string, string | number | undefined>;
}

export interface TranscriptHandle {
  /**
   * Write a transcript entry to the active phase folder. Returns the
   * absolute path written, or `undefined` when the write failed (folder
   * denied, etc.). Callers should not rely on the path; it's exposed for
   * tests and diagnostics.
   */
  record(entry: TranscriptEntry): Promise<string | undefined>;
  /**
   * Switch the active phase. Subsequent `record(...)` calls land in
   * `transcript/<phase>/`. The per-phase counter persists across switches
   * so the next file in the phase is always `max+1`.
   */
  setPhase(phase: TranscriptPhase): void;
  /**
   * Folder the transcripts are landing in for the given phase (or the
   * active phase when no argument is supplied). Useful for help text.
   */
  folder(phase?: TranscriptPhase): string;
}

/**
 * Create a transcript handle rooted at an explicit plan folder path.
 * Use this when the plan folder may live outside the repo (e.g. when
 * aiPlanPath points to an external directory).
 */
export function createTranscriptFromFolder(planFolder: string): TranscriptHandle {
  const phasePath = (phase: TranscriptPhase) => path.join(planFolder, TRANSCRIPT_FOLDER_NAME, phase);
  let currentPhase: TranscriptPhase = TRANSCRIPT_PLANNING_PHASE;
  const counters: Record<TranscriptPhase, number> = {
    [TRANSCRIPT_PLANNING_PHASE]: scanExistingMaxSeqFromFolder(phasePath(TRANSCRIPT_PLANNING_PHASE)),
    [TRANSCRIPT_IMPLEMENTATION_PHASE]: scanExistingMaxSeqFromFolder(phasePath(TRANSCRIPT_IMPLEMENTATION_PHASE)),
  };
  return {
    folder(phase?: TranscriptPhase): string {
      return phasePath(phase ?? currentPhase);
    },
    setPhase(phase: TranscriptPhase): void {
      currentPhase = phase;
    },
    async record(entry: TranscriptEntry): Promise<string | undefined> {
      const folder = phasePath(currentPhase);
      counters[currentPhase] += 1;
      const seq = counters[currentPhase];
      const fileName = composeFileName(seq, entry);
      const filePath = path.join(folder, fileName);
      const body = composeBody(entry);
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(filePath, body, "utf8");
        return filePath;
      } catch {
        return undefined;
      }
    },
  };
}

export function createTranscript(repoRoot: string, slug: string): TranscriptHandle {
  let currentPhase: TranscriptPhase = TRANSCRIPT_PLANNING_PHASE;
  // Initialize each phase's counter from disk so a resumed run never
  // overwrites old transcripts. New runs see `max=0` and the first
  // `record(...)` lands at `0001`.
  const counters: Record<TranscriptPhase, number> = {
    [TRANSCRIPT_PLANNING_PHASE]: scanExistingMaxSeq(repoRoot, slug, TRANSCRIPT_PLANNING_PHASE),
    [TRANSCRIPT_IMPLEMENTATION_PHASE]: scanExistingMaxSeq(
      repoRoot,
      slug,
      TRANSCRIPT_IMPLEMENTATION_PHASE,
    ),
  };
  return {
    folder(phase?: TranscriptPhase): string {
      return transcriptPhaseFolderPath(repoRoot, slug, phase ?? currentPhase);
    },
    setPhase(phase: TranscriptPhase): void {
      currentPhase = phase;
    },
    async record(entry: TranscriptEntry): Promise<string | undefined> {
      const folder = transcriptPhaseFolderPath(repoRoot, slug, currentPhase);
      counters[currentPhase] += 1;
      const seq = counters[currentPhase];
      const fileName = composeFileName(seq, entry);
      const filePath = path.join(folder, fileName);
      const body = composeBody(entry);
      try {
        await mkdir(folder, { recursive: true });
        await writeFile(filePath, body, "utf8");
        return filePath;
      } catch {
        return undefined;
      }
    },
  };
}

function scanExistingMaxSeqFromFolder(folder: string): number {
  if (!existsSync(folder)) return 0;
  let max = 0;
  try {
    for (const name of readdirSync(folder)) {
      const m = /^(\d{4})-/.exec(name);
      if (m) {
        const value = Number(m[1]);
        if (Number.isFinite(value) && value > max) max = value;
      }
    }
  } catch {
    // ignore
  }
  return max;
}

function scanExistingMaxSeq(
  repoRoot: string,
  slug: string,
  phase: TranscriptPhase,
): number {
  const folder = transcriptPhaseFolderPath(repoRoot, slug, phase);
  return scanExistingMaxSeqFromFolder(folder);
}

// Padding width for the sequence prefix. Wide enough that even a long
// run with many tools wired (researcher + planner draft + reviewer×N +
// revision×N + dev impl + dev revisions + impl-review + system notes)
// never overflows. With 4 digits we cover up to 9999 entries — far
// beyond any realistic single tool invocation — and 4 keeps alphabetical
// ordering aligned with chronological insertion.
const SEQ_PAD = 4;

function composeFileName(seq: number, e: TranscriptEntry): string {
  const parts: string[] = [seq.toString().padStart(SEQ_PAD, "0"), sanitizeComponent(e.role), sanitizeComponent(e.label)];
  if (typeof e.round === "number") parts.push(`round-${e.round}`);
  if (e.status) parts.push(sanitizeComponent(e.status.toUpperCase()));
  return `${parts.join("-")}.md`;
}

/** Strip every character outside [A-Za-z0-9_-] so a stray `/` or `\0` in role/label/status can't escape the transcript folder. */
function sanitizeComponent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function composeBody(e: TranscriptEntry): string {
  const lines: string[] = [];
  lines.push(`# ${e.role} — ${e.label}${typeof e.round === "number" ? ` (round ${e.round})` : ""}${e.status ? ` — ${e.status.toUpperCase()}` : ""}`);
  lines.push("");
  if (e.meta) {
    for (const [k, v] of Object.entries(e.meta)) {
      if (v === undefined) continue;
      lines.push(`- **${k}**: ${v}`);
    }
    lines.push("");
  }
  lines.push(e.body);
  return lines.join("\n");
}
