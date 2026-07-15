import type { Finding } from "./verdict.js";
import { severityRank } from "./verdict.js";

export type Category = "must-fix" | "should-fix" | "consider";

export function categorize(f: Finding): Category {
  if (f.severity === "P0" || f.severity === "P1") return "must-fix";
  if (f.severity === "P2") return "should-fix";
  return "consider";
}

/** Apply order: must-fix first, then should-fix, then consider (by severity rank). */
export function applyOrder(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}
