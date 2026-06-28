import { describe, it, expect } from "vitest";
import { createSnaptradeAdapter } from "../src/ingest/aggregator/snaptrade";

describe("snaptrade adapter", () => {
  it("throws clear error without clientId/secret (no live creds)", async () => {
    const adapter = createSnaptradeAdapter();
    await expect(adapter.authenticate({})).rejects.toThrow(/snaptrade requires/i);
  });
  it("kind/providerId set correctly", () => {
    const adapter = createSnaptradeAdapter();
    expect(adapter.kind).toBe("brokerage");
    expect(adapter.providerId).toBe("fidelity-snaptrade");
  });
});
