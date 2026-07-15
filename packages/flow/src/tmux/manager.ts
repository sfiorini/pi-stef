/**
 * tmux session manager: enablement, session naming, owner-stamp adoption, and
 * the event-subscription controller that turns pi-subagents lifecycle events
 * into pane open/close calls. Adapted from packages/team (rewired to pi-dw's
 * event stream; see ./events-spike.md).
 */

/** tmux option key used to stamp the launching session (owner-stamp). */
export const OWNER_OPTION = "@sf-flow-owner-of";

/** tmux is enabled unless explicitly disabled via env. */
export function isEnabled(): boolean {
  if (process.env.SF_FLOW_NO_TMUX === "1") return false;
  if (process.env.SF_FLOW_NO_TMUX === "0") return true;
  // tmux-not-installed -> no-op (checked lazily at pane creation)
  return true;
}

/** Session name: `sf-flow-<hex>`. */
export function sessionName(hex: string): string {
  return `sf-flow-${hex}`;
}

/**
 * Adopt a session only if its name matches THIS launcher's session name.
 * (M6 ships the name-match guard; a full tmux owner-stamp read via OWNER_OPTION
 * is layered on once the tmux spawn infrastructure exists.)
 */
export function shouldAdopt(candidateSession: string, launcherSession: string): boolean {
  return candidateSession === launcherSession;
}

/** The pi-subagents lifecycle events the controller cares about. */
export type FlowEvent =
  | { type: "subagents:created"; id: string }
  | { type: "subagents:started"; id: string }
  | { type: "subagents:completed"; id: string }
  | { type: "subagents:failed"; id: string }
  | { type: "subagents:compacted"; id: string };

export interface FlowTmuxCallbacks {
  onCreated: (id: string) => void;
  onTerminal: (id: string) => void;
}

/**
 * In production this subscribes to the pi event bus
 * (`subagents:created` -> open pane; `subagents:completed`|`subagents:failed`
 * -> close pane). For testability, the controller exposes an `emit` that drives
 * the same callbacks, so the open/close logic is unit-testable without a real
 * pi session. Non-terminal events (started/record/compacted) are ignored.
 */
export function createFlowTmuxController(cb: FlowTmuxCallbacks): {
  emit: (event: string, payload: { id: string }) => void;
} {
  return {
    emit: (event, payload) => {
      try {
        if (event === "subagents:created") cb.onCreated(payload.id);
        if (event === "subagents:completed" || event === "subagents:failed") cb.onTerminal(payload.id);
      } catch {
        // A misbehaving pane callback must not break the event pipeline.
      }
    },
  };
}
