import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Value } from "@sinclair/typebox/value";

import { globalConfig as sfGlobalConfig, projectConfig as sfProjectConfig } from "@pi-stef/paths";

import { ConfigSchema, DEFAULT_CONFIG, type SfTeamConfig, type ResolvedDefaults } from "./schema";

/**
 * Load + deep-merge global and project config.
 *
 * Resolution: project config wins on field-level conflicts. Both files are
 * optional — missing files return an empty object (not an error). Both files
 * are independently TypeBox-validated; on validation failure, throw a
 * {@link ConfigValidationError} carrying the file path and a JSON pointer to
 * the offending field.
 */
export async function loadConfig(repoRoot: string, opts: { homeDir?: string } = {}): Promise<SfTeamConfig> {
  const homeDir = opts.homeDir ?? os.homedir();
  const globalPath = sfGlobalConfig("team", homeDir);
  const projectPath = sfProjectConfig("team", repoRoot);

  const global = await loadFile(globalPath);
  const project = await loadFile(projectPath);

  return deepMerge(global, project);
}

async function loadFile(filePath: string): Promise<SfTeamConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (isNotFound(err)) return {};
    throw new ConfigValidationError(filePath, "/", `failed to read: ${formatError(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigValidationError(filePath, "/", `invalid JSON: ${formatError(err)}`);
  }

  const errors = [...Value.Errors(ConfigSchema, parsed)];
  if (errors.length > 0) {
    const first = errors[0] as { instancePath?: string; path?: string; message: string };
    const pointer = pickPointer(first) ?? "/";
    throw new ConfigValidationError(filePath, pointer, first.message);
  }
  return parsed as SfTeamConfig;
}

function pickPointer(error: { instancePath?: string; path?: string }): string | undefined {
  // TypeBox 1.x exposes `instancePath` (RFC-6901 JSON Pointer) on each error.
  // Older versions used `path`; we fall back to that for resilience.
  if (typeof error.instancePath === "string" && error.instancePath.length > 0) {
    return error.instancePath;
  }
  if (typeof error.path === "string" && error.path.length > 0) {
    return error.path;
  }
  return undefined;
}

export function deepMerge(base: SfTeamConfig, override: SfTeamConfig): SfTeamConfig {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing as SfTeamConfig, value as SfTeamConfig);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as SfTeamConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Friendly TypeBox validation error with file path + JSON pointer to the offending field. */
export class ConfigValidationError extends Error {
  readonly filePath: string;
  readonly jsonPointer: string;

  constructor(filePath: string, jsonPointer: string, detail: string) {
    super(`Config validation failed at ${filePath}${jsonPointer}: ${detail}`);
    this.name = "ConfigValidationError";
    this.filePath = filePath;
    this.jsonPointer = jsonPointer;
  }
}

export const _internal = { sfGlobalConfig, sfProjectConfig };

/**
 * Merge the loaded (sparse) `SfTeamConfig` onto `DEFAULT_CONFIG` to
 * produce a fully-populated `ResolvedDefaults` every consumer can read
 * without dealing with optional fields.
 */
export function resolveDefaults(loaded: SfTeamConfig = {}): ResolvedDefaults {
  const d = DEFAULT_CONFIG;
  const a = loaded.agents ?? {};
  const workflow = { ...d.workflow, ...(loaded.workflow ?? {}) };
  const reviewMaxRounds = loaded.review?.max_rounds
    ?? (workflow.profile === "headless" ? 4 : d.review.max_rounds);
  const planMaxRounds = loaded.review?.plan_max_rounds
    ?? loaded.review?.max_rounds
    ?? (workflow.profile === "headless" ? 3 : d.review.plan_max_rounds);
  const implementationMaxRounds = loaded.review?.implementation_max_rounds
    ?? loaded.review?.max_rounds
    ?? (workflow.profile === "headless" ? 4 : d.review.implementation_max_rounds);
  return {
    agents: {
      planner: { ...d.agents.planner, ...(a.planner ?? {}) },
      reviewer: { ...d.agents.reviewer, ...(a.reviewer ?? {}) },
      developer: { ...d.agents.developer, ...(a.developer ?? {}) },
      researcher: { ...d.agents.researcher, ...(a.researcher ?? {}) },
    },
    review: {
      max_rounds: reviewMaxRounds,
      plan_max_rounds: planMaxRounds,
      implementation_max_rounds: implementationMaxRounds,
    },
    workflow,
    plan: { ...d.plan, ...(loaded.plan ?? {}) },
    // `verification` is deliberately shallow-merged here; the shared
    // verification resolver fills missing nested fields so sparse config such
    // as `{ "cache": "persistent" }` still inherits the command/stage defaults.
    implement: { ...d.implement, ...(loaded.implement ?? {}) },
    auto: { ...d.auto, ...(loaded.auto ?? {}) },
    task: { ...d.task, ...(loaded.task ?? {}) },
    followup: { ...d.followup, ...(loaded.followup ?? {}) },
    notifications: { telegram: { ...d.notifications.telegram, ...(loaded.notifications?.telegram ?? {}) } },
    performance: { ...d.performance, ...(loaded.performance ?? {}) },
    parallel: { ...d.parallel, ...(loaded.parallel ?? {}) },
    steering: { ...d.steering, ...(loaded.steering ?? {}) },
    paths: { ...d.paths, ...(loaded.paths ?? {}) },
    tdd: { ...d.tdd, ...(loaded.tdd ?? {}) },
  };
}

/**
 * Convenience for tool entry points: load + resolve in one call. Errors are
 * reported via `notify` (when supplied) and treated as a soft fallback to
 * `DEFAULT_CONFIG` — a syntactically broken config must not block the run,
 * but the user must SEE that their file was ignored. The notify call itself
 * is wrapped so a buggy UI hook can never reject this Promise either.
 */
export async function loadAndResolveDefaults(
  repoRoot: string,
  opts: { homeDir?: string; notify?: (msg: string, level: "info" | "warning" | "error") => void } = {},
): Promise<ResolvedDefaults> {
  try {
    const loaded = await loadConfig(repoRoot, { homeDir: opts.homeDir });
    return resolveDefaults(loaded);
  } catch (err) {
    if (opts.notify) {
      try {
        // For ConfigValidationError, swap the absolute path for a sanitized
        // form (~/... or <repo>/...) but keep the rest of the message intact
        // so the user still sees "invalid JSON" / "<typebox detail>" verbatim.
        const detail = err instanceof ConfigValidationError
          ? err.message.replace(err.filePath, sanitizePath(err.filePath, opts.homeDir, repoRoot))
          : err instanceof Error
            ? err.message
            : String(err);
        opts.notify(`sf-team config: ${detail} — falling back to built-in defaults.`, "warning");
      } catch {
        // notify hook threw; swallow so we still fall back cleanly.
      }
    }
    return resolveDefaults({});
  }
}

/**
 * Replace home / repo-root prefixes in a path with `~` and `<repo>/` so the
 * warning surfaces a recognizable shorthand instead of an absolute path
 * that may include sensitive directory names.
 */
function sanitizePath(filePath: string, homeDir?: string, repoRoot?: string): string {
  // Repo root wins over home: when a repo lives under $HOME, a project
  // `.pi/sf/team/config.json` should sanitize to `<repo>/.pi/sf/team/config.json`,
  // not `~/path/to/repo/.pi/sf/team/config.json`.
  if (repoRoot && filePath.startsWith(repoRoot)) return `<repo>${filePath.slice(repoRoot.length)}`;
  const home = homeDir ?? os.homedir();
  if (homeDir && filePath.startsWith(homeDir)) return `~${filePath.slice(homeDir.length)}`;
  if (filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
  return filePath;
}
