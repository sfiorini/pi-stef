import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolveSkillPath } from "./resolve-skill";
import type { TeamMember } from "./types";

/**
 * Locked plan decision #3: the reviewer-profile flags are immutable. Any
 * caller that requests `member.role === "reviewer"` MUST receive these
 * isolation flags, MUST NOT receive any `--skill` flag, and MUST receive the
 * read-only tool allowlist.
 */
export const REVIEWER_PROFILE_FLAGS = [
  "--mode",
  "json",
  "--no-session",
  "--no-skills",
  "--no-prompt-templates",
  "--no-extensions",
  "--no-context-files",
  "--tools",
  "read,grep,find,ls",
] as const;

/**
 * Planner profile: JSON-mode + no-session + READ-ONLY tool allowlist. The
 * planner may inspect the repo but must return the full plan body in its final
 * response; it must not write task-plan.md/milestone-plan.md directly.
 */
export const PLANNER_PROFILE_FLAGS = [
  "--mode",
  "json",
  "--no-session",
  "--no-skills",
  "--no-prompt-templates",
  "--no-extensions",
  "--no-context-files",
  "--tools",
  "read,grep,find,ls",
] as const;

/**
 * Developer profile stays write-capable and skill-enabled, but blocks ambient
 * prompt templates/extensions. Those can inject interactive startup behavior
 * into non-interactive story-lane subprocesses. Keep context files enabled so
 * repo AGENTS.md / CLAUDE.md guidance still applies.
 */
export const DEVELOPER_PROFILE_FLAGS = [
  "--mode",
  "json",
  "--no-session",
  "--no-prompt-templates",
  "--no-extensions",
] as const;

/**
 * Researcher profile: JSON-mode + no-session + READ-ONLY tool allowlist
 * (`read,grep,find,ls`). NEVER includes `bash`, `edit`, or `write` — the
 * researcher's job is to analyze the prompt + repo state and emit a
 * structured findings JSON; external-context resolution is handled by the
 * orchestrator (TS) via the `ExternalFetcher` injection point, NOT inside
 * the researcher subprocess.
 */
export const RESEARCHER_PROFILE_FLAGS = [
  "--mode",
  "json",
  "--no-session",
  "--no-prompt-templates",
  "--no-extensions",
  "--no-context-files",
  "--tools",
  "read,grep,find,ls",
] as const;

export interface BuildArgvOptions {
  /** Optional path to a system-prompt file. Wired via `--append-system-prompt`. */
  appendSystemPromptPath?: string;
  /**
   * Override `resolveSkillPath` for tests. The default uses the on-disk
   * resolver. Returns `undefined` for unknown skills (warn-and-continue).
   */
  resolveSkill?: (name: string) => string | undefined;
  /**
   * Resolve the on-disk path to the `cursor-provider` extension entry,
   * or `undefined` when not installed. Only consulted when
   * `member.model` starts with `cursor/`. The default checks
   * `SF_TEAM_CURSOR_PROVIDER_PATH` first, then probes the workspace
   * sibling directory `<sf-team>/../cursor-provider/extensions/cursor-provider.ts`.
   *
   * Tests inject a stub here to exercise both the present + absent paths
   * without relying on workspace layout.
   */
  resolveCursorProvider?: () => string | undefined;
  /**
   * Resolve the on-disk path to the `azure-foundry-provider` extension
   * entry, or `undefined` when not installed. Consulted only when the
   * model prefix matches one of the configured Azure deployment IDs
   * (see {@link resolveAzureFoundryDeploymentIds}). The default checks
   * `SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH` first, then probes the
   * workspace sibling
   * `<sf-team>/../azure-foundry-provider/extensions/azure-foundry-provider.ts`.
   *
   * **Trust boundary**: loading the extension via explicit
   * `--extension <path>` executes that extension's registration code in
   * the spawned pi subprocess. The reviewer's read-only tool allowlist,
   * `--no-skills`, `--no-prompt-templates`, and `--no-context-files`
   * remain in force; the extension can register providers but cannot
   * widen the tool surface. The `SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH`
   * override carries the same "user-controlled file path is executed"
   * implication that the existing `SF_TEAM_CURSOR_PROVIDER_PATH`
   * override already carries.
   *
   * **Cursor reservation**: `cursor/*` models are handled exclusively by
   * the cursor branch in {@link buildPiArgv} (`if cursor/ ... else
   * { azure ... }`). A user-configured deployment named `cursor` will
   * therefore never route `cursor/<model>` through this resolver. To
   * use such a deployment, rename it to something that does not collide
   * with the `cursor/` namespace.
   */
  resolveAzureFoundryProvider?: () => string | undefined;
  /**
   * Resolve the list of configured Azure deployment IDs (the `id`
   * fields of `deployments[]` in the user's azure-foundry config). Used
   * to decide whether a given `provider/model` string is an Azure
   * deployment that should trigger the azure-foundry extension load.
   *
   * The default reads the same file the `azure-foundry-provider` package
   * itself reads: `~/.pi/azure-foundry/config.json` by default, override
   * env var `PI_AZURE_FOUNDRY_CONFIG`. The file is parsed as JSONC
   * (line + block comments stripped) to match the provider's behavior.
   *
   * **Read-only contract**: this resolver MUST NOT create, modify, or
   * seed any file. In particular it does NOT call the provider's
   * `loadConfig()` (which has documented `writeSeed` / `writeSchemaFile`
   * side effects). Returns `[]` on any error, missing file, or
   * malformed shape.
   *
   * **Collision policy**: a user who names an azure deployment after a
   * built-in pi provider prefix (other than `cursor`, which is
   * structurally reserved — see {@link resolveAzureFoundryProvider})
   * explicitly opts into routing that prefix through the azure-foundry
   * extension. Tests in `tests/argv.test.ts` lock this behavior in.
   * Users who want to filter out colliding IDs can inject a custom
   * resolver via this option.
   */
  resolveAzureFoundryDeploymentIds?: () => string[];
}

