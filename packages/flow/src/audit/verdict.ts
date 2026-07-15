export type Severity = "P0" | "P1" | "P2" | "P3";
export type Verdict = "APPROVED" | "REVISE";

export interface Finding {
  severity: Severity;
  file: string;
  line: number;
  summary: string;
  failure_scenario: string;
}

export interface AuditResult {
  findings: Finding[];
  verdict: Verdict;
}

/** Lower rank = more severe (P0=0 ... P3=3). */
export function severityRank(s: Severity): number {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[s];
}

/** P0/P1/P2 are blocking; P3 is non-blocking (cosmetic). */
export function isBlocking(s: Severity): boolean {
  return s !== "P3";
}

export interface ParsedVerdict {
  verdict: Verdict | null;
  bySeverity: Record<Severity, string[]>;
  blockingCount: number;
}

/**
 * Parse a reviewer/auditor's free-text report into the P0-P3 + verdict contract.
 * Recognizes `### P0`..`### P3` sections (collecting `- ...` bullets, skipping
 * `- None.`) and a `VERDICT: APPROVED|REVISE` line.
 */
export function parseVerdict(text: string): ParsedVerdict {
  const bySeverity: Record<Severity, string[]> = { P0: [], P1: [], P2: [], P3: [] };
  let current: Severity | null = null;
  let verdict: Verdict | null = null;

  for (const line of text.split("\n")) {
    const header = line.match(/^###\s+(P[0-3])\b/);
    if (header) {
      current = header[1] as Severity;
      continue;
    }
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && current && item[1].trim() !== "None.") {
      bySeverity[current].push(item[1].trim());
    }
    const v = line.match(/VERDICT:\s*(APPROVED|REVISE)/i);
    if (v) verdict = v[1].toUpperCase() as Verdict;
  }

  const blockingCount = bySeverity.P0.length + bySeverity.P1.length + bySeverity.P2.length;
  return { verdict, bySeverity, blockingCount };
}

/**
 * Render an AuditResult in pair's `### P0..P3` + `## Verdict` format.
 * Findings are grouped by severity (highest first) and sorted by line.
 */
export function renderReport(r: AuditResult): string {
  const lines: string[] = ["## Findings"];
  for (const s of ["P0", "P1", "P2", "P3"] as Severity[]) {
    lines.push(`### ${s}`);
    const items = r.findings
      .filter((f) => f.severity === s)
      .sort((a, b) => a.line - b.line);
    if (items.length === 0) {
      lines.push("- None.");
    } else {
      for (const f of items) {
        lines.push(`- ${f.file}:${f.line} — ${f.summary} (scenario: ${f.failure_scenario})`);
      }
    }
  }
  lines.push("## Verdict");
  lines.push(`VERDICT: ${r.verdict}`);
  return lines.join("\n");
}
