import { describe, expect, it } from "vitest";

import {
  defaultVerificationConfigForTool,
  isVerificationEnabledForPhase,
  resolveVerificationConfig,
} from "../src/verification/config";

describe("verification config resolution", () => {
  it("defaults every tool to after timing with commands", () => {
    for (const toolName of ["test_plan", "test_implement", "test_task", "test_followup", "test_auto"]) {
      expect(defaultVerificationConfigForTool(toolName)).toMatchObject({
        timing: "after",
        mode: "commands",
        stages: ["typecheck", "test"],
        cache: { mode: "run" },
      });
    }
  });

  it("supports timing off/before/after/both and phase checks", () => {
    const both = resolveVerificationConfig("test_implement", { timing: "both" });
    expect(isVerificationEnabledForPhase(both, "before")).toBe(true);
    expect(isVerificationEnabledForPhase(both, "after")).toBe(true);

    const before = resolveVerificationConfig("test_task", { timing: "before" });
    expect(isVerificationEnabledForPhase(before, "before")).toBe(true);
    expect(isVerificationEnabledForPhase(before, "after")).toBe(false);

    const off = resolveVerificationConfig("test_task", { timing: "off" });
    expect(isVerificationEnabledForPhase(off, "before")).toBe(false);
    expect(isVerificationEnabledForPhase(off, "after")).toBe(false);
  });

  it("normalizes all/single/array stage shorthand plus custom commands", () => {
    const all = resolveVerificationConfig("test_implement", { stages: "all" });
    expect(all.stages).toEqual(["typecheck", "test", "lint"]);

    const single = resolveVerificationConfig("test_implement", { stages: "lint" });
    expect(single.stages).toEqual(["lint"]);

    const mixed = resolveVerificationConfig("test_implement", {
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
    expect(resolveVerificationConfig("test_task", {}).cache).toEqual({ mode: "run" });
    expect(resolveVerificationConfig("test_task", { cache: "off" }).cache).toEqual({ mode: "off" });
    expect(resolveVerificationConfig("test_task", { cache: "persistent" }).cache).toEqual({ mode: "persistent" });
    expect(resolveVerificationConfig("test_task", { cache: { mode: "persistent", path: ".cache/fh.json" } }).cache).toEqual({
      mode: "persistent",
      path: ".cache/fh.json",
    });
  });
});