/**
 * Default resolver for the cursor-provider extension. We probe two
 * sources in order:
 *   1. `SF_TEAM_CURSOR_PROVIDER_PATH` env override (absolute path). The
 *      override is required to point at a path that EXISTS on disk; if
 *      the env var is set but the path does not exist, we fall through
 *      to the workspace probe (rather than crash, which would block
 *      every spawn). This is intentional — a typo in the env var should
 *      degrade to the same behavior as the env var being unset.
 *   2. Workspace-sibling probe — `<sf-team>/../cursor-provider/extensions/cursor-provider.ts`.
 *
 * Returns `undefined` when neither path exists, so callers can decide
 * to fall back to the original `--no-extensions`-only behavior (pi
 * will surface the original "Model not found" error in that case).
 */
export function defaultResolveCursorProvider(): string | undefined {
  const envOverride = process.env.SF_TEAM_CURSOR_PROVIDER_PATH;
  if (envOverride && envOverride.length > 0 && existsSync(envOverride)) {
    return envOverride;
  }
  // import.meta.url points at this file under either the source tree or
  // the compiled output. Both resolve to <sf-team>/src/runtime or
  // <sf-team>/dist/runtime; the cursor-provider sibling lives at
  // <workspace>/packages/cursor-provider/extensions/cursor-provider.ts,
  // so we walk up to the workspace `packages` dir then across.
  const here = fileURLToPath(new URL(".", import.meta.url));
  // <sf-team>/src/runtime  → ../../..  → <workspace>/packages
  const candidate = path.resolve(here, "..", "..", "..", "cursor-provider", "extensions", "cursor-provider.ts");
  if (existsSync(candidate)) return candidate;
  return undefined;
}

/**
 * Default resolver for the azure-foundry-provider extension. Mirrors
 * {@link defaultResolveCursorProvider}: env override first, then a
 * workspace probe. Returns `undefined` when neither path exists, so
 * callers degrade gracefully (pi will surface "Model not found" on its
 * own).
 *
 * Env override: `SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH`. A set-but-missing
 * value falls through to the workspace probe (same documented
 * degradation as the cursor variant). See
 * {@link BuildArgvOptions.resolveAzureFoundryProvider} for the trust
 * boundary notes.
 */
export function defaultResolveAzureFoundryProvider(): string | undefined {
  const envOverride = process.env.SF_TEAM_AZURE_FOUNDRY_PROVIDER_PATH;
  if (envOverride && envOverride.length > 0 && existsSync(envOverride)) {
    return envOverride;
  }
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidate = path.resolve(
    here,
    "..",
    "..",
    "..",
    "azure-foundry-provider",
    "extensions",
    "azure-foundry-provider.ts",
  );
  if (existsSync(candidate)) return candidate;
  return undefined;
}

/**
 * Strip JSONC line (`//`) and block (`/* ... *​/`) comments from `input`,
 * preserving string contents (including embedded `//` and `/*`). Newlines
 * inside stripped regions are preserved so line numbers in any downstream
 * error message stay stable.
 *
 * Inlined rather than imported from `@pi-stef/azure-foundry-provider`
 * to avoid making `sf-team` depend on a specific provider package;
 * the algorithm matches `packages/azure-foundry-provider/src/jsonc.ts`.
 */
function stripJsonc(input: string): string {
  let output = "";
  let inString = false;
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        inString = false;
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char as '"' | "'";
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      if (i < input.length) output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length) {
        if (input[i] === "\n") output += "\n";
        if (input[i] === "*" && input[i + 1] === "/") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    output += char;
  }

  return output;
}

