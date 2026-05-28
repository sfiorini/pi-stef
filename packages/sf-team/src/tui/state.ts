import type { WorkflowMessage } from "@pi-stef/agent-workflows";
import type { TeamMemberRole } from "../runtime/types";

/**
 * Widget state model. Mutated by JSON-event wiring (S-806) and
 * fs.watch on story-tracker.md (S-807); rendered as a string[] by
 * the agent-card / milestone-strip / resume-banner modules.
 */

export type AgentState = "idle" | "running" | "stalled" | "completed" | "failed" | "aborted";

export interface AgentCard {
  /** Stable id; survives re-renders. */
  id: string;
  /** Display name (typically the role). */
  role: TeamMemberRole;
  model: string;
  state: AgentState;
  /** Most recent activity hint (last tool call, last text-delta marker, etc.). */
  activity?: string;
  /** Last assistant transcript snippet (≤80 chars), populated from message_end events. */
  transcript?: string;
  /** Wall-clock start (ms since epoch) for elapsed display. */
  startedAtMs?: number;
  /**
   * Wall-clock end (ms since epoch). Set when state transitions to a
   * terminal value (completed / failed / aborted / stalled). Used by the
   * renderer to FREEZE the elapsed timer at the completion time instead
   * of letting it tick forever.
   */
  endedAtMs?: number;
  /**
   * 1-indexed round counter — incremented every time the orchestrator
   * re-uses this card for a fresh spawn of the same role (e.g. round 3
   * of the planner ↔ reviewer loop). Rendered in the head line when > 1.
   */
  round?: number;
  /** Optional parent agent id for tree-indent (S-803). */
  parentId?: string;
  /**
   * Milestone id this card belongs to (e.g. "M1"). Rendered between the
   * elapsed timer and the round suffix when set. Lets users tell which
   * milestone an agent is working on without inspecting the card id.
   */
  milestoneId?: string;
  /**
   * Optional story id for parallel story lanes (e.g. "S-101"). Rendered
   * beside the milestone so users can distinguish simultaneous developers
   * working within the same milestone.
   */
  storyId?: string;
}

export interface MilestoneProgress {
  id: string;
  title: string;
  /** completed / inDev / total stories. */
  completed: number;
  inDev: number;
  total: number;
  approvalStatus?: string;
}

export interface ResumeBanner {
  show: boolean;
  text?: string;
}

export interface WidgetState {
  agents: AgentCard[];
  milestones: MilestoneProgress[];
  resume: ResumeBanner;
  lockState: { holderPid?: number; sinceIso?: string } | undefined;
  messages: WorkflowMessage[];
}

export function emptyState(): WidgetState {
  return { agents: [], milestones: [], resume: { show: false }, lockState: undefined, messages: [] };
}

export function upsertAgent(state: WidgetState, card: AgentCard): WidgetState {
  const idx = state.agents.findIndex((a) => a.id === card.id);
  const agents = [...state.agents];
  if (idx >= 0) agents[idx] = { ...agents[idx], ...card };
  else agents.push(card);
  return { ...state, agents };
}

export function updateAgent(state: WidgetState, id: string, patch: Partial<AgentCard>): WidgetState {
  const agents = state.agents.map((a) => (a.id === id ? { ...a, ...patch } : a));
  return { ...state, agents };
}

export function setMilestones(state: WidgetState, milestones: MilestoneProgress[]): WidgetState {
  return { ...state, milestones };
}

export function setResume(state: WidgetState, resume: ResumeBanner): WidgetState {
  return { ...state, resume };
}

export function setLockState(state: WidgetState, lockState: WidgetState["lockState"]): WidgetState {
  return { ...state, lockState };
}

export function setMessages(state: WidgetState, messages: WorkflowMessage[]): WidgetState {
  return { ...state, messages };
}

/**
 * Drop all agent cards from the widget. Used at milestone boundaries (and
 * at the plan→implement phase boundary in `sf_team_auto`) so the panel
 * shows only the agents working on the current milestone — completed
 * cards from prior milestones are recorded in transcript files anyway,
 * and keeping them in the widget pushes the active cards off-screen.
 *
 * Preserves `milestones`, `resume`, and `lockState` — only `agents` is
 * reset to an empty array.
 */
export function clearAgents(state: WidgetState): WidgetState {
  if (state.agents.length === 0) return state;
  return { ...state, agents: [] };
}
