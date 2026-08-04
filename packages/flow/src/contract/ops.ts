import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveTemplate } from "../paths.js"; // single source of truth (shared with validate.ts)

/** Derive a kebab slug from a source string, optionally date-prefixed. */
export function deriveSlug(source: string, opts: { prefix?: "date" | "none"; now?: Date }): string {
  const kebab = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
  if ((opts.prefix ?? "date") === "date") {
    const d = opts.now ?? new Date(); // orchestrator supplies; tests pass explicitly
    const iso = d.toISOString().slice(0, 10);
    return `${iso}-${kebab}`;
  }
  return kebab;
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Materialize artifact skeletons into `dir`. Resume-safe: a non-empty existing
 * file is never clobbered. Files without a template are created empty.
 */
export function materializeArtifacts(
  dir: string,
  artifacts: { file: string; template?: string }[],
): void {
  mkdirSync(dir, { recursive: true });
  for (const a of artifacts) {
    const target = join(dir, a.file);
    if (existsSync(target) && statSync(target).size > 0) continue; // resume-safe
    const body = a.template ? safeRead(resolveTemplate(a.template)) : "";
    writeFileSync(target, body, "utf8");
  }
}

export interface ArtifactAssertion {
  status: "success" | "blocked";
  missing: string[];
  empty: string[];
  detail: string;
}

/**
 * Assert the artifacts in `dir` satisfy the declared checks. `nonempty` requires
 * every target file to exist and be non-empty. With no explicit `files` list,
 * every `.md` in the dir is checked. An empty target set with `nonempty` blocks
 * (nothing was produced), which is the self-defeating check that catches a
 * skipped/incomplete plan phase.
 */
export function assertArtifacts(dir: string, assert: string[], files?: string[]): ArtifactAssertion {
  if (!existsSync(dir)) {
    return { status: "blocked", missing: [dir], empty: [], detail: `dir missing: ${dir}` };
  }
  const missing: string[] = [];
  const empty: string[] = [];
  const targets = files ?? readdirSync(dir).filter((f) => f.endsWith(".md"));
  if (assert.includes("nonempty") && targets.length === 0) {
    return { status: "blocked", missing, empty, detail: `no artifacts found in ${dir}` };
  }
  for (const f of targets) {
    const p = join(dir, f);
    if (!existsSync(p)) missing.push(f);
    else if (assert.includes("nonempty") && statSync(p).size === 0) empty.push(f);
  }
  const ok = missing.length === 0 && empty.length === 0;
  return {
    status: ok ? "success" : "blocked",
    missing,
    empty,
    detail: ok ? "ok" : `missing=${missing.join(",")} empty=${empty.join(",")}`,
  };
}
