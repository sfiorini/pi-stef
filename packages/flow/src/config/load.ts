import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { Value } from "@sinclair/typebox/value";
import { globalConfig, projectConfig } from "@pi-stef/paths";
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  type FlowConfig,
  type LoadedFlowConfig,
  type ResolvedFlowConfig,
  type ResolvedModels,
} from "./schema.js";

export class ConfigValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly pointer: string,
    message: string,
  ) {
    super(`Config validation error in ${filePath} at ${pointer}: ${message}`);
    this.name = "ConfigValidationError";
  }
}

async function loadFile(filePath: string): Promise<FlowConfig> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  // Pre-validation migration: rename a legacy "explorer" group to "researcher".
  // JSON.parse returns `any`, so this compiles; the typeof guard defends against
  // a non-object config (null/array/primitive) by skipping to Value.Errors.
  if (typeof parsed === "object" && parsed !== null && parsed.explorer) {
    if (!parsed.researcher) parsed.researcher = parsed.explorer;
    delete parsed.explorer;
  }
  const errors = [...Value.Errors(ConfigSchema, parsed)];
  if (errors.length > 0) {
    const first = errors[0];
    throw new ConfigValidationError(filePath, first.path, first.message);
  }
  return parsed as FlowConfig;
}

async function loadFileOrNull(filePath: string): Promise<FlowConfig | null> {
  try {
    return await loadFile(filePath);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Deep-merge a loaded (possibly partial) file over the fully-populated base.
 * `base` groups are always present; `over` groups may be absent, so each group
 * is merged field-by-field and the result keeps the required LoadedFlowConfig shape.
 */
function merge(base: LoadedFlowConfig, over: FlowConfig | null): LoadedFlowConfig {
  if (!over) return base;
  return {
    reviewer: { ...base.reviewer, ...over.reviewer },
    researcher: { ...base.researcher, ...over.researcher },
    developer: { ...base.developer, ...over.developer },
    planner: { ...base.planner, ...over.planner },
    auditor: { ...base.auditor, ...over.auditor },
    synth: { ...base.synth, ...over.synth },
    designer: { ...base.designer, ...over.designer },
    audit: { ...base.audit, ...over.audit },
    worktree: { ...base.worktree, ...over.worktree },
  };
}

export async function loadConfig(
  repoRoot: string,
  opts: { homeDir?: string } = {},
): Promise<LoadedFlowConfig> {
  const homeDir = opts.homeDir ?? homedir();
  const globalPath = globalConfig("flow", homeDir);
  const projectPath = projectConfig("flow", repoRoot);
  let cfg: LoadedFlowConfig = DEFAULT_CONFIG;
  cfg = merge(cfg, await loadFileOrNull(globalPath));
  cfg = merge(cfg, await loadFileOrNull(projectPath));
  return cfg;
}

/** The seven flow agent roles that carry a configurable model. */
export type AgentRole = "reviewer" | "researcher" | "developer" | "planner" | "auditor" | "synth" | "designer";

/** Per-agent model overrides (e.g. from a tool param or prompt extraction). */
export type ModelOverrides = Partial<Record<AgentRole, string | undefined>>;

const AGENT_ROLES: readonly AgentRole[] = ["reviewer", "researcher", "developer", "planner", "auditor", "synth", "designer"];

function cfgModel(cfg: FlowConfig, role: AgentRole): string | undefined {
  switch (role) {
    case "reviewer":
      return cfg.reviewer?.model;
    case "researcher":
      return cfg.researcher?.model;
    case "developer":
      return cfg.developer?.model;
    case "planner":
      return cfg.planner?.model;
    case "auditor":
      return cfg.auditor?.model;
    case "synth":
      return cfg.synth?.model;
    case "designer":
      return cfg.designer?.model;
  }
}

/**
 * Resolve all seven agent models from the deterministic front-end chain:
 * 1. Override (tool param / prompt extraction) — if truthy
 * 2. Config group `.model` (project beats global via the loadConfig merge)
 * 3. Environment variable `SF_FLOW_<ROLE>_MODEL`
 * 4. null ⇒ caller inherits the orchestrator model (uniform fallback, no fail-fast)
 *
 * Pure + synchronous (no I/O): takes a loaded config. The `.md` frontmatter →
 * orchestrator-inherit step is pi-subagents' concern at dispatch, NOT resolved here.
 */
export function resolveFlowModels(cfg: FlowConfig, overrides: ModelOverrides = {}): ResolvedModels {
  const out = {} as ResolvedModels;
  for (const role of AGENT_ROLES) {
    const key = `${role}Model` as keyof ResolvedModels;
    const ov = overrides[role];
    if (ov) {
      out[key] = ov;
      continue;
    }
    const cfgM = cfgModel(cfg, role);
    if (cfgM) {
      out[key] = cfgM;
      continue;
    }
    const envName = `SF_FLOW_${role.toUpperCase()}_MODEL`;
    out[key] = process.env[envName] ?? null;
  }
  return out;
}

export async function loadAndResolveDefaults(
  repoRoot: string,
  opts: { homeDir?: string; notify?: (msg: string, level: string) => void; overrides?: ModelOverrides } = {},
): Promise<ResolvedFlowConfig> {
  try {
    const cfg = await loadConfig(repoRoot, { homeDir: opts.homeDir });
    return { ...cfg, ...resolveFlowModels(cfg, opts.overrides) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.notify?.(`sf-flow config: ${detail} — falling back to built-in defaults.`, "warning");
    return { ...DEFAULT_CONFIG, ...resolveFlowModels(DEFAULT_CONFIG, opts.overrides) };
  }
}
