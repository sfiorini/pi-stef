import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import { formatCost, type CostSummary } from "../orchestrator/cost";

export interface CostFooterHandle {
  update(): void;
  dispose(): void;
}

interface FooterComponent {
  invalidate(): void;
  render(width: number): string[];
  dispose(): void;
}

export function mountCostFooter(
  ui: ExtensionUIContext,
  getSummary: () => CostSummary,
  opts: { modelId?: string } = {},
): CostFooterHandle {
  const setFooter = (ui as { setFooter?: (footer: unknown) => void }).setFooter;
  if (typeof setFooter !== "function") {
    return { update: () => undefined, dispose: () => undefined };
  }

  let disposed = false;
  let requestRender: (() => void) | undefined;
  const factory = (tui: { requestRender?: () => void }, theme: { fg?: (name: string, value: string) => string }, footerData: {
    getGitBranch?: () => string | undefined;
    onBranchChange?: (cb: () => void) => () => void;
  }): FooterComponent => {
    requestRender = typeof tui.requestRender === "function" ? () => tui.requestRender?.() : undefined;
    const unsubscribeBranch = typeof footerData.onBranchChange === "function"
      ? footerData.onBranchChange(() => requestRender?.())
      : undefined;
    const color = (name: string, value: string): string => theme.fg?.(name, value) ?? value;

    return {
      invalidate(): void {},
      render(width: number): string[] {
        const left = color("muted", renderCostSummary(getSummary()));
        const rightParts = [
          opts.modelId,
          footerData.getGitBranch?.() ? `(${footerData.getGitBranch?.()})` : undefined,
        ].filter((value): value is string => !!value);
        const right = color("dim", rightParts.join(" "));
        const line = right ? `${left}  ${right}` : left;
        return [truncateToWidth(line, width)];
      },
      dispose(): void {
        unsubscribeBranch?.();
      },
    };
  };

  setFooter(factory);

  return {
    update(): void {
      if (disposed) return;
      requestRender?.();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        setFooter(undefined);
      } catch {
        // best-effort
      }
    },
  };
}

function renderCostSummary(summary: CostSummary): string {
  if (summary.total.knownCostCount === 0) return "sf-team cost pending";
  const total = formatCost(summary.total.costTotal);
  if (summary.total.unknownCostCount > 0) return `sf-team cost >=${total} (partial)`;
  if (summary.priorRunCount > 0 && summary.prior.knownCostCount > 0) {
    return `sf-team cost ${total} (prior ${formatCost(summary.prior.costTotal)} + current ${formatCost(summary.current.costTotal)})`;
  }
  return `sf-team cost ${total}`;
}

function truncateToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  return value.length > width ? value.slice(0, width) : value;
}
