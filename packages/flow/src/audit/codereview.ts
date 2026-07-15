export const MAX_DIFF_CHARS = 200_000;

/**
 * Build the prompt for the pi-dynamic-workflows /code-review builtin.
 * The builtin fans out 7 finder angles (A/B/C correctness, D/E/F cleanup, G altitude),
 * verifies, dedups, ranks, and synthesizes. We adapt its output to flow's verdict contract.
 */
export function buildCodeReviewPrompt(diff: string, repoRoot: string): string {
  const truncated =
    diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated at " + MAX_DIFF_CHARS + " chars]"
      : diff;
  return [
    `Review the following diff in ${repoRoot}.`,
    ``,
    `Finder angles (run one agent per angle, then verify+synthesize):`,
    `- A/B/C (correctness): line-scan, removed-behavior, cross-file-tracer — tier medium`,
    `- D/E/F (cleanup): reuse, simplification, efficiency — tier small`,
    `- G (altitude): abstraction/design — tier big`,
    ``,
    `Each finding: { severity: P0|P1|P2|P3, file, line, summary, failure_scenario }.`,
    `severity: P0/P1 = must-fix, P2 = should-fix, P3 = consider (non-blocking).`,
    `Return { findings, verdict: APPROVED|REVISE } (APPROVED only if no P0/P1/P2).`,
    ``,
    `DIFF:`,
    truncated,
  ].join("\n");
}
