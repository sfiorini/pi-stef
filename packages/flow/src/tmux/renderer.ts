/**
 * When tmux is disabled (SF_FLOW_NO_TMUX=1 or tmux.enabled=false), the renderer
 * is a byte-identical no-op: callers check this flag and skip rendering, so the
 * output of a disabled run is identical to a run with no tmux at all.
 */
export const NOOP_WHEN_DISABLED = true;

export type Theme = "codex" | "plain";
export type AgentStatus = "pending" | "running" | "done" | "failed";

export interface PaneState {
  phase: string;
  agent: string;
  status: AgentStatus;
  tokPct: number;
  model: string;
  theme: Theme;
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const STATUS_GLYPH: Record<AgentStatus, string> = {
  pending: "·",
  running: "▸",
  done: "✓",
  failed: "✗",
};

/**
 * Render a single pane header line. codex theme wraps the line in an ANSI color
 * chosen by status; plain emits the raw line with no escape codes.
 */
export function renderPane(p: PaneState): { header: string } {
  const glyph = STATUS_GLYPH[p.status];
  const pct = `${p.tokPct}%`;
  const raw = `${p.phase} ${glyph} ${p.agent} ${p.status} ${pct} ${p.model}`;
  if (p.theme === "plain") return { header: raw };
  const color =
    p.status === "done"
      ? ANSI.green
      : p.status === "failed"
        ? ANSI.red
        : p.status === "running"
          ? ANSI.yellow
          : ANSI.dim;
  return { header: `${color}${raw}${ANSI.reset}` };
}
