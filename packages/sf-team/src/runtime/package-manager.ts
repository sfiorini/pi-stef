import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Return true when `package.json#workspaces` is a non-empty npm-style
 * declaration: either a non-empty array of patterns, or the npm 7+ object
 * form `{ packages: [non-empty array] }` (also used by yarn classic).
 * Empty array, missing field, or `{ packages: [] }` returns false.
 *
 * Used by `detectPackageManager` both as a "stale pnpm-lock" gate and as
 * the npm-style fallback. Centralized here so the truthiness rules stay
 * consistent in both call sites.
 */
function hasNpmStyleWorkspaces(workspacesField: unknown): boolean {
  if (Array.isArray(workspacesField)) return workspacesField.length > 0;
  if (workspacesField && typeof workspacesField === "object") {
    const packages = (workspacesField as { packages?: unknown }).packages;
    return Array.isArray(packages) && packages.length > 0;
  }
  return false;
}

/**
 * Detect the package manager the worktree expects.
 *
 * Resolution order:
 *   1. `package.json#packageManager` (Corepack standard, e.g. `npm@10.2.0`,
 *      `pnpm@9.0.0`, `yarn@4.0.0`, `bun@1.1.0`). When set we trust it
 *      regardless of which lockfiles happen to be present, since the
 *      author has explicitly declared their PM. The check order below
 *      is incidental — `pnpm`/`npm`/`yarn`/`bun` prefixes don't collide.
 *   2. `pnpm-workspace.yaml` at the worktree root → pnpm. pnpm uses
 *      this file to declare workspaces; its presence is a strong
 *      pnpm-only signal even if no lockfile has been committed yet.
 *   3. Lockfile detection at the worktree root, in this priority order:
 *      `pnpm-lock.yaml` > `yarn.lock` > `bun.lock` (Bun ≥1.2 default,
 *      Jan 2025+) > `bun.lockb` (Bun ≤1.1 binary) > `package-lock.json`.
 *      Pnpm is checked first so ambiguous multi-PM repos resolve to the
 *      same default they did before this detector existed.
 *
 *      **Stale-pnpm-lock gate (added 2026-05-08):** the `pnpm-lock.yaml`
 *      step is SKIPPED when `package.json#workspaces` is non-empty. At
 *      this point step 2 has already returned pnpm if a real
 *      `pnpm-workspace.yaml` was present, so reaching step 3 with a
 *      non-empty `workspaces` field implies the canonical pnpm-monorepo
 *      declaration is missing. pnpm doesn't honor `package.json#workspaces`
 *      (it warns and ignores it), so the only way that combination
 *      occurs in a real pnpm project is if a stale `pnpm-lock.yaml` was
 *      left behind by an earlier tool run that ran `pnpm install` against
 *      an npm-style repo (verified live: cursor user 2026-05-08, weather-app
 *      worktree with 3 workspaces, both lockfiles, no pnpm-workspace.yaml,
 *      verification gate failed with `vitest: command not found` because
 *      pnpm install left workspace node_modules empty). Skipping the
 *      pnpm-lock step lets yarn.lock / bun.lock / package-lock.json
 *      still win at their own priority slots.
 *   4. `package.json#workspaces` (an npm/yarn-style array or object) →
 *      npm. Catches the case where neither yarn.lock nor bun.lock nor
 *      package-lock.json was present but the project clearly declares
 *      itself as an npm-style workspaces repo.
 *   5. Default `pnpm` — preserves prior behavior for repos without any
 *      detection signal (existing tests assume this).
 */
export function detectPackageManager(cwd: string): "pnpm" | "npm" | "yarn" | "bun" {
  const pkgPath = path.join(cwd, "package.json");
  let workspacesField: unknown;
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { packageManager?: unknown; workspaces?: unknown };
    if (typeof parsed.packageManager === "string") {
      const pm = parsed.packageManager.trim().toLowerCase();
      if (pm.startsWith("pnpm")) return "pnpm";
      if (pm.startsWith("yarn")) return "yarn";
      if (pm.startsWith("bun")) return "bun";
      if (pm.startsWith("npm")) return "npm";
    }
    workspacesField = parsed.workspaces;
  } catch {
    // Missing or malformed package.json → fall through to lockfile detection.
    // packageScriptsAt() handles malformed-package.json escalation; we
    // shouldn't double-throw here.
  }
  if (existsSync(path.join(cwd, "pnpm-workspace.yaml"))) return "pnpm";
  const npmStyleWorkspaces = hasNpmStyleWorkspaces(workspacesField);
  if (!npmStyleWorkspaces && existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(cwd, "bun.lock"))) return "bun";
  if (existsSync(path.join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(path.join(cwd, "package-lock.json"))) return "npm";
  if (npmStyleWorkspaces) return "npm";
  return "pnpm";
}

/**
 * Return the set of script names defined in `<cwd>/package.json`.
 *
 * - **Missing package.json** (ENOENT): returns an empty set. Callers treat
 *   this as "not a Node project" and skip every default stage silently —
 *   safe because there is no manifest to corrupt.
 * - **Malformed package.json** (JSON parse error or non-string content):
 *   throws. A broken manifest is exactly the kind of regression the
 *   verification gate exists to catch; silently skipping would let
 *   sf_team_implement commit a corrupted file.
 * - **No `scripts` field**: returns an empty set (valid manifest, just no
 *   scripts defined).
 */
export function packageScriptsAt(cwd: string, toolName: string): Set<string> {
  const pkgPath = path.join(cwd, "package.json");
  let raw: string;
  try {
    raw = readFileSync(pkgPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw new Error(
      `${toolName}: failed to read ${pkgPath}: ${(err as Error).message}`,
    );
  }
  let parsed: { scripts?: unknown };
  try {
    parsed = JSON.parse(raw) as { scripts?: unknown };
  } catch (err) {
    throw new Error(
      `${toolName}: ${pkgPath} is not valid JSON — refusing to skip the verification gate. ${(err as Error).message}`,
    );
  }
  if (!parsed.scripts || typeof parsed.scripts !== "object" || Array.isArray(parsed.scripts)) {
    return new Set();
  }
  return new Set(Object.keys(parsed.scripts as Record<string, unknown>));
}
