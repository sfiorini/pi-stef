export const CHECKLIST_SECTIONS = [
  "Supply Chain & Security",
  "Provenance & Metadata",
  "Law of Demeter",
  "CONVENTIONS Compliance",
  "Scope",
  "Boy Scout Rule",
  "Types & Safety",
  "Test Coverage",
  "Agent Readability",
  "Red Flags",
] as const;

export interface GateCounts {
  passed: number;
  failed: number;
}

/** --gate mode: exit 0 only if ALL pass, else exit 1. */
export function gateExitCode(c: GateCounts): 0 | 1 {
  return c.failed === 0 ? 0 : 1;
}

export interface ScoreInputs {
  total: number;
  mustFix: number;
  shouldFix: number;
}

/** bigpowers quality score: 100 * (total - mustFix - shouldFix) / total. */
export function qualityScore(s: ScoreInputs): number {
  if (s.total === 0) return 100;
  return (100 * (s.total - s.mustFix - s.shouldFix)) / s.total;
}
