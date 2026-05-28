/**
 * Public types for the sf-team agent runtime.
 *
 * `TeamMember` is the static description of an agent (role + model + skills).
 * `AgentRun` is the execution record produced by `spawnAgent`. The orchestrator
 * inspects `state`, `events`, `toolCalls`, and `finalText` to drive the review
 * loop forward. Process-group cleanup on abort is handled by `killTree` —
 * `parentPid` and `childPids` are diagnostic-only (best-effort, may be empty
 * in restricted sandboxes; cleanup never depends on them).
 */
import type { ThinkingLevel } from "../config/schema";

/** Strict role union; the reviewer profile is immutable (see `argv.ts`). */
export type AgentRole = "planner" | "developer" | "reviewer" | "researcher";
export type TeamMemberRole = AgentRole | "steering-decider";

export interface TeamMember {
  role: TeamMemberRole;
  model: string;
  thinking?: ThinkingLevel;
  /** Names of skills to resolve via `resolveSkillPath`. Reviewer must always be empty. */
  skills?: string[];
  /**
   * Per-role override for the spawn watchdog threshold in ms. Falls back to
   * AgentTask.heartbeatMs and then to spawn's DEFAULT_HEARTBEAT_MS.
   */
  heartbeatMs?: number;
}

export interface AgentTask {
  /** The user prompt passed via `-p`. Subject to centralized secret scan. */
  task: string;
  /**
   * Optional system-prompt body. When provided, written to a temp file and
   * passed via `--append-system-prompt <file>`. Subject to centralized secret
   * scan exactly like `task`.
   */
  appendSystemPrompt?: string;
  /** Process cwd. Defaults to process.cwd(). */
  cwd?: string;
  /** Heartbeat threshold; default 60_000 ms. Once exceeded the run is `stalled`. */
  heartbeatMs?: number;
  /**
   * Soft deadline; once elapsed the watchdog kills the tree (SIGTERM → 2s →
   * SIGKILL). Independent of the heartbeat.
   */
  softTimeoutMs?: number;
  /** PID tree handle the orchestrator can keep for emergency cleanup. */
  signal?: AbortSignal;
}

export type AgentRunState = "running" | "completed" | "failed" | "stalled" | "aborted";

export type AgentEvent =
  | { kind: "stdout-json"; raw: Record<string, unknown> }
  | { kind: "usage"; usage: AgentTokenUsage }
  | { kind: "tool_call"; toolName: string; input: unknown }
  | { kind: "stderr"; text: string }
  | { kind: "stalled"; lastEventAtMs: number }
  /**
   * Soft warning fired by the watchdog when stdout has been silent for the
   * configured heartbeat threshold BUT the child process is still alive
   * (process-liveness probe returned true). Distinguished from `stalled`
   * because pi can legitimately go silent on stdout for many minutes during
   * a long inference call (Anthropic SSE pings are consumed inside the HTTP
   * layer and never surface as stdout bytes). Emitted purely for diagnostics
   * — does NOT trigger a kill. The watchdog only kills when either the
   * probe says the process is dead OR the absolute timeout is exceeded.
   */
  | { kind: "stall-warning"; silenceMs: number; lastEventAtMs: number }
  | { kind: "aborted" }
  | { kind: "exit"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; message: string };

export interface ToolCallObservation {
  toolName: string;
  input: unknown;
}

export interface AgentRunMetrics {
  startedAtMs: number;
  spawnedAtMs?: number;
  firstStdoutAtMs?: number;
  firstStderrAtMs?: number;
  firstTextDeltaAtMs?: number;
  firstThinkingDeltaAtMs?: number;
  firstToolEventAtMs?: number;
  agentEndAtMs?: number;
  closeAtMs?: number;
  rawLogFinishedAtMs?: number;
  totalDurationMs?: number;
  timeToFirstStdoutMs?: number;
  timeToFirstTextDeltaMs?: number;
  timeFromAgentEndToCloseMs?: number;
}

export interface AgentTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal?: number;
}

export interface AgentContextUsage {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

export interface ToolExecutionTiming {
  id?: string;
  toolName: string;
  command?: string;
  startedAtMs: number;
  finishedAtMs?: number;
  durationMs?: number;
  isError?: boolean;
}

export interface AgentEventSummary {
  /** Number of text-delta stream events summarized instead of retaining payload-heavy raw events. */
  textDeltaCount: number;
  /** Number of thinking-delta stream events summarized instead of retaining payload-heavy raw events. */
  thinkingDeltaCount: number;
  /** Total events omitted from AgentRun.events because of stream compaction or first/tail retention caps. */
  compactedEventCount: number;
}

export interface AgentRun {
  /** Final state. Exactly one of: completed | failed | stalled | aborted. */
  state: Exclude<AgentRunState, "running">;
  /** Pi child pid. Undefined if spawn failed before fork. */
  pid: number | undefined;
  /** Parent (this Node process) pid; useful for nested cleanup. */
  parentPid: number;
  /**
   * Best-effort list of grandchild PIDs observed during the run, sampled via
   * pgrep / ps. Process-group cleanup does NOT depend on this list — `killTree`
   * always SIGKILLs the entire detached process group. This array is purely
   * diagnostic and may be empty in sandboxes where pgrep + ps -A are both
   * restricted.
   */
  childPids: number[];
  /** Low-cardinality timing data. Contains no prompt/output/tool payloads. */
  metrics: AgentRunMetrics;
  /** Exit code of the pi child. */
  exitCode: number | null;
  /** Aggregated final assistant text from `agent_end.messages`. */
  finalText: string;
  /**
   * Bounded captured event stream — protocol/lifecycle/tool events with
   * high-volume text/thinking deltas summarized in eventSummary.
   */
  events: AgentEvent[];
  /** True when events were omitted from `events` and summarized. */
  eventsCompacted: boolean;
  /** Low-cardinality summary for compacted stream/runtime events. */
  eventSummary: AgentEventSummary;
  /** Tool calls observed in the protocol stream (not the same as events.kind="tool_call"; convenience). */
  toolCalls: ToolCallObservation[];
  /** Per-agent model token/cost usage when the provider exposes it in Pi's JSON events. */
  usage?: AgentTokenUsage;
  /** Current/estimated context-window usage when Pi exposes it in JSON events. */
  contextUsage?: AgentContextUsage;
  /** Tool execution timings observed from Pi `tool_execution_start`/`tool_execution_end` events. */
  toolExecutions?: ToolExecutionTiming[];
  /** Last 8 KiB of stderr; preserved for diagnostics on failure. */
  stderrTail: string;
  /** Free-form reason populated for stalled/aborted/failed runs. */
  reason?: string;
}
