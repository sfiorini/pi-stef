import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { detectResumeState, type ResumeState } from "../plan/resume";

export interface ResumePromptResult {
  state: ResumeState;
  /** True when the user wants to resume; false when they want to discard / start fresh. */
  resume: boolean;
}

/**
 * On tool entry, detect any prior in-flight run for `slug` and ask the user
 * whether to resume or discard. When the plan folder is missing OR no
 * in-dev stories exist, returns resume=true silently (nothing to ask).
 *
 * Locked plan decision #15: tracker is the source of truth; we prompt with
 * `pi.ui.confirm` so the user can press Esc to abort.
 */
export async function promptForResume(
  repoRoot: string,
  slug: string,
  ui: Pick<ExtensionUIContext, "confirm"> | undefined,
): Promise<ResumePromptResult> {
  const state = await detectResumeState(repoRoot, slug);
  if (!state.exists || state.inDev.length === 0) {
    return { state, resume: true };
  }
  if (!ui?.confirm) {
    // Headless context (RPC / print mode). Default to resume since aborting
    // by default would lose work.
    return { state, resume: true };
  }
  const idList = state.inDev.map((s) => s.id).join(", ");
  const ok = await ui.confirm(
    "Resume previous sf-team run?",
    `Found in-dev stories: ${idList}. Resume from where you left off?`,
  );
  return { state, resume: ok === true };
}
