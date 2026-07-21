import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveFlowModels } from "../src/config/load.js";
import { DEFAULT_CONFIG, type FlowConfig } from "../src/config/schema.js";

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
    expect(cfg.worktree).toEqual({ branch_prefix: "flow/" });
  });
});

describe("resolveFlowModels", () => {
  const ROLES = ["reviewer", "explorer", "developer", "planner", "auditor", "synth"] as const;
  const envNames = ROLES.map((r) => `SF_FLOW_${r.toUpperCase()}_MODEL`);
  const origEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of envNames) {
      origEnv[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of envNames) {
      if (origEnv[name]) process.env[name] = origEnv[name];
      else delete process.env[name];
    }
  });

  it("returns all 6 model fields, all null when nothing is set (no throw)", () => {
    expect(resolveFlowModels(DEFAULT_CONFIG)).toEqual({
      reviewerModel: null,
      explorerModel: null,
      developerModel: null,
      plannerModel: null,
      auditorModel: null,
      synthModel: null,
    });
  });

  it("override wins over config + env", () => {
    const cfg = { ...DEFAULT_CONFIG, reviewer: { model: "config/r" } };
    process.env.SF_FLOW_REVIEWER_MODEL = "env/r";
    expect(resolveFlowModels(cfg, { reviewer: "override/r" }).reviewerModel).toBe("override/r");
  });

  it("config group wins when no override", () => {
    process.env.SF_FLOW_DEVELOPER_MODEL = "env/d";
    expect(
      resolveFlowModels({ ...DEFAULT_CONFIG, developer: { model: "config/d" } }).developerModel,
    ).toBe("config/d");
  });

  it("env wins when no override/config", () => {
    process.env.SF_FLOW_PLANNER_MODEL = "env/p";
    expect(resolveFlowModels(DEFAULT_CONFIG).plannerModel).toBe("env/p");
  });

  it("null when nothing set for any role (uniform fallback, no fail-fast)", () => {
    const m = resolveFlowModels(DEFAULT_CONFIG);
    expect(m.reviewerModel).toBeNull();
    expect(m.developerModel).toBeNull();
    expect(m.auditorModel).toBeNull();
    expect(m.synthModel).toBeNull();
  });

  it("resolves every role independently from its config group", () => {
    const cfg: FlowConfig = {
      reviewer: { model: "r" },
      explorer: { model: "e" },
      developer: { model: "d" },
      planner: { model: "p" },
      auditor: { model: "a" },
      synth: { model: "s" },
      audit: { threshold: 0.94, max_rounds: 5 },
      worktree: { branch_prefix: "flow/" },
    };
    expect(resolveFlowModels(cfg)).toEqual({
      reviewerModel: "r",
      explorerModel: "e",
      developerModel: "d",
      plannerModel: "p",
      auditorModel: "a",
      synthModel: "s",
    });
  });

  it("env var names follow SF_FLOW_<ROLE>_MODEL", () => {
    process.env.SF_FLOW_AUDITOR_MODEL = "env/a";
    process.env.SF_FLOW_SYNTH_MODEL = "env/s";
    const m = resolveFlowModels(DEFAULT_CONFIG);
    expect(m.auditorModel).toBe("env/a");
    expect(m.synthModel).toBe("env/s");
  });
});
