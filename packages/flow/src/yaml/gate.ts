/**
 * Fail-closed gate predicate (D4). A gate result approves ONLY when it has a
 * string verdict === "APPROVED" AND no blocking findings. Everything else —
 * null, {}, a REVISE with no findings, an APPROVED with a blocking finding —
 * is rejected. Shared by the group loop and the single-phase `until: approved`
 * path so the two can never drift apart.
 */
export interface GateResult {
  verdict?: string;
  findings?: { severity?: string }[];
}

export function gateApproved(
  result: unknown,
  failOn: string[],
): { ok: boolean; reason: string } {
  const r = (result ?? null) as GateResult;
  if (!r || typeof r.verdict !== "string") return { ok: false, reason: "malformed-gate" };
  const blocking = (r.findings ?? []).filter((f) => failOn.includes(f.severity ?? ""));
  if (r.verdict === "APPROVED") {
    return blocking.length
      ? { ok: false, reason: "approved-with-blocking" }
      : { ok: true, reason: "approved" };
  }
  return { ok: false, reason: blocking.length ? "blocking-findings" : "non-approved" };
}
