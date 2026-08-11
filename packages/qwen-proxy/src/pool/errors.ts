export class PoolExhaustedError extends Error {
  readonly earliestReEnableAt: number | null;
  constructor(earliestReEnableAt: number | null) {
    super("All accounts rate-limited");
    this.name = "PoolExhaustedError";
    this.earliestReEnableAt = earliestReEnableAt;
  }
}
