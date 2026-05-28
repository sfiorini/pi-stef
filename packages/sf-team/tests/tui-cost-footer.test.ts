import { describe, expect, it, vi } from "vitest";

import { emptyUsageTotal, type CostSummary, type CostUsageTotal } from "../src/orchestrator/cost";
import { mountCostFooter } from "../src/tui/cost-footer";

function usage(overrides: Partial<CostUsageTotal> = {}): CostUsageTotal {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    knownCostCount: 0,
    unknownCostCount: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<CostSummary> = {}): CostSummary {
  return {
    prior: emptyUsageTotal(),
    settled: emptyUsageTotal(),
    current: emptyUsageTotal(),
    total: emptyUsageTotal(),
    priorRunCount: 0,
    settledRunCount: 0,
    inFlightRunCount: 0,
    ...overrides,
  };
}

const theme = {
  fg: (_name: string, value: string) => value,
};

describe("mountCostFooter", () => {
  it("no-ops when setFooter is unavailable", () => {
    const handle = mountCostFooter({} as never, () => summary());
    expect(() => handle.update()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow();
  });

  it("renders pending, exact, prior/current, and partial cost states", () => {
    let current = summary();
    let factory: ((tui: unknown, theme: unknown, footerData: unknown) => { render(width: number): string[]; dispose(): void }) | undefined;
    const setFooter = vi.fn((next) => {
      factory = next;
    });
    const requestRender = vi.fn();
    const handle = mountCostFooter({ setFooter } as never, () => current, { modelId: "opus" });
    const component = factory!({ requestRender }, theme, {
      getGitBranch: () => "feature/test",
      onBranchChange: () => () => undefined,
    });

    expect(component.render(100)[0]).toBe("sf-team cost pending  opus (feature/test)");

    current = summary({
      current: usage({ costTotal: 1.23, knownCostCount: 1 }),
      total: usage({ costTotal: 1.23, knownCostCount: 1 }),
    });
    handle.update();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(component.render(100)[0]).toBe("sf-team cost $1.23  opus (feature/test)");

    current = summary({
      prior: usage({ costTotal: 4.56, knownCostCount: 1 }),
      current: usage({ costTotal: 1.23, knownCostCount: 1 }),
      total: usage({ costTotal: 5.79, knownCostCount: 2 }),
      priorRunCount: 1,
    });
    expect(component.render(100)[0]).toBe("sf-team cost $5.79 (prior $4.56 + current $1.23)  opus (feature/test)");

    current = summary({
      current: usage({ costTotal: 5.79, knownCostCount: 1, unknownCostCount: 1 }),
      total: usage({ costTotal: 5.79, knownCostCount: 1, unknownCostCount: 1 }),
    });
    expect(component.render(100)[0]).toBe("sf-team cost >=$5.79 (partial)  opus (feature/test)");
  });

  it("clears the footer on dispose", () => {
    const setFooter = vi.fn();
    const handle = mountCostFooter({ setFooter } as never, () => summary());

    handle.dispose();

    expect(setFooter).toHaveBeenLastCalledWith(undefined);
  });
});
