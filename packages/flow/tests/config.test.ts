import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveReviewerModel } from "../src/config/load.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";

describe("flow config", () => {
  it("returns DEFAULT_CONFIG when no files exist", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-home-"));
    const root = mkdtempSync(join(tmpdir(), "flow-root-"));
    const cfg = await loadConfig(root, { homeDir: home });
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("layered merge: project overrides global", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-home-"));
    const root = mkdtempSync(join(tmpdir(), "flow-root-"));
    mkdirSync(join(home, ".pi", "sf", "flow"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "sf", "flow", "config.json"),
      JSON.stringify({
        audit: { threshold: 0.9, max_rounds: 5 },
        tmux: { enabled: true, theme: "codex" },
        worktree: { branch_prefix: "flow/" },
        reviewer: {},
        explorer: {},
      }),
    );
    mkdirSync(join(root, ".pi", "sf", "flow"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "sf", "flow", "config.json"),
      JSON.stringify({
        audit: { threshold: 0.97, max_rounds: 5 },
        tmux: { enabled: true, theme: "codex" },
        worktree: { branch_prefix: "flow/" },
        reviewer: {},
        explorer: {},
      }),
    );
    const cfg = await loadConfig(root, { homeDir: home });
    expect(cfg.audit.threshold).toBe(0.97);
  });

  it("accepts a minimal partial config (only reviewer) and fills defaults", async () => {
    const home = mkdtempSync(join(tmpdir(), "flow-home-"));
    const root = mkdtempSync(join(tmpdir(), "flow-root-"));
    mkdirSync(join(root, ".pi", "sf", "flow"), { recursive: true });
    writeFileSync(
      join(root, ".pi", "sf", "flow", "config.json"),
      JSON.stringify({ reviewer: { model: "anthropic/opus" } }),
    );
    const cfg = await loadConfig(root, { homeDir: home });
    expect(cfg.reviewer.model).toBe("anthropic/opus");
    // defaults filled for the absent groups
    expect(cfg.audit).toEqual({ threshold: 0.94, max_rounds: 5 });
    expect(cfg.tmux).toEqual({ enabled: true, theme: "codex" });
    expect(cfg.worktree).toEqual({ branch_prefix: "flow/" });
  });
});

describe("resolveReviewerModel", () => {
  const origEnv = process.env.SF_FLOW_REVIEWER_MODEL;
  beforeEach(() => {
    delete process.env.SF_FLOW_REVIEWER_MODEL;
  });
  afterEach(() => {
    if (origEnv) process.env.SF_FLOW_REVIEWER_MODEL = origEnv;
    else delete process.env.SF_FLOW_REVIEWER_MODEL;
  });

  it("override wins", () => {
    expect(resolveReviewerModel("anthropic/opus", DEFAULT_CONFIG)).toBe("anthropic/opus");
  });
  it("config wins when no override", () => {
    expect(
      resolveReviewerModel(undefined, { ...DEFAULT_CONFIG, reviewer: { model: "anthropic/sonnet" } }),
    ).toBe("anthropic/sonnet");
  });
  it("env wins when no override/config", () => {
    process.env.SF_FLOW_REVIEWER_MODEL = "anthropic/haiku";
    expect(resolveReviewerModel(undefined, DEFAULT_CONFIG)).toBe("anthropic/haiku");
  });
  it("null when nothing set", () => {
    expect(resolveReviewerModel(undefined, DEFAULT_CONFIG)).toBeNull();
  });
});
