import type { Finding, Severity } from "./verdict.js";
import { severityRank, isBlocking } from "./verdict.js";

export type VerificationStatus = "FIXED" | "PARTIALLY-FIXED" | "NOT-FIXED" | "NEW-ISSUE-INTRODUCED";

export interface NumberedFinding extends Finding {
  id: string; // "F1","F2",…
}

export interface VerificationEntry {
  ref: string;
  status: VerificationStatus;
  evidence: string;
}

/** Assign F1,F2,… sorted by severityRank (P0=0..P3=3), then file (alpha), then line (asc). Deterministic; does not mutate input. */
export function assignFindingIds(findings: Finding[]): NumberedFinding[] {
  const sorted = [...findings].sort((a, b) => {
    const r = severityRank(a.severity) - severityRank(b.severity);
    if (r !== 0) return r;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
  return sorted.map((fnd, i) => ({ ...fnd, id: `F${i + 1}` }));
}

/** Render the canonical list grouped by severity (skip empty groups). Header "## Canonical Findings (prior round)". */
export function renderCanonicalList(numbered: NumberedFinding[]): string {
  const lines: string[] = ["## Canonical Findings (prior round)"];
  for (const s of ["P0", "P1", "P2", "P3"] as Severity[]) {
    const group = numbered.filter((n) => n.severity === s);
    if (group.length === 0) continue;
    lines.push(`### ${s}`);
    for (const n of group) {
      lines.push(`- [${n.id}] ${n.file}:${n.line} — ${n.summary} (scenario: ${n.failure_scenario})`);
    }
  }
  return lines.join("\n");
}

/**
 * Parse a ## Verification section. Recognizes ### FIXED / PARTIALLY-FIXED / NOT-FIXED /
 * NEW-ISSUE-INTRODUCED and collects "- [Fn] — Evidence: <…>" into one VerificationEntry each.
 * Confined to the ## Verification section (the next top-level "## " header OUTSIDE a code fence):
 * ignores ### P0..P3 and VERDICT:. Returns [] if absent.
 */
export function parseVerification(text: string): VerificationEntry[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+Verification\b/.test(l));
  if (start === -1) return [];
  // find section end = next top-level "## " header OUTSIDE a code fence
  let end = lines.length;
  let fence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fence = !fence;
    if (fence) continue;
    if (/^##\s+/.test(lines[i]) && !/^###\s/.test(lines[i])) { end = i; break; }
  }
  const entries: VerificationEntry[] = [];
  let current: VerificationStatus | null = null;
  fence = false;
  for (const line of lines.slice(start, end)) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const header = line.match(/^###\s+(FIXED|PARTIALLY-FIXED|NOT-FIXED|NEW-ISSUE-INTRODUCED)\b/);
    if (header) { current = header[1] as VerificationStatus; continue; }
    if (/^###\s+P[0-3]\b/.test(line)) { current = null; continue; } // defensive: never bucket under P0..P3
    if (/^VERDICT:/i.test(line)) continue;
    const item = line.match(/^\s*-\s*\[(F\d+)\]\s*[—-]?\s*(.*)$/);
    if (item && current) {
      let evidence = item[2].trim();
      const ev = evidence.match(/^Evidence:\s*(.*)$/i);
      if (ev) evidence = ev[1].trim();
      entries.push({ ref: item[1], status: current, evidence });
    }
  }
  return entries;
}

function toFinding(n: NumberedFinding): Finding {
  return { severity: n.severity, file: n.file, line: n.line, summary: n.summary, failure_scenario: n.failure_scenario };
}

/**
 * Evolve the canonical list. FIXED → drop; NEW-ISSUE-INTRODUCED → drop original (regression arrives via newFindings);
 * PARTIALLY-FIXED / NOT-FIXED → keep; no-entry → keep (conservative). Append all newFindings. Returns plain Finding[].
 */
export function evolveCanonical(
  prior: NumberedFinding[],
  verification: VerificationEntry[],
  newFindings: Finding[],
): Finding[] {
  const statusByRef = new Map<string, VerificationStatus>();
  for (const v of verification) statusByRef.set(v.ref, v.status);
  const kept: Finding[] = [];
  for (const p of prior) {
    const status = statusByRef.get(p.id);
    if (status === "FIXED" || status === "NEW-ISSUE-INTRODUCED") continue;
    kept.push(toFinding(p));
  }
  for (const nf of newFindings) kept.push(nf);
  return kept;
}

/**
 * APPROVED iff every prior BLOCKING (P0/P1/P2) finding is FIXED or NEW-ISSUE-INTRODUCED AND no new blocking
 * regression in newFindings. P3 never blocks. A prior blocking finding with no entry is NOT approved (conservative).
 */
export function verificationApproved(
  prior: NumberedFinding[],
  verification: VerificationEntry[],
  newFindings: Finding[],
): boolean {
  const statusByRef = new Map<string, VerificationStatus>();
  for (const v of verification) statusByRef.set(v.ref, v.status);
  for (const p of prior) {
    if (!isBlocking(p.severity)) continue;
    const status = statusByRef.get(p.id);
    if (status !== "FIXED" && status !== "NEW-ISSUE-INTRODUCED") return false;
  }
  if (newFindings.some((nf) => isBlocking(nf.severity))) return false;
  return true;
}
