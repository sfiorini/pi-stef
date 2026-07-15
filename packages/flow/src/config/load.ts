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
    explorer: { ...base.explorer, ...over.explorer },
    audit: { ...base.audit, ...over.audit },
    tmux: { ...base.tmux, ...over.tmux },
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

/**
 * Resolve reviewer model from the 4-step chain:
 * 1. Prompt/arg override
 * 2. Project/global config
 * 3. Environment variable SF_FLOW_REVIEWER_MODEL
 * 4. null (caller must ask)
 */
export function resolveReviewerModel(override: string | undefined, cfg: FlowConfig): string | null {
  if (override) return override;
  if (cfg.reviewer?.model) return cfg.reviewer.model;
  if (process.env.SF_FLOW_REVIEWER_MODEL) return process.env.SF_FLOW_REVIEWER_MODEL;
  return null;
}

/**
 * Resolve explorer model from the 4-step chain (returns null to inherit parent).
 */
export function resolveExplorerModel(override: string | undefined, cfg: FlowConfig): string | null {
  if (override) return override;
  if (cfg.explorer?.model) return cfg.explorer.model;
  if (process.env.SF_FLOW_EXPLORER_MODEL) return process.env.SF_FLOW_EXPLORER_MODEL;
  return null;
}

export async function loadAndResolveDefaults(
  repoRoot: string,
  opts: { homeDir?: string; notify?: (msg: string, level: string) => void } = {},
): Promise<ResolvedFlowConfig> {
  try {
    const cfg = await loadConfig(repoRoot, { homeDir: opts.homeDir });
    return {
      ...cfg,
      reviewerModel: resolveReviewerModel(undefined, cfg),
      explorerModel: resolveExplorerModel(undefined, cfg),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.notify?.(`sf-flow config: ${detail} — falling back to built-in defaults.`, "warning");
    return {
      ...DEFAULT_CONFIG,
      reviewerModel: resolveReviewerModel(undefined, DEFAULT_CONFIG),
      explorerModel: resolveExplorerModel(undefined, DEFAULT_CONFIG),
    };
  }
}
