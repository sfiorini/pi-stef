/**
 * Summary-based payload composition for impl-review prompts.
 *
 * Background: prior to this module, `tools/implement.ts` passed the FULL
 * staged diff into the reviewer's prompt (round 1) and BOTH the prior diff
 * + the revised diff (round 2+). For a multi-file milestone the prompt
 * could exceed macOS ARG_MAX (~1 MB) — the OS rejected the spawn with
 * `E2BIG` before the reviewer subprocess could start, killing the entire
 * `sf_team_auto` run mid-milestone (the user's M2 round 2 in particular).
 *
 * The fix replaces full-diff payloads with bounded summaries:
 *   - Round 1: developer's narrative `finalText` + `git diff --staged --stat`.
 *   - Round 2+: original impl summary (round 1 verbatim) + prior verdict +
 *     current fix summary (round-N narrative + cumulative diff stat).
 *
 * Three byte caps are mechanically enforced via {@link truncateBytes}:
 *
 *   - {@link IMPL_FINAL_TEXT_CAP_BYTES} (16 KB) — the developer's narrative
 *   - {@link IMPL_DIFF_STAT_CAP_BYTES} (8 KB) — `git diff --staged --stat`
 *   - {@link IMPL_PRIOR_VERDICT_CAP_BYTES} (8 KB) — the prior reviewer verdict
 *
 * Total prompt is bounded at ~75 KB worst case
 * (originalImpl ≤ 24 KB + priorVerdict ≤ 8 KB + currentFix ≤ 24 KB +
 * structural template ≤ 5 KB). Comfortably below any OS argv limit.
 *
 * Truncation is BYTE-aware (not JS-string-length-aware) because the
 * developer's `finalText` typically contains multi-byte UTF-8 characters
 * (checkmarks ✓, em-dashes —, occasionally emoji). When a cap would split
 * a multi-byte sequence, `truncateBytes` rounds DOWN to the previous valid
 * UTF-8 boundary so the result is always valid UTF-8.
 *
 * The transcripts on disk are unchanged: every `<NNNN>-developer-impl-diff-
 * M<X>.md` still contains the full git diff body for human inspection. Only
 * the reviewer-prompt-composition pathway changes.
 */

import { createHash } from "node:crypto";

import { REVIEWER_TDD_POLICY } from "./tdd-policy";

export const IMPL_FINAL_TEXT_CAP_BYTES = 16_384;
export const IMPL_DIFF_STAT_CAP_BYTES = 8_192;
export const IMPL_PRIOR_VERDICT_CAP_BYTES = 8_192;

/**
 * Truncate `s` so its UTF-8 byte length is ≤ `capBytes`. If the cap falls
 * mid-multi-byte sequence, round DOWN to the previous valid UTF-8
 * boundary; the result is always valid UTF-8 and never longer than
 * `capBytes` bytes.
 *
 * Implementation note: Node's `Buffer.from(str, "utf8")` produces a stable
 * byte view; slicing by byte then decoding back via `toString("utf8")`
 * with the default `fatal: false` semantics replaces incomplete trailing
 * bytes with U+FFFD. We avoid that by walking BACKWARDS from the cap to
 * find a byte that is NOT a UTF-8 continuation byte (top bits `10xxxxxx`).
 * That byte position is the start of the next codepoint, so slicing the
 * UTF-8 buffer at the previous codepoint boundary yields valid UTF-8.
 */
export function truncateBytes(s: string, capBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= capBytes) return s;
  let cut = capBytes;
  // A UTF-8 continuation byte has the top two bits 10xxxxxx (0x80-0xBF).
  // Walk back until we find a byte that is NOT a continuation — that's
  // the start of a codepoint, so cutting there preserves valid UTF-8.
  while (cut > 0 && (buf[cut] & 0xC0) === 0x80) cut -= 1;
  return buf.subarray(0, cut).toString("utf8");
}

/**
 * Build the round-1 impl-review payload (also reused as the round-N
 * `currentFixSummary` for revisions): the developer's narrative followed
 * by a labeled diff-stat section. Each component is byte-capped and, on
 * truncation, points the reviewer at the matching transcript file.
 *
 * `label` reflects the semantic meaning of the stat — the caller chooses:
 *   - Round 1: "Files changed by this milestone"
 *   - Round 2+: "Current cumulative file changes (includes the prior round's
 *     work + this round's fix)" — `git diff --staged --stat` is cumulative,
 *     not a delta, and the label must say so honestly.
 */
export function composeImplSummary(args: {
  finalText: string;
  diffStat: string;
  /**
   * Full staged-diff body. NOT embedded into the summary text — used only
   * to compute a 12-char sha256 fingerprint that ends up as a meta line
   * in the summary. The fingerprint guarantees that two summaries with
   * identical narrative + identical stat but different diff content
   * (e.g. a refactor that touches the same files+lines) compare as
   * NON-equal, so `runReviewLoop`'s byte-equal safeguard fires only on
   * actual no-progress revisions, not on coincidental stat collisions.
   * Reviewer treats this as opaque metadata.
   */
  diffBody: string;
  label: string;
  transcriptHints: { implOutputName: string; implDiffName: string };
}): string {
  const finalTextSection = composeFinalTextSection(args.finalText, args.transcriptHints.implOutputName);
  const diffStatSection = composeDiffStatSection(args.diffStat, args.label, args.transcriptHints.implDiffName);
  const fingerprint = createHash("sha256").update(args.diffBody, "utf8").digest("hex").slice(0, 12);
  return `${finalTextSection}\n\n${diffStatSection}\n\n<!-- diff-fingerprint: ${fingerprint} -->`;
}

