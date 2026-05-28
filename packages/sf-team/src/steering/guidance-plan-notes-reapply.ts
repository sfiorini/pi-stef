import type { WorkflowReporter } from "@pi-stef/agent-workflows";

import { appendSteeringPlanNote } from "./guidance-plan-notes";
import type { SteeringStore } from "./store";

export interface ReapplyPlanNotesInput {
  store: SteeringStore;
  planFolder: string;
  repoRoot: string;
  reporter?: WorkflowReporter;
}

/**
 * After a workflow writes the plan folder wholesale (e.g. sf_team_plan's
 * final writePlanFolder), any steering plan notes that the drain appended
 * mid-workflow are clobbered. This reapplies them: for every currently
 * active guidance row, call appendSteeringPlanNote — which is idempotent
 * on the (source:instructionId) provenance marker, so notes that weren't
 * overwritten are skipped.
 *
 * Failures are non-fatal; each row is best-effort.
 */
export async function reapplySteeringPlanNotes(input: ReapplyPlanNotesInput): Promise<{
  reapplied: string[];
  failures: Array<{ instructionId: string; message: string }>;
}> {
  const reapplied: string[] = [];
  const failures: Array<{ instructionId: string; message: string }> = [];
  const active = await input.store.listActiveGuidance();
  for (const row of active) {
    try {
      const result = await appendSteeringPlanNote({
        planFolderPath: input.planFolder,
        repoRoot: input.repoRoot,
        guidance: row,
      });
      if (result.wrote.milestonePlan || result.wrote.finalTranscript) {
        reapplied.push(row.instructionId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ instructionId: row.instructionId, message: msg });
      input.reporter?.message(
        `steering-plan-note-reapply-failed for ${row.instructionId}: ${msg}`,
        { level: "warning" },
      );
    }
  }
  return { reapplied, failures };
}
