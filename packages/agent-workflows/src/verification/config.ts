export const VERIFICATION_TIMINGS = ["off", "before", "after", "both"] as const;
export type VerificationTiming = (typeof VERIFICATION_TIMINGS)[number];

export const VERIFICATION_MODES = ["commands", "agent", "commands-and-agent"] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

export const VERIFICATION_CACHE_MODES = ["off", "run", "persistent"] as const;
export type VerificationCacheMode = (typeof VERIFICATION_CACHE_MODES)[number];

export const VERIFICATION_STAGE_NAMES = ["typecheck", "test", "lint"] as const;
export type VerificationStageName = (typeof VERIFICATION_STAGE_NAMES)[number];

export type VerificationPhase = "before" | "after";

export interface VerificationCommand {
  label?: string;
  cmd: string;
  args: string[];
  /** Optional package.json script name. Used by adapters for skip notices and diagnostics. */
  script?: string;
}

export type VerificationStageInput = VerificationStageName | "all" | VerificationCommand;
export type VerificationStageSpec = VerificationStageName | VerificationCommand;

export interface VerificationCacheConfig {
  mode: VerificationCacheMode;
  /** Relative paths resolve from the verification cwd; absolute paths are used as-is. */
  path?: string;
}

export interface VerificationConfigInput {
  timing?: VerificationTiming;
  mode?: VerificationMode;
  stages?: VerificationStageInput | VerificationStageInput[];
  commands?: VerificationCommand | VerificationCommand[];
  cache?: VerificationCacheMode | VerificationCacheConfig;
  maxAttempts?: number;
}

export interface ResolvedVerificationConfig {
  timing: VerificationTiming;
  mode: VerificationMode;
  stages: VerificationStageSpec[];
  commands: VerificationCommand[];
  cache: VerificationCacheConfig;
  maxAttempts: number;
}

const DEFAULT_STAGES: VerificationStageSpec[] = ["typecheck", "test"];
const ALL_STAGES: VerificationStageSpec[] = ["typecheck", "test", "lint"];
const DEFAULT_MAX_ATTEMPTS = 2;

export function defaultVerificationConfigForTool(toolName: string): ResolvedVerificationConfig {
  return {
    timing: toolName === "sf_team_plan" ? "off" : "after",
    mode: "commands",
    stages: [...DEFAULT_STAGES],
    commands: [],
    cache: { mode: "run" },
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  };
}

export function resolveVerificationConfig(
  toolName: string,
  input: VerificationConfigInput | undefined,
  override: VerificationConfigInput | undefined = undefined,
): ResolvedVerificationConfig {
  const base = defaultVerificationConfigForTool(toolName);
  const merged = mergeVerificationInput(input, override);
  return {
    timing: merged.timing ?? base.timing,
    mode: merged.mode ?? base.mode,
    stages: normalizeStages(merged.stages, base.stages),
    commands: normalizeCommands(merged.commands),
    cache: normalizeCache(merged.cache, base.cache),
    maxAttempts: normalizeMaxAttempts(merged.maxAttempts, base.maxAttempts),
  };
}

export function isVerificationEnabledForPhase(
  config: Pick<ResolvedVerificationConfig, "timing">,
  phase: VerificationPhase,
): boolean {
  if (config.timing === "off") return false;
  if (config.timing === "both") return true;
  return config.timing === phase;
}

export function mergeVerificationInput(
  base: VerificationConfigInput | undefined,
  override: VerificationConfigInput | undefined,
): VerificationConfigInput {
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function normalizeStages(
  value: VerificationConfigInput["stages"],
  fallback: VerificationStageSpec[],
): VerificationStageSpec[] {
  if (value === undefined) return [...fallback];
  const values = Array.isArray(value) ? value : [value];
  const out: VerificationStageSpec[] = [];
  for (const entry of values) {
    if (entry === "all") {
      out.push(...ALL_STAGES);
    } else if (isVerificationCommand(entry)) {
      out.push(normalizeCommand(entry));
    } else {
      out.push(entry);
    }
  }
  return out;
}

function normalizeCommands(value: VerificationConfigInput["commands"]): VerificationCommand[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(normalizeCommand);
}

function normalizeCache(
  value: VerificationConfigInput["cache"],
  fallback: VerificationCacheConfig,
): VerificationCacheConfig {
  if (value === undefined) return { ...fallback };
  if (typeof value === "string") return { mode: value };
  return { ...value };
}

function normalizeMaxAttempts(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function normalizeCommand(command: VerificationCommand): VerificationCommand {
  return {
    ...(command.label ? { label: command.label } : {}),
    cmd: command.cmd,
    args: [...command.args],
    ...(command.script ? { script: command.script } : {}),
  };
}

function isVerificationCommand(value: VerificationStageInput): value is VerificationCommand {
  return typeof value === "object" && value !== null && "cmd" in value;
}
