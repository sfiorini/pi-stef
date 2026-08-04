import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveTemplate } from "../paths.js"; // single source of truth (shared with validate.ts)
import { parseTracker } from "../plan/tracker.js";

/** Max length of the description part of a slug (the date prefix is separate). */
const MAX_SLUG_DESC = 60;

/** Cap a kebab string at MAX_SLUG_DESC on a word (hyphen) boundary; hard-cap a
 *  single over-long token so the description is never empty. */
function capKebab(k: string): string {
  if (k.length <= MAX_SLUG_DESC) return k;
  const slice = k.slice(0, MAX_SLUG_DESC);
  const lastHyphen = slice.lastIndexOf("-");
  const trimmed = lastHyphen > 0 ? slice.slice(0, lastHyphen) : slice;
  return trimmed.replace(/-+$/g, "");
}

/** Derive a kebab slug from a source string, optionally date-prefixed. */
export function deriveSlug(source: string, opts: { prefix?: "date" | "none"; now?: Date }): string {
  const raw = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
  const kebab = capKebab(raw);
  if ((opts.prefix ?? "date") === "date") {
    const d = opts.now ?? new Date(); // orchestrator supplies; tests pass explicitly
    const iso = d.toISOString().slice(0, 10);
    return `${iso}-${kebab}`;
  }
  return kebab;
}

/** Max number of description tokens (words) in an orchestrator-supplied slug. */
const MAX_SLUG_TOKENS = 4;

/**
 * Kebab the DESCRIPTION part of a raw slug: strip a leading `YYYY-MM-DD-` date,
 * lowercase, collapse non-alphanumerics to hyphens, trim edges; `"" -> "flow"`.
 * No date, no token cap. Shared by sanitizeRunSlug + slugWasTruncated (DRY).
 */
function kebabDesc(raw: string): string {
  const noDate = raw.replace(/^(\d{4}-\d{2}-\d{2})-/, "");
  const k = noDate.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return k || "flow";
}

/**
 * Sanitize an orchestrator-supplied run slug into the canonical
 * `<YYYY-MM-DD>-<≤4 kebab tokens>` form. The tool OWNS the format:
 *  - PRESERVES a supplied leading `YYYY-MM-DD-` date (the orchestrator's date
 *    is trusted); only prepends today's date when no date prefix is present.
 *  - kebabs the description (lowercase, digits kept), caps to MAX_SLUG_TOKENS.
 *  - empty/garbage description collapses to the "flow" token.
 * `now` is injectable for deterministic tests (used only when no date present).
 */
export function sanitizeRunSlug(
  raw: string,
  opts: { prefix?: "date" | "none"; now?: Date } = {},
): string {
  const dateRe = /^(\d{4}-\d{2}-\d{2})-/;
  const m = raw.match(dateRe);
  const desc = kebabDesc(raw)
    .split("-")
    .filter(Boolean)
    .slice(0, MAX_SLUG_TOKENS)
    .join("-");
  if ((opts.prefix ?? "date") === "none") return desc;
  const date = m ? m[1] : (opts.now ?? new Date()).toISOString().slice(0, 10);
  return `${date}-${desc}`;
}

/** True iff the description part of `raw` has more than MAX_SLUG_TOKENS tokens
 *  (i.e. sanitizeRunSlug would silently drop trailing tokens). Lets sf_flow_auto
 *  surface details.slugTruncated for orchestrator feedback (non-blocking). */
export function slugWasTruncated(raw: string): boolean {
  return kebabDesc(raw).split("-").filter(Boolean).length > MAX_SLUG_TOKENS;
}

/** Decide the run slug from an optional orchestrator-supplied slug plus a
 *  per-kind source string (slugSourceFor(classified)). When the orchestrator
 *  supplies a non-blank slug, sanitize + use it (and report truncation);
 *  otherwise fall back to the deterministic deriveSlug(source). Pure + tested;
 *  sf_flow_auto just wires its params into this. */
export function resolveRunSlug(
  supplied: string | undefined | null,
  source: string,
  opts: { now?: Date } = {},
): { slug: string; truncated: boolean } {
  if (supplied && supplied.trim()) {
    return { slug: sanitizeRunSlug(supplied, { now: opts.now }), truncated: slugWasTruncated(supplied) };
  }
  return { slug: deriveSlug(source, { prefix: "date", now: opts.now }), truncated: false };
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Persist the original run input to `<dir>/prompt.md` so it lives inside the
 * slug folder (ai_plan/<slug>/) — never in the repo root. Called once by
 * sf_flow_auto at run start. Idempotent: writes the same input each call.
 * Returns the prompt path so the tool can surface it to the orchestrator.
 */
export function writeRunPrompt(dir: string, input: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "prompt.md");
  writeFileSync(p, input, "utf8");
  return p;
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
  /** Tracker-specific violations (commit-SHA / progress) when a tracker assert runs. */
  trackerErrors?: string[];
}

/**
 * Assert the artifacts in `dir` satisfy the declared checks:
 * - `nonempty`: every target `.md` exists and is non-empty (empty target set blocks).
 * - `tracker_valid`: `story-tracker.md` parses and every implemented/approved story
 *   carries a commit SHA (legal tracker state).
 * - `tracker_updated`: `tracker_valid` AND at least one story advanced past `pending`
 *   (the tracker reflects work, not just the initial scaffold).
 *
 * With no explicit `files` list, every `.md` in the dir is checked for `nonempty`.
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

  // Tracker assertions (spec §12): parse the main-checkout story-tracker.md.
  const trackerErrors: string[] = [];
  const wantsTracker = assert.some((a) => a === "tracker_valid" || a === "tracker_updated");
  if (wantsTracker) {
    const trackerPath = join(dir, "story-tracker.md");
    if (!existsSync(trackerPath)) {
      trackerErrors.push("story-tracker.md missing");
    } else {
      const t = parseTracker(readFileSync(trackerPath, "utf8"));
      if (!t) {
        trackerErrors.push("story-tracker.md has no story rows");
      } else {
        for (const s of t.stories) {
          if ((s.state === "implemented" || s.state === "approved") && !s.commit) {
            trackerErrors.push(`${s.id}: ${s.state} requires a commit SHA`);
          }
        }
        if (assert.includes("tracker_updated") && !t.stories.some((s) => s.state !== "pending")) {
          trackerErrors.push("tracker not advanced (no story past pending)");
        }
      }
    }
  }

  const ok = missing.length === 0 && empty.length === 0 && trackerErrors.length === 0;
  const issueParts = [
    ...(missing.length ? [`missing=${missing.join(",")}`] : []),
    ...(empty.length ? [`empty=${empty.join(",")}`] : []),
    ...trackerErrors,
  ];
  return {
    status: ok ? "success" : "blocked",
    missing,
    empty,
    detail: ok ? "ok" : issueParts.join("; "),
    ...(trackerErrors.length ? { trackerErrors } : {}),
  };
}
