import { spawnSync } from "node:child_process";
import { resolvePlanRoot } from "@pi-stef/agent-workflows";
import type { GitMode, ResolvedDefaults, TddMode } from "./schema";

export interface RuntimeResolutionInput {
  prompt: { aiPlanPath?: string; gitMode?: GitMode; tddMode?: TddMode };
  defaults: ResolvedDefaults;
  repoRoot: string;
  /**
   * Optional persisted runtime hydrated from workflow.json on resume.
   * When provided, the resume-precedence rule (S-512) takes effect:
   * a persisted gitMode/tddMode overrides config/default + auto detection
   * UNLESS the prompt arg was explicitly 'on' or 'off'.
   */
  persisted?: { planRootPath?: string; gitMode?: "on" | "off"; tddMode?: "on" | "off" | "auto" };
  /** Test injection point — replaces git -C <cwd> rev-parse probe. */
  __testGitProbe?: (cwd: string) => boolean;
}

export interface ResolvedRuntime {
  planRoot: string;
  gitMode: "on" | "off";
  tddMode: "on" | "off" | "auto";
  repoRoot: string;
  raw: {
    aiPlanPath: string | undefined;
    gitMode: GitMode | undefined;
    tddMode: TddMode | undefined;
  };
}

function probeGitCwd(cwd: string): boolean {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

function resolveGitMode(
  rawGitMode: GitMode | undefined,
  configGitMode: GitMode,
  persisted: RuntimeResolutionInput["persisted"],
  repoRoot: string,
  gitProbe: (cwd: string) => boolean,
): "on" | "off" {
  // Explicit prompt 'on'/'off' always win (ignores persisted and config)
  if (rawGitMode === "on") return "on";
  if (rawGitMode === "off") return "off";

  // Resume precedence: persisted wins when prompt is absent or explicitly 'auto'
  if (persisted?.gitMode !== undefined && (rawGitMode === undefined || rawGitMode === "auto")) {
    return persisted.gitMode;
  }

  // Prompt explicitly 'auto' (no persisted) → probe cwd (ignores config)
  if (rawGitMode === "auto") {
    return gitProbe(repoRoot) ? "on" : "off";
  }

  // Prompt absent: config 'on'/'off' wins over probe
  if (configGitMode === "on") return "on";
  if (configGitMode === "off") return "off";

  // Config 'auto' or absent → probe cwd
  return gitProbe(repoRoot) ? "on" : "off";
}

function resolveTddMode(
  rawTddMode: TddMode | undefined,
  configTddMode: TddMode,
  persisted: RuntimeResolutionInput["persisted"],
): "on" | "off" | "auto" {
  // Explicit prompt 'on'/'off' always win
  if (rawTddMode === "on" || rawTddMode === "off") return rawTddMode;

  // Resume precedence: persisted wins when prompt is absent or explicitly 'auto'
  if (persisted?.tddMode !== undefined && (rawTddMode === undefined || rawTddMode === "auto")) {
    return persisted.tddMode;
  }

  // Prompt explicitly 'auto' (no persisted) → return 'auto' (ignores config)
  if (rawTddMode === "auto") return "auto";

  // Prompt absent → use config (may be 'on', 'off', or 'auto')
  if (configTddMode !== undefined) return configTddMode;
  return "auto";
}

export function resolveRuntime(input: RuntimeResolutionInput): ResolvedRuntime {
  const { prompt, defaults, repoRoot, persisted, __testGitProbe } = input;
  const gitProbe = __testGitProbe ?? probeGitCwd;

  const rawGitMode = prompt.gitMode;
  const rawTddMode = prompt.tddMode;
  const rawAiPlanPath = prompt.aiPlanPath;

  const configGitMode = defaults.paths?.git_mode ?? "auto";
  const configTddMode = defaults.tdd?.mode ?? "auto";

  const gitMode = resolveGitMode(rawGitMode, configGitMode, persisted, repoRoot, gitProbe);
  const tddMode = resolveTddMode(rawTddMode, configTddMode, persisted);

  // planRoot resolution: prompt > persisted > default
  let planRoot: string;
  if (rawAiPlanPath !== undefined) {
    planRoot = resolvePlanRoot(repoRoot, rawAiPlanPath);
  } else if (persisted?.planRootPath !== undefined) {
    planRoot = persisted.planRootPath;
  } else if (defaults.paths?.ai_plan_root !== undefined) {
    planRoot = resolvePlanRoot(repoRoot, defaults.paths.ai_plan_root);
  } else {
    planRoot = resolvePlanRoot(repoRoot, undefined);
  }

  return {
    planRoot,
    gitMode,
    tddMode,
    repoRoot,
    raw: {
      aiPlanPath: rawAiPlanPath,
      gitMode: rawGitMode,
      tddMode: rawTddMode,
    },
  };
}
