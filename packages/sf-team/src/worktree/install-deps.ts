import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkflowReporter } from "@pi-stef/agent-workflows";

import { detectPackageManager } from "../runtime/package-manager";
import { WorktreeCreationError } from "./errors";

export type InstallResult =
  | { kind: "skipped"; reason: "opted_out" | "no_package_json" | "node_modules_present" }
  | { kind: "installed"; pm: "pnpm" | "npm" | "yarn" | "bun" };

const TRUTHY_OPTOUT = new Set(["1", "true", "yes", "on"]);

function isOptedOut(): boolean {
  const raw = process.env.SF_TEAM_SKIP_AUTO_INSTALL;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return TRUTHY_OPTOUT.has(normalized);
}

export function installDependenciesIfMissing(
  worktreePath: string,
  reporter?: WorkflowReporter,
): InstallResult {
  // 1. Opt-out via env var.
  if (isOptedOut()) {
    reportInstallNotice(
      `sf_team: skipping dependency install in ${worktreePath} (SF_TEAM_SKIP_AUTO_INSTALL is set)`,
      reporter,
    );
    return { kind: "skipped", reason: "opted_out" };
  }

  // 2. Not a Node project — no package.json.
  if (!existsSync(path.join(worktreePath, "package.json"))) {
    return { kind: "skipped", reason: "no_package_json" };
  }

  // 3. Already installed — node_modules present.
  if (existsSync(path.join(worktreePath, "node_modules"))) {
    reportInstallNotice(
      `sf_team: dependencies already present at ${worktreePath}; skipping install`,
      reporter,
    );
    return { kind: "skipped", reason: "node_modules_present" };
  }

  // 4. Install via the detected package manager.
  const pm = detectPackageManager(worktreePath);
  reportInstallNotice(
    `sf_team: installing dependencies via ${pm} install in ${worktreePath} (this may take a few minutes)...`,
    reporter,
  );
  const r = spawnSync(pm, ["install"], {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });

  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    const hint =
      code === "ENOENT"
        ? ` Hint: ensure ${pm} is on PATH (e.g., \`corepack enable && corepack prepare ${pm} --activate\`).`
        : "";
    throw new WorktreeCreationError(
      "install",
      `sf_team: failed to spawn ${pm} install: ${r.error.message}${hint}`,
    );
  }

  if (r.status === null) {
    throw new WorktreeCreationError(
      "install",
      `sf_team: ${pm} install was interrupted (signal: ${r.signal ?? "unknown"})`,
    );
  }

  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").slice(0, 2048);
    const stdout = (r.stdout ?? "").slice(0, 2048);
    const detail = stderr || stdout;
    throw new WorktreeCreationError(
      "install",
      `sf_team: ${pm} install exited ${r.status}\n${detail}`,
    );
  }

  return { kind: "installed", pm };
}

function reportInstallNotice(message: string, reporter: WorkflowReporter | undefined): void {
  if (reporter) {
    reporter.message(message, { level: "info" });
    return;
  }
  console.error(message);
}
