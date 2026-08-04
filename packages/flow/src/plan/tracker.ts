/**
 * Milestone/story tracker state model (spec §12, D9/D19). The engine asserts a
 * phase that declares `assert: [tracker_updated]` (or `tracker_valid`) by parsing
 * the main-checkout `ai_plan/<slug>/story-tracker.md` and checking every recorded
 * transition is legal and every implemented/approved story carries a commit SHA.
 *
 * Pure + synchronous: no I/O. The caller (assertArtifacts) reads the file and
 * hands the markdown here.
 */

export type StoryState =
  | "pending"
  | "in-dev"
  | "implemented"
  | "review-failed"
  | "approved"
  | "blocked";

export const STORY_STATES: StoryState[] = [
  "pending",
  "in-dev",
  "implemented",
  "review-failed",
  "approved",
  "blocked",
];

/** Legal forward transitions. Terminal/empty arrays mean no outgoing edge. */
export const STORY_TRANSITIONS: Record<StoryState, StoryState[]> = {
  pending: ["in-dev"],
  "in-dev": ["implemented", "blocked"],
  implemented: ["review-failed", "approved"],
  "review-failed": ["in-dev"],
  approved: [],
  blocked: ["in-dev"],
};

export function canTransition(from: StoryState, to: StoryState): boolean {
  return STORY_TRANSITIONS[from].includes(to);
}

export interface StoryRow {
  id: string;
  milestone: string;
  state: StoryState;
  commit?: string;
}

export type MilestoneState = "pending" | "in-progress" | "review" | "approved" | "blocked";

export interface TrackerModel {
  stories: StoryRow[];
  milestones: Record<string, MilestoneState>;
}

/** A milestone is approved only when every one of its stories is approved. */
export function milestoneApproved(t: TrackerModel, m: string): boolean {
  const ms = t.stories.filter((s) => s.milestone === m);
  return ms.length > 0 && ms.every((s) => s.state === "approved");
}

/**
 * Validate transitioning story `id` to `to`. Returns a list of error strings
 * (empty when valid): illegal transition, or a missing commit SHA for
 * implemented/approved.
 */
export function assertValidTransition(
  t: TrackerModel,
  id: string,
  to: StoryState,
  commit?: string,
): string[] {
  const errs: string[] = [];
  const row = t.stories.find((s) => s.id === id);
  if (!row) return [`story ${id} not found`];
  if (!canTransition(row.state, to)) errs.push(`${id}: ${row.state} -> ${to} not allowed`);
  if ((to === "implemented" || to === "approved") && !commit) {
    errs.push(`${id}: ${to} requires a commit SHA`);
  }
  return errs;
}

/**
 * Tolerant parser for the story-tracker.md table. Reads rows shaped
 * `| S-<id> | <milestone> | <state> | <commit|—> | <notes> |`; ignores headers,
 * separators, and non-story rows. Returns null when no story rows are found.
 */
export function parseTracker(markdown: string): TrackerModel | null {
  const stories: StoryRow[] = [];
  const milestones: Record<string, MilestoneState> = {};
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(S-[\w-]+)\s*\|\s*([\w-]+)\s*\|\s*([A-Za-z][\w-]*)\s*\|\s*([^|]*?)\s*\|/);
    if (!m) continue;
    const [, id, milestone, state, commit] = m;
    if (!STORY_STATES.includes(state as StoryState)) continue; // skip non-story rows
    const c = (commit ?? "").trim();
    stories.push({
      id,
      milestone,
      state: state as StoryState,
      commit: c && c !== "—" ? c : undefined,
    });
    if (!(milestone in milestones)) milestones[milestone] = "pending";
  }
  return stories.length ? { stories, milestones } : null;
}
