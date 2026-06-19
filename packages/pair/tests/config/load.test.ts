import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveDefaults,
  resolveReviewerModel,
  resolveExplorerModel,
  ConfigValidationError,
} from "../../src/config/load";
import type { ResolvedPairConfig } from "../../src/config/schema";

describe("resolveDefaults", () => {
  it("returns default config when called with no args", () => {
    const result = resolveDefaults();
    expect(result.reviewer.model).toBeNull();
    expect(result.explorer.model).toBeNull();
  });

  it("uses loaded model when provided", () => {
    const loaded = {
      reviewer: { model: "anthropic/sonnet-4-6" },
      explorer: { model: "anthropic/haiku-4-5" },
    };
    const result = resolveDefaults(loaded);
    expect(result.reviewer.model).toBe("anthropic/sonnet-4-6");
    expect(result.explorer.model).toBe("anthropic/haiku-4-5");
  });

  it("defaults to null when reviewer has no model", () => {
    const loaded = { reviewer: {} };
    const result = resolveDefaults(loaded);
    expect(result.reviewer.model).toBeNull();
    expect(result.explorer.model).toBeNull();
  });

  it("defaults to null when explorer has no model", () => {
    const loaded = { explorer: {} };
    const result = resolveDefaults(loaded);
    expect(result.reviewer.model).toBeNull();
    expect(result.explorer.model).toBeNull();
  });
});

describe("resolveReviewerModel", () => {
  const configWithModel: ResolvedPairConfig = {
    reviewer: { model: "config-model" },
    explorer: { model: null },
  };
  const configWithoutModel: ResolvedPairConfig = {
    reviewer: { model: null },
    explorer: { model: null },
  };

  const originalEnv = process.env.SF_PAIR_REVIEWER_MODEL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SF_PAIR_REVIEWER_MODEL;
    } else {
      process.env.SF_PAIR_REVIEWER_MODEL = originalEnv;
    }
  });

  it("step 1: prompt arg wins over everything", () => {
    process.env.SF_PAIR_REVIEWER_MODEL = "env-model";
    const result = resolveReviewerModel("prompt-model", configWithModel);
    expect(result).toBe("prompt-model");
  });

  it("step 2: config model used when no prompt arg", () => {
    process.env.SF_PAIR_REVIEWER_MODEL = "env-model";
    const result = resolveReviewerModel(undefined, configWithModel);
    expect(result).toBe("config-model");
  });

  it("step 3: env var used when no prompt arg or config", () => {
    process.env.SF_PAIR_REVIEWER_MODEL = "env-model";
    const result = resolveReviewerModel(undefined, configWithoutModel);
    expect(result).toBe("env-model");
  });

  it("step 4: returns null when nothing configured", () => {
    delete process.env.SF_PAIR_REVIEWER_MODEL;
    const result = resolveReviewerModel(undefined, configWithoutModel);
    expect(result).toBeNull();
  });
});

describe("resolveExplorerModel", () => {
  const configWithModel: ResolvedPairConfig = {
    reviewer: { model: null },
    explorer: { model: "config-explorer-model" },
  };
  const configWithoutModel: ResolvedPairConfig = {
    reviewer: { model: null },
    explorer: { model: null },
  };

  const originalEnv = process.env.SF_PAIR_EXPLORER_MODEL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SF_PAIR_EXPLORER_MODEL;
    } else {
      process.env.SF_PAIR_EXPLORER_MODEL = originalEnv;
    }
  });

  it("step 1: prompt arg wins over everything", () => {
    process.env.SF_PAIR_EXPLORER_MODEL = "env-model";
    const result = resolveExplorerModel("prompt-model", configWithModel);
    expect(result).toBe("prompt-model");
  });

  it("step 2: config model used when no prompt arg", () => {
    process.env.SF_PAIR_EXPLORER_MODEL = "env-model";
    const result = resolveExplorerModel(undefined, configWithModel);
    expect(result).toBe("config-explorer-model");
  });

  it("step 3: env var used when no prompt arg or config", () => {
    process.env.SF_PAIR_EXPLORER_MODEL = "env-model";
    const result = resolveExplorerModel(undefined, configWithoutModel);
    expect(result).toBe("env-model");
  });

  it("step 4: returns null when nothing configured (inherit parent)", () => {
    delete process.env.SF_PAIR_EXPLORER_MODEL;
    const result = resolveExplorerModel(undefined, configWithoutModel);
    expect(result).toBeNull();
  });
});

describe("ConfigValidationError", () => {
  it("includes file path and pointer in message", () => {
    const err = new ConfigValidationError(
      "/path/to/config.json",
      "/reviewer/model",
      "must be string"
    );
    expect(err.name).toBe("ConfigValidationError");
    expect(err.message).toContain("/path/to/config.json");
    expect(err.message).toContain("/reviewer/model");
    expect(err.message).toContain("must be string");
  });
});
