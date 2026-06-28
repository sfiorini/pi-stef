import { describe, it, expect } from "vitest";
import { createSimplefinAdapter } from "../src/ingest/aggregator/simplefin";

describe("simplefin adapter", () => {
  it("throws clear error without accessKey (no live creds)", async () => {
    const adapter = createSimplefinAdapter();
    await expect(adapter.authenticate({})).rejects.toThrow(/simplefin requires/i);
  });
  it("kind/providerId set correctly", () => {
    const adapter = createSimplefinAdapter();
    expect(adapter.kind).toBe("banking");
    expect(adapter.providerId).toBe("boa-simplefin");
  });
});
