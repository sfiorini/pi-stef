import { describe, expect, it } from "vitest";

import {
  defaultVerificationConfigForTool,
  isVerificationEnabledForPhase,
  resolveVerificationConfig,
} from "../src/verification/config";

describe("verification config resolution", () => {
  it("preserves sf-team defaults: plan is off, implementation-style tools verify after with commands", () => {
    expect(defaultVerificationConfigForTool("sf_team_plan")).toMatchObject({
      timing: "off",
      mode: "commands",
      stages: ["typecheck", "test"],
      cache: { mode: "run" },
    });

    for (const toolName of ["sf_team_implement", "sf_team_task", "sf_team_followup", "sf_team_auto"]) {
      expect(defaultVerificationConfigForTool(toolName)).toMatchObject({
        timing: "after",
        mode: "commands",
        stages: ["typecheck", "test"],
        cache: { mode: "run" },
      });
    }
  });

  it("supports timing off/before/after/both and phase checks", () => {
    const both = resolveVerificationConfig("sf_team_implement", { timing: "both" });
    expect(isVerificationEnabledForPhase(both, "before")).toBe(true);
    expect(isVerificationEnabledForPhase(both, "after")).toBe(true);

    const before = resolveVerificationConfig("sf_team_task", { timing: "before" });
    expect(isVerificationEnabledForPhase(before, "before")).toBe(true);
    expect(isVerificationEnabledForPhase(before, "after")).toBe(false);

    const off = resolveVerificationConfig("sf_team_task", { timing: "off" });
    expect(isVerificationEnabledForPhase(off, "before")).toBe(false);
    expect(isVerificationEnabledForPhase(off, "after")).toBe(false);
  });

  it("normalizes all/single/array stage shorthand plus custom commands", () => {
    const all = resolveVerificationConfig("sf_team_implement", { stages: "all" });
    expect(all.stages).toEqual(["typecheck", "test", "lint"]);

    const single = resolveVerificationConfig("sf_team_implement", { stages: "lint" });
    expect(single.stages).toEqual(["lint"]);

    const mixed = resolveVerificationConfig("sf_team_implement", {
      stages: [
        "typecheck",
        { label: "unit", cmd: "pnpm", args: ["vitest", "run"] },
      ],
      commands: { label: "docs", cmd: "pnpm", args: ["docs:check"] },
    });
    expect(mixed.stages).toEqual([
      "typecheck",
      { label: "unit", cmd: "pnpm", args: ["vitest", "run"] },
    ]);
    expect(mixed.commands).toEqual([{ label: "docs", cmd: "pnpm", args: ["docs:check"] }]);
  });

  it("keeps persistent cache opt-in explicit and run cache as the safe default", () => {
    expect(resolveVerificationConfig("sf_team_task", {}).cache).toEqual({ mode: "run" });
    expect(resolveVerificationConfig("sf_team_task", { cache: "off" }).cache).toEqual({ mode: "off" });
    expect(resolveVerificationConfig("sf_team_task", { cache: "persistent" }).cache).toEqual({ mode: "persistent" });
    expect(resolveVerificationConfig("sf_team_task", { cache: { mode: "persistent", path: ".cache/fh.json" } }).cache).toEqual({
      mode: "persistent",
      path: ".cache/fh.json",
    });
  });
});
