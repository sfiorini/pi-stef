export const MAX_REVIEW_ITERATIONS = 5;

export interface ReviewerResult {
  score: number;
  mustFix: number;
}

/** Santa-method AND-gate: both reviewers must independently pass. */
export function andGatePasses(a: ReviewerResult, b: ReviewerResult, threshold: number): boolean {
  const passes = (r: ReviewerResult) => r.mustFix === 0 && r.score >= threshold;
  return passes(a) && passes(b);
}

/** Approved only if both pass AND we haven't exceeded the iteration cap. */
export function isApproved(bothPass: boolean, iteration: number): boolean {
  if (iteration > MAX_REVIEW_ITERATIONS) return false;
  return bothPass;
}
