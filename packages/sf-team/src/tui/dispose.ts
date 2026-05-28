import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { renderWorkflowMessages } from "@pi-stef/agent-workflows";

import type { WidgetState } from "./state";
import { renderAgentCards } from "./agent-card";
import { renderMilestoneStrip } from "./milestone-strip";
import { renderResumeBanner } from "./resume-banner";

const WIDGET_KEY = "sf-team";

export interface WidgetHandle {
  /** Re-render with the latest state. Idempotent. */
  update(state: WidgetState): void;
  /** Tear down the widget. Idempotent; safe to call multiple times. */
  dispose(): void;
}

/**
 * Mount the sf-team widget on `pi.ui.setWidget`. Returns a handle the
 * orchestrator stores and calls in its `finally` teardown path so the widget
 * vanishes on every exit (success / error / abort).
 *
 * The widget renders as string[] (the simpler `setWidget` overload) so we
 * don't need to bundle pi-tui components for diagnostic output. The
 * orchestrator can swap in a richer Component later if desired.
 */
export function mountWidget(
  ui: ExtensionUIContext,
  opts: { useColor?: boolean; now?: () => number } = {},
): WidgetHandle {
  // If the host pi runtime doesn't expose setWidget (older versions, test
  // stubs), return a no-op handle so the orchestrator can keep calling
  // update() / dispose() without crashing.
  if (typeof ui.setWidget !== "function") {
    return { update: () => undefined, dispose: () => undefined };
  }
  let disposed = false;
  const nowFn = opts.now ?? Date.now;
  const render = (state: WidgetState): string[] => {
    if (disposed) return [];
    const lines: string[] = [];
    lines.push("── sf-team ────");
    const banner = renderResumeBanner(state.resume);
    if (banner.length > 0) {
      lines.push(...banner);
      lines.push("");
    }
    const messages = renderWorkflowMessages(state.messages);
    if (messages.length > 0) {
      lines.push(...messages);
      lines.push("");
    }
    if (state.milestones.length > 0) {
      lines.push(...renderMilestoneStrip(state.milestones));
      lines.push("");
    }
    lines.push(...renderAgentCards(state, { useColor: opts.useColor, now: nowFn() }));
    return lines;
  };
  return {
    update(state: WidgetState): void {
      if (disposed) return;
      ui.setWidget(WIDGET_KEY, render(state));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // best-effort
      }
    },
  };
}
