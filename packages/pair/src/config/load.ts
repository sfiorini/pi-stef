import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { Value } from "@sinclair/typebox/value";
import { globalConfig, projectConfig } from "@pi-stef/paths";
import {
  ConfigSchema,
  DEFAULT_CONFIG,
  type PairConfig,
  type ResolvedPairConfig,
} from "./schema";

export class ConfigValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly pointer: string,
    message: string
  ) {
    super(`Config validation error in ${filePath} at ${pointer}: ${message}`);
    this.name = "ConfigValidationError";
  }
}

async function loadFile(filePath: string): Promise<PairConfig> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const errors = [...Value.Errors(ConfigSchema, parsed)];
  if (errors.length > 0) {
    const first = errors[0];
    throw new ConfigValidationError(
      filePath,
      first.path,
      first.message
    );
  }
  return parsed as PairConfig;
}

/** Load file, returning null if not found (ENOENT), throwing on parse/validation errors. */
async function loadFileOrNull(filePath: string): Promise<PairConfig | null> {
  try {
    return await loadFile(filePath);
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

export async function loadConfig(
  repoRoot: string,
  opts: { homeDir?: string } = {}
): Promise<PairConfig> {
  const homeDir = opts.homeDir ?? homedir();
  const globalPath = globalConfig("pair", homeDir);
  const projectPath = projectConfig("pair", repoRoot);

  const global = (await loadFileOrNull(globalPath)) ?? {};
  const project = (await loadFileOrNull(projectPath)) ?? {};

  // Deep merge: project wins on conflicts, but nested objects are merged field-by-field
  return {
    reviewer: {
      ...(global.reviewer ?? {}),
      ...(project.reviewer ?? {}),
    },
    explorer: {
      ...(global.explorer ?? {}),
      ...(project.explorer ?? {}),
    },
  };
}

export function resolveDefaults(loaded: PairConfig = {}): ResolvedPairConfig {
  return {
    reviewer: {
      model: loaded.reviewer?.model ?? DEFAULT_CONFIG.reviewer.model,
    },
    explorer: {
      model: loaded.explorer?.model ?? DEFAULT_CONFIG.explorer.model,
    },
  };
}

export async function loadAndResolveDefaults(
  repoRoot: string,
  opts: { homeDir?: string; notify?: (msg: string, level: string) => void } = {}
): Promise<ResolvedPairConfig> {
  try {
    const loaded = await loadConfig(repoRoot, { homeDir: opts.homeDir });
    return resolveDefaults(loaded);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    opts.notify?.(
      `sf-pair config: ${detail} — falling back to built-in defaults.`,
      "warning"
    );
    return resolveDefaults({});
  }
}

/**
 * Resolve reviewer model from the 4-step chain:
 * 1. Prompt argument (parsed by caller)
 * 2. Project/global config
 * 3. Environment variable SF_PAIR_REVIEWER_MODEL
 * 4. Ask user (returns null, caller must prompt)
 */
export function resolveReviewerModel(
  promptArg: string | undefined,
  config: ResolvedPairConfig
): string | null {
  // 1. Prompt argument
  if (promptArg) return promptArg;

  // 2. Config file
  if (config.reviewer.model) return config.reviewer.model;

  // 3. Environment variable
  const envModel = process.env.SF_PAIR_REVIEWER_MODEL;
  if (envModel) return envModel;

  // 4. Not found — caller must ask user
  return null;
}

/**
 * Resolve explorer model from the 3-step chain:
 * 1. Prompt argument (parsed by caller)
 * 2. Project/global config
 * 3. Environment variable SF_PAIR_EXPLORER_MODEL
 * 4. Returns null to inherit parent model (no need to ask user)
 */
export function resolveExplorerModel(
  promptArg: string | undefined,
  config: ResolvedPairConfig
): string | null {
  // 1. Prompt argument
  if (promptArg) return promptArg;

  // 2. Config file
  if (config.explorer.model) return config.explorer.model;

  // 3. Environment variable
  const envModel = process.env.SF_PAIR_EXPLORER_MODEL;
  if (envModel) return envModel;

  // 4. Not found — inherit parent model
  return null;
}
