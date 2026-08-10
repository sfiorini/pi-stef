import { describe, it, expect } from "vitest";
import { PoolExhaustedError } from "../../src/pool/errors";

describe("PoolExhaustedError", () => {
  it("has correct name, message, and earliestReEnableAt (number)", () => {
    const err = new PoolExhaustedError(123);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PoolExhaustedError);
    expect(err.name).toBe("PoolExhaustedError");
    expect(err.message).toBe("All accounts rate-limited");
    expect(err.earliestReEnableAt).toBe(123);
  });

  it("round-trips null earliestReEnableAt", () => {
    const err = new PoolExhaustedError(null);
    expect(err.earliestReEnableAt).toBeNull();
    expect(err.name).toBe("PoolExhaustedError");
    expect(err.message).toBe("All accounts rate-limited");
  });
});
