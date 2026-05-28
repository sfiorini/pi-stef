import { describe, expect, it, vi } from "vitest";

// IMPORTANT: vi.mock must be hoisted above the import of ../src/register.
// The mock path is resolved RELATIVE to the file being mocked (i.e., the
// path is "../src/tools/plan" because register.ts imports "./tools/plan"
// and we mock it from a sibling test directory; Vitest hoists vi.mock so
// `registerSfTeam` will see the mocked module when imported below).

const handlerSpy = vi.fn(async () => ({
  approved: false,
  rounds: 0,
  folderPath: null,
  performanceReportPath: null,
  costSummary: undefined,
}));

vi.mock("../src/tools/plan", () => ({
  // Match the real shape: createSfTeamPlan() returns a callable handler.
  createSfTeamPlan: () => handlerSpy,
}));

import { registerSfTeam } from "../src/register";

class FakePi {
  tools: Array<{
    name: string;
    description: string;
    parameters: unknown;
    execute: (id: string, params: unknown, signal?: AbortSignal | null, onUpdate?: unknown, ctx?: unknown) => Promise<unknown>;
  }> = [];
  registerTool(tool: any): void {
    this.tools.push(tool);
  }
  registerCommand(_name: string, _options: unknown): void {}
  sendUserMessage(_content: string): void {}
}

describe("registerSfTeam: sf_team_plan default external fetcher wiring", () => {
  it("passes a default externalFetcher (defined, file-defensive to null) into the plan handler", async () => {
    handlerSpy.mockClear();

    const pi = new FakePi();
    registerSfTeam(pi as never);

    const planTool = pi.tools.find((t) => t.name === "sf_team_plan");
    expect(planTool, "sf_team_plan tool must be registered").toBeDefined();

    await planTool!.execute(
      "test-id",
      { title: "demo task" },
      undefined,
      undefined,
      { hasUI: false },
    );

    expect(handlerSpy).toHaveBeenCalledTimes(1);
    const call = handlerSpy.mock.calls[0] as unknown as [Record<string, unknown>, ...unknown[]];
    const input = call[0];
    expect(input.title).toBe("demo task");
    expect(input.externalFetcher, "default fetcher must be wired").toBeTypeOf("function");

    // Proves it's the default fetcher's dispatch (not a placeholder): for
    // kind="file" — which scanRefs no longer emits but the default fetcher
    // defensively handles — it MUST resolve to null. A placeholder fn that
    // simply returned a string would fail this assertion.
    const fetcherFn = input.externalFetcher as (
      ref: { kind: string; raw: string; id: string },
      signal?: AbortSignal,
    ) => Promise<{ content: string; title?: string } | null>;
    const fileHit = await fetcherFn(
      { kind: "file", raw: "x.ts", id: "x.ts" },
      undefined,
    );
    expect(fileHit).toBeNull();
  });
});