/**
 * Default resolver for the list of configured Azure deployment IDs.
 *
 * Reads the SAME path the `azure-foundry-provider` package reads —
 * env override `PI_AZURE_FOUNDRY_CONFIG` first, then
 * `~/.pi/azure-foundry/config.json`. We do not introduce a sf-team-
 * specific env var so the two cannot drift.
 *
 * The file is parsed as JSONC (comments stripped) to match the
 * provider's behavior. Errors, missing file, missing `deployments`
 * array, and malformed shapes all return `[]`. The function is strictly
 * read-only — it never creates or modifies any file, in contrast to the
 * provider's `loadConfig()` which has documented `writeSeed` and
 * `writeSchemaFile` side effects.
 */
export function defaultResolveAzureFoundryDeploymentIds(): string[] {
  try {
    const override = process.env.PI_AZURE_FOUNDRY_CONFIG?.trim();
    const configPath = override && override.length > 0
      ? override
      : path.join(homedir(), ".pi", "azure-foundry", "config.json");
    if (!existsSync(configPath)) return [];
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(stripJsonc(raw));
    if (!parsed || typeof parsed !== "object") return [];
    const deployments = (parsed as { deployments?: unknown }).deployments;
    if (!Array.isArray(deployments)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of deployments) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== "string" || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Build the pi argv for a given role. Role-dispatched:
 *   - reviewer: REVIEWER_PROFILE_FLAGS + --model + optional --thinking +
 *     optional --append-system-prompt + -p task. NEVER includes --skill.
 *   - planner: PLANNER_PROFILE_FLAGS + --model + optional --thinking +
 *     optional --append-system-prompt + -p task. NEVER includes --skill.
 *   - developer: DEVELOPER_PROFILE_FLAGS + --model + optional --thinking +
 *     zero-or-more --skill (per resolved YAML skill list) + optional
 *     --append-system-prompt + -p task. Skips --skill for missing skills
 *     (warn-and-continue happens in the orchestrator pre-flight).
 */
export function buildPiArgv(member: TeamMember, task: string, opts: BuildArgvOptions = {}): string[] {
  const argv: string[] = [];
  if (member.role === "reviewer") {
    argv.push(...REVIEWER_PROFILE_FLAGS);
  } else if (member.role === "researcher") {
    argv.push(...RESEARCHER_PROFILE_FLAGS);
  } else if (member.role === "planner") {
    argv.push(...PLANNER_PROFILE_FLAGS);
  } else {
    argv.push(...DEVELOPER_PROFILE_FLAGS);
  }

  argv.push("--model", member.model);
  if (member.thinking) argv.push("--thinking", member.thinking);

  // Extension-resident provider opt-in. The role profiles pin
  // `--no-extensions` for isolation, which means any provider that is
  // implemented as a pi extension (`cursor-provider`,
  // `azure-foundry-provider`) would never load and pi would reject the
  // `<provider>/<model>` string as "Model not found". When the user has
  // the relevant extension installed AND is asking for a model from that
  // provider, we load ONLY that one extension via an explicit
  // `--extension <path>`. Per pi's `--no-extensions` docs ("explicit -e
  // paths still work"), this does not re-enable extension auto-discovery
  // — it only adds the single file we point at.
  //
  // The cursor and azure branches are **mutually exclusive** (`if cursor/
  // ... else { azure ... }`). At most one `--extension` is appended per
  // spawn. The `cursor/` namespace is structurally hard-reserved to the
  // cursor branch even if a user has named an azure deployment `cursor`.
  // For other prefix collisions (e.g., an azure deployment named
  // `anthropic`), the user's config takes precedence — we load the azure
  // extension for that namespace because the user explicitly named it
  // that way. See `BuildArgvOptions.resolveAzureFoundryProvider` JSDoc.
  if (member.model.startsWith("cursor/")) {
    const resolveCursor = opts.resolveCursorProvider ?? defaultResolveCursorProvider;
    const cursorExtPath = resolveCursor();
    if (cursorExtPath) argv.push("--extension", cursorExtPath);
  } else {
    const resolveIds = opts.resolveAzureFoundryDeploymentIds ?? defaultResolveAzureFoundryDeploymentIds;
    const ids = resolveIds();
    if (ids.length > 0) {
      const matched = ids.some((id) => id.length > 0 && member.model.startsWith(`${id}/`));
      if (matched) {
        const resolveAzure = opts.resolveAzureFoundryProvider ?? defaultResolveAzureFoundryProvider;
        const azureExtPath = resolveAzure();
        if (azureExtPath) argv.push("--extension", azureExtPath);
      }
    }
  }

  // Reviewer, researcher, and planner are skill-free; skills only flow into
  // developer roles where write-capable implementation work happens.
  if (member.role === "developer") {
    const resolver = opts.resolveSkill ?? ((name: string) => resolveSkillPath(name));
    for (const skillName of member.skills ?? []) {
      const resolved = resolver(skillName);
      if (resolved) argv.push("--skill", resolved);
      // Missing skills are silently dropped here; the orchestrator's pre-flight
      // logs a one-time warning so the user knows.
    }
  }

  if (opts.appendSystemPromptPath) {
    argv.push("--append-system-prompt", opts.appendSystemPromptPath);
  }

  argv.push("-p", task);
  return argv;
}
