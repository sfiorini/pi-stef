import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, loadFlowSettingsOrDefaults, hasLegacyModelEnvVars } from "../src/config/load.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";

function tempDirs() {
  const home = mkdtempSync(join(tmpdir(), "flow-home-"));
  const root = mkdtempSync(join(tmpdir(), "flow-root-"));
  return { home, root };
}

function writeProjectConfig(root: string, cfg: unknown) {
  mkdirSync(join(root, ".pi", "sf", "flow"), { recursive: true });
  writeFileSync(join(root, ".pi", "sf", "flow", "config.json"), JSON.stringify(cfg));
}

describe("flow config", () => {
  it("returns DEFAULT_CONFIG when no files exist", async () => {
    const { home, root } = tempDirs();
    const { legacyModelKeysByFile, ...cfg } = await loadConfig(root, { homeDir: home });
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(legacyModelKeysByFile).toEqual({});
  });

  it("freshReviewResetThreshold defaults to 0.5 (D18)", async () => {
    const { home, root } = tempDirs();
    const cfg = await loadConfig(root, { homeDir: home });
    expect(cfg.freshReviewResetThreshold).toBe(0.5);
  });

  it("freshReviewResetThreshold honors a project override (D18)", async () => {
    const { home, root } = tempDirs();
    writeProjectConfig(root, { freshReviewResetThreshold: 0.8 });
    const cfg = await loadConfig(root, { homeDir: home });
    expect(cfg.freshReviewResetThreshold).toBe(0.8);
  });

  it("layered merge: project overrides global", async () => {
    const { home, root } = tempDirs();
    mkdirSync(join(home, ".pi", "sf", "flow"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "sf", "flow", "config.json"),
      JSON.stringify({ audit: { threshold: 0.9, max_rounds: 5 }, worktree: { branch_prefix: "flow/" } }),
    );
    writeProjectConfig(root, { audit: { threshold: 0.97, max_rounds: 5 } });
    const cfg = await loadConfig(root, { homeDir: home });
    expect(cfg.audit.threshold).toBe(0.97);
    expect(cfg.worktree.branch_prefix).toBe("flow/"); // from global
  });

  it("accepts a minimal partial config (only audit) and fills defaults", async () => {
    const { home, root } = tempDirs();
    writeProjectConfig(root, { audit: { threshold: 0.9 } });
    const cfg = await loadConfig(root, { homeDir: home });
    expect(cfg.audit).toEqual({ threshold: 0.9, max_rounds: 5 }); // max_rounds default fills in
    expect(cfg.worktree).toEqual({ branch_prefix: "flow/" });
  });

  it("strips legacy model-group keys and reports them (models now live in .md files)", async () => {
    const { home, root } = tempDirs();
    writeProjectConfig(root, {
      reviewer: { model: "anthropic/opus" },
      scanner: { model: "haiku" },
      audit: { threshold: 0.95 },
    });
    const cfg = await loadConfig(root, { homeDir: home });
    // audit SURVIVES alongside stripped legacy keys
    expect(cfg.audit.threshold).toBe(0.95);
    expect(cfg.legacyModelKeysByFile["project config.json"]).toEqual(["reviewer", "scanner"]);
  });

  it("strips the pre-0.4 'explorer' legacy key too", async () => {
    const { home, root } = tempDirs();
    writeProjectConfig(root, { explorer: { model: "x/y" }, worktree: { branch_prefix: "ft/" } });
    const cfg = await loadConfig(root, { homeDir: home });
    expect(cfg.worktree.branch_prefix).toBe("ft/");
    expect(cfg.legacyModelKeysByFile["project config.json"]).toEqual(["explorer"]);
  });

  it("still rejects unknown top-level keys (additionalProperties: false)", async () => {
    const { home, root } = tempDirs();
    writeProjectConfig(root, { bogus: { model: "x" } });
    await expect(loadConfig(root, { homeDir: home })).rejects.toThrow(/bogus/);
  });

  it("still rejects bogus properties inside the audit group", async () => {
    const { home, root } = tempDirs();
    writeProjectConfig(root, { audit: { threshold: 0.9, bogus: 1 } });
    await expect(loadConfig(root, { homeDir: home })).rejects.toThrow(/audit/);
  });
});

describe("loadFlowSettingsOrDefaults (tolerant loader + warnings)", () => {
  it("warns once per file carrying legacy model groups", async () => {
    const { home, root } = tempDirs();
    writeProjectConfig(root, { reviewer: { model: "a/b" }, audit: { threshold: 0.96 } });
    const warnings: string[] = [];
    const cfg = await loadFlowSettingsOrDefaults(root, {
      homeDir: home,
      notify: (msg) => warnings.push(msg),
    });
    expect(cfg.audit.threshold).toBe(0.96);
    expect(warnings.some((w) => w.includes("project config.json") && w.includes("reviewer"))).toBe(true);
  });

  it("falls back to defaults on a config error, with a warning", async () => {
    const { home, root } = tempDirs();
    writeProjectConfig(root, { not_a_real_key: true });
    const warnings: string[] = [];
    const cfg = await loadFlowSettingsOrDefaults(root, {
      homeDir: home,
      notify: (msg) => warnings.push(msg),
    });
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(warnings.some((w) => w.includes("falling back to built-in defaults"))).toBe(true);
  });
});

describe("hasLegacyModelEnvVars (removed channel warning)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("SF_FLOW_") && k.endsWith("_MODEL")) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
  });

  it("returns [] when no SF_FLOW_*_MODEL vars are set", () => {
    expect(hasLegacyModelEnvVars()).toEqual([]);
  });

  it("lists the legacy vars (sorted) when set", () => {
    process.env.SF_FLOW_REVIEWER_MODEL = "a/b";
    process.env.SF_FLOW_AUDITOR_MODEL = "c/d";
    expect(hasLegacyModelEnvVars()).toEqual(["SF_FLOW_AUDITOR_MODEL", "SF_FLOW_REVIEWER_MODEL"]);
  });
});
