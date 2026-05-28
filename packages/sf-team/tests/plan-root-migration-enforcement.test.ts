/**
 * S-311: Enforcement test — ensures the legacy planFolderPath() call-sites
 * and bare PLAN_FOLDER_ROOT joins introduced during S-310 are annotated with
 * "migration-allowed: legacy" so that they are easy to find and eventually
 * remove in M4/M5 once the planRoot param is threaded end-to-end.
 *
 * Three sweeps across sf-team/src and agent-workflows/src:
 *   1. planFolderPath( calls (not planFolderPathFromRoot)
 *   2. Named imports of planFolderPath
 *   3. PLAN_FOLDER_ROOT in a path.join (the legacy repoRoot + PLAN_FOLDER_ROOT pattern)
 *
 * The canonical definitions file (artifacts/paths.ts) is excluded — it
 * contains the shim definition itself and is not an application-level caller.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");

const SF_TEAM_SRC = path.join(REPO_ROOT, "packages/sf-team/src");
const AGENT_WF_SRC = path.join(REPO_ROOT, "packages/agent-workflows/src");

/** Files excluded from all sweeps (definition / shim files). */
const EXCLUDED_FILES = new Set([
  path.join(AGENT_WF_SRC, "artifacts/paths.ts"),
]);

function walkTs(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(full, results);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

function collectSourceFiles(): string[] {
  const files: string[] = [
    ...walkTs(SF_TEAM_SRC),
    ...walkTs(AGENT_WF_SRC),
  ];
  return files.filter((f) => !EXCLUDED_FILES.has(f));
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scanFiles(
  files: string[],
  predicate: (line: string) => boolean,
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (predicate(line) && !line.includes("migration-allowed: legacy")) {
        violations.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: line.trim() });
      }
    }
  }
  return violations;
}

function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => `  ${v.file}:${v.line} — ${v.text}`)
    .join("\n");
}

describe("S-311 plan-root migration enforcement", () => {
  let files: string[];

  beforeAll(() => {
    files = collectSourceFiles();
  });

  it("planFolderPath( calls are all annotated migration-allowed: legacy", () => {
    const violations = scanFiles(
      files,
      (line) =>
        /planFolderPath\s*\(/.test(line) &&
        !/planFolderPathFromRoot/.test(line) &&
        !/export function planFolderPath/.test(line),
    );
    expect(violations).toEqual([]);
    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} un-annotated planFolderPath() call(s).\n` +
          `Add "// migration-allowed: legacy" to each line:\n` +
          formatViolations(violations),
      );
    }
  });

  it("named imports of planFolderPath (the shim) are all annotated migration-allowed: legacy", () => {
    const violations = scanFiles(
      files,
      (line) =>
        /import\s*\{[^}]*\bplanFolderPath\b[^}]*\}/.test(line) &&
        !/planFolderPathFromRoot/.test(line.replace(/import\s*\{[^}]*planFolderPath[^F][^}]*\}/, "")),
    );
    // Refine: flag lines that import planFolderPath BUT NOT ONLY planFolderPathFromRoot
    const refined = scanFiles(files, (line) => {
      if (!line.includes("planFolderPath")) return false;
      if (!line.trimStart().startsWith("import")) return false;
      // Extract the named imports between { }
      const m = line.match(/\{([^}]+)\}/);
      if (!m) return false;
      const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
      return names.includes("planFolderPath");
    });
    expect(refined).toEqual([]);
    if (refined.length > 0) {
      throw new Error(
        `Found ${refined.length} un-annotated named import(s) of planFolderPath:\n` +
          formatViolations(refined),
      );
    }
  });

  it("PLAN_FOLDER_ROOT used in path.join without planRoot arg is annotated migration-allowed: legacy", () => {
    const violations = scanFiles(
      files,
      (line) =>
        line.includes("PLAN_FOLDER_ROOT") &&
        /path\.join\s*\(/.test(line),
    );
    expect(violations).toEqual([]);
    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} un-annotated PLAN_FOLDER_ROOT join(s).\n` +
          `Add "// migration-allowed: legacy" to each line:\n` +
          formatViolations(violations),
      );
    }
  });
});
