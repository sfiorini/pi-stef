import { describe, it, expect } from "vitest";
import { createTellerAdapter } from "../src/ingest/aggregator/teller";

describe("teller adapter", () => {
  it("throws clear error without token (no live creds)", async () => {
    const adapter = createTellerAdapter();
    await expect(adapter.authenticate({})).rejects.toThrow(/teller requires/i);
  });
  it("kind/providerId set correctly", () => {
    const adapter = createTellerAdapter();
    expect(adapter.kind).toBe("banking");
    expect(adapter.providerId).toBe("boa-teller");
  });
});
