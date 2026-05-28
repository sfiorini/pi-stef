import { describe, expect, it } from "vitest";

import { resolveDefaults } from "../src/config/load";
import { DEFAULT_CONFIG } from "../src/config/schema";
import {
  resolveToolVerificationConfig,
  verificationDefaultsForAutoImplement,
  verificationDefaultsForPlanPhase,
} from "../src/tools/verification-stage";

describe("sf-team verification policy resolution", () => {
  it("adds an explicit plan section and nested per-tool verification defaults", () => {
    const defaults = resolveDefaults({});
    expect(defaults.plan.verification?.timing).toBe("off");
    expect(defaults.implement.verification?.timing).toBe("after");
    expect(defaults.task.verification?.stages).toEqual(["typecheck", "test"]);
    expect(defaults.followup.verification?.mode).toBe("commands");
    expect(defaults.auto.verification?.timing).toBe("after");
  });

  it("merges sparse config and lets explicit tool inputs override config", () => {
    const defaults = resolveDefaults({
      task: { verification: { timing: "both", stages: "lint" } },
    } as never);
    const fromConfig = resolveToolVerificationConfig("sf_team_task", defaults.task.verification);
    expect(fromConfig.timing).toBe("both");
    expect(fromConfig.stages).toEqual(["lint"]);

    const fromInput = resolveToolVerificationConfig("sf_team_task", defaults.task.verification, {
      timing: "off",
    });
    expect(fromInput.timing).toBe("off");
  });

  it("auto verification overrides nested implement verification and suppresses plan verification during auto plan phase", () => {
    const defaults = resolveDefaults({
      plan: { verification: { timing: "after", stages: "test" } },
      implement: { verification: { timing: "after", stages: "lint" } },
      auto: { verification: { timing: "both", stages: "typecheck" } },
    } as never);

    expect(verificationDefaultsForPlanPhase(defaults, { invokedByAuto: false }).plan.verification?.timing).toBe("after");
    expect(verificationDefaultsForPlanPhase(defaults, { invokedByAuto: true }).plan.verification?.timing).toBe("off");

    const autoImplementDefaults = verificationDefaultsForAutoImplement(defaults, undefined);
    expect(autoImplementDefaults.implement.verification).toEqual(defaults.auto.verification);

    const inputOverride = verificationDefaultsForAutoImplement(defaults, { timing: "off" });
    expect(inputOverride.implement.verification?.timing).toBe("off");
    expect(DEFAULT_CONFIG.implement.verification?.timing).toBe("after");
  });
});
