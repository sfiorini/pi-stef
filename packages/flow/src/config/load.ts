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

/**
 * Model groups removed from the config schema. A config file carrying any of
 * these keys is stripped of them (never a hard failure) and the caller warns
 * once — models now live in each agent's `.md` frontmatter.
 */
const LEGACY_MODEL_GROUPS = [
  "reviewer",
  "researcher",
  "developer",
  "planner",
  "auditor",
  "synth",
  "designer",
  "elicitor",
  "notifier",
  "scanner",
  "explorer",
] as const;

export interface LoadedFileConfig extends FlowConfig {
  /** Legacy model-group keys found in this file (stripped, with a warning). */
  legacyModelKeys: string[];
}

/**
 * Read + validate one config file. Legacy model-group keys (reviewer…scanner,
 * plus the pre-0.4 `explorer`) are stripped BEFORE validation so a config
 * carrying them keeps loading — they surface as `legacyModelKeys` so the
 * caller can warn exactly once about what was ignored.
 */
async function loadFile(filePath: string): Promise<LoadedFileConfig> {
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  const legacyModelKeys: string[] = [];
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const key of LEGACY_MODEL_GROUPS) {
      if (key in obj) {
        delete obj[key];
        legacyModelKeys.push(key);
      }
    }
  }
  const errors = [...Value.Errors(ConfigSchema, parsed)];
  if (errors.length > 0) {
    const first = errors[0];
    throw new ConfigValidationError(filePath, first.path, first.message);
  }
  return { ...(parsed as FlowConfig), legacyModelKeys };
}

async function loadFileOrNull(filePath: string): Promise<LoadedFileConfig | null> {
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
    audit: { ...base.audit, ...over.audit },
    worktree: { ...base.worktree, ...over.worktree },
    freshReviewResetThreshold: over.freshReviewResetThreshold ?? base.freshReviewResetThreshold,
  };
}

export interface LoadConfigResult extends LoadedFlowConfig {
  /** Legacy model-group keys stripped from each file, by basename, for the caller's one-time warning. */
  legacyModelKeysByFile: Record<string, string[]>;
}

/**
 * Load the layered flow settings (project beats global). Legacy model-group
 * keys are stripped per file and reported in `legacyModelKeysByFile` so the
 * caller can surface exactly one warning per file.
 */
export async function loadConfig(
  repoRoot: string,
  opts: { homeDir?: string } = {},
): Promise<LoadConfigResult> {
  const homeDir = opts.homeDir ?? homedir();
  const globalPath = globalConfig("flow", homeDir);
  const projectPath = projectConfig("flow", repoRoot);
  const legacyModelKeysByFile: Record<string, string[]> = {};
  // Fresh copy of the defaults — never share nested refs with DEFAULT_CONFIG.
  let cfg: LoadedFlowConfig = {
    audit: { ...DEFAULT_CONFIG.audit },
    worktree: { ...DEFAULT_CONFIG.worktree },
    freshReviewResetThreshold: DEFAULT_CONFIG.freshReviewResetThreshold,
  };
  const sources: Array<{ path: string; label: string }> = [
    { path: globalPath, label: "global config.json" },
    { path: projectPath, label: "project config.json" },
  ];
  for (const { path, label } of sources) {
    const loaded = await loadFileOrNull(path);
    if (!loaded) continue;
    if (loaded.legacyModelKeys.length) legacyModelKeysByFile[label] = loaded.legacyModelKeys;
    cfg = merge(cfg, loaded);
  }
  return { ...cfg, legacyModelKeysByFile };
}

/** The `SF_FLOW_<ROLE>_MODEL` env vars currently set (removed channel → warn once). Sorted. */
export function hasLegacyModelEnvVars(): string[] {
  return Object.keys(process.env)
    .filter((k) => k.startsWith("SF_FLOW_") && k.endsWith("_MODEL"))
    .sort();
}

/**
 * Tolerant loader: any config error degrades to built-in defaults (with a
 * warning via `notify`) instead of failing the tool call. Also surfaces the
 * one-time warnings for removed model channels (legacy config groups,
 * SF_FLOW_*_MODEL env vars).
 */
export async function loadFlowSettingsOrDefaults(
  repoRoot: string,
  opts: { homeDir?: string; notify?: (msg: string, level: string) => void } = {},
): Promise<ResolvedFlowConfig> {
  try {
    const { legacyModelKeysByFile, ...settings } = await loadConfig(repoRoot, { homeDir: opts.homeDir });
    for (const [file, keys] of Object.entries(legacyModelKeysByFile)) {
      opts.notify?.(
        `${file}: model groups (${keys.join(", ")}) are no longer read — each agent's model lives in its .md file. Remove the keys to silence this warning.`,
        "warning",
      );
    }
    const legacyEnv = hasLegacyModelEnvVars();
    if (legacyEnv.length) {
      opts.notify?.(
        `SF_FLOW_*_MODEL env vars (${legacyEnv.join(", ")}) are no longer read — set the model in the agent's .md file instead.`,
        "warning",
      );
    }
    return settings;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.notify?.(`sf-flow config: ${detail} — falling back to built-in defaults.`, "warning");
    // Fresh copy — never hand out the shared DEFAULT_CONFIG reference.
    return { ...DEFAULT_CONFIG, audit: { ...DEFAULT_CONFIG.audit }, worktree: { ...DEFAULT_CONFIG.worktree } };
  }
}