function composeFinalTextSection(finalText: string, implOutputName: string): string {
  if (finalText.trim().length === 0) {
    return "(developer produced no narrative; see git diff --stat below.)";
  }
  // Use the raw text (NOT trimmed) so leading/trailing whitespace the developer
  // intentionally produced survives. We only check `trim()` for emptiness above.
  const capped = truncateBytes(finalText, IMPL_FINAL_TEXT_CAP_BYTES);
  if (capped.length === finalText.length) return capped;
  return `${capped}\n\n…(truncated at ${IMPL_FINAL_TEXT_CAP_BYTES / 1024} KB; full output in transcript ${implOutputName})`;
}

function composeDiffStatSection(diffStat: string, label: string, implDiffName: string): string {
  const heading = `## ${label}`;
  if (diffStat.trim().length === 0) {
    return `${heading}\n(no staged changes)`;
  }
  // Preserve leading whitespace — `git diff --stat` aligns columns with leading
  // spaces on every line and our reviewer prompt should mirror that.
  const capped = truncateBytes(diffStat, IMPL_DIFF_STAT_CAP_BYTES);
  if (capped.length === diffStat.length) return `${heading}\n${capped}`;
  return `${heading}\n${capped}\n\n…(truncated at ${IMPL_DIFF_STAT_CAP_BYTES / 1024} KB; full diff in transcript ${implDiffName})`;
}

/**
 * Build the round-2+ impl-review prompt. Three labeled sections plus a
 * cwd hint that tells the reviewer it can spot-check files via its
 * read/grep/find/ls tools (which already work in the worktree because
 * spawn now passes `cwd: ctx.cwd` for the reviewer).
 *
 * `priorVerdictText` is byte-capped here (the only one of the three
 * inputs that hasn't already been pre-capped by `composeImplSummary` —
 * the verdict text comes raw from the previous reviewer round).
 *
 * The verdict-shape `## Findings` / `## Verdict` template is appended by
 * `makeReviewer` via `REVIEWER_VERDICT_TEMPLATE`, NOT here. This function
 * returns ONLY the body; the helper concatenates the template afterward.
 */
export function composeImplVerifyFixesPrompt(args: {
  milestoneId: string;
  cwd: string;
  originalImplSummary: string;
  priorVerdictText: string;
  currentFixSummary: string;
  transcriptHints: { priorVerdictName: string };
  tddMode?: "on" | "off" | "auto";
  gitMode?: "on" | "off";
}): string {
  const cappedPriorVerdict = composePriorVerdictSection(args.priorVerdictText, args.transcriptHints.priorVerdictName);
  return [
    `You previously reviewed milestone ${args.milestoneId} and emitted the verdict reproduced below. The developer has revised in response. Your job for THIS review round is NARROW:`,
    "",
    `  1. For each P0/P1/P2 finding from your prior review, decide whether the revision adequately addresses it. Re-cite any finding that is STILL not addressed under the same severity bucket.`,
    `  2. Flag any NEW P0/P1/P2 issue that was DIRECTLY introduced by the revision itself — e.g. a fix that broke an unrelated invariant. Do NOT enumerate issues you could have found in the prior round but did not.`,
    `  3. P3 (cosmetic) findings from the prior round MAY be dropped silently; new P3 regressions need not be reported.`,
    "",
    `Decision rule:`,
    `  - VERDICT: APPROVED — when ALL prior P0/P1/P2 findings are adequately addressed AND the revision introduced no new P0/P1/P2 regressions.`,
    `  - VERDICT: REVISE   — otherwise. List ONLY (a) prior findings that remain unaddressed, plus (b) revision-introduced regressions.`,
    "",
    `If you want to inspect specific files mentioned in the summaries, your read/grep/find/ls tools operate on the current working directory (the worktree at ${args.cwd}); the implementation is staged but NOT yet committed there. Use this for spot-checks; do not enumerate every changed file.`,
    "",
    `--- ORIGINAL IMPLEMENTATION SUMMARY (round 1; unchanged across rounds) ---`,
    args.originalImplSummary,
    `--- END ORIGINAL IMPLEMENTATION SUMMARY ---`,
    "",
    `--- PRIOR VERDICT (the findings you produced last round) ---`,
    cappedPriorVerdict,
    `--- END PRIOR VERDICT ---`,
    "",
    `--- CURRENT FIX SUMMARY (what the developer just revised) ---`,
    args.currentFixSummary,
    `--- END CURRENT FIX SUMMARY ---`,
    REVIEWER_TDD_POLICY({ tddMode: args.tddMode, gitMode: args.gitMode }),
  ].join("\n");
}

function composePriorVerdictSection(priorVerdictText: string, priorVerdictName: string): string {
  const trimmed = priorVerdictText.trim();
  if (trimmed.length === 0) {
    return "(prior reviewer produced no verdict text)";
  }
  const capped = truncateBytes(trimmed, IMPL_PRIOR_VERDICT_CAP_BYTES);
  if (capped.length === trimmed.length) return capped;
  return `${capped}\n\n…(truncated at ${IMPL_PRIOR_VERDICT_CAP_BYTES / 1024} KB; full reviewer verdict in transcript ${priorVerdictName})`;
}
