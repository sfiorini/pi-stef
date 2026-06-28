import { describe, it, expect } from "vitest";
import { buildDefaultRegistry } from "../src/ingest/matrix";

describe("buildDefaultRegistry", () => {
  it("includes file adapters for fidelity+boa and direct for coinbase, aggregator stubs available", () => {
    const reg = buildDefaultRegistry();
    expect(reg.get("fidelity")?.providerId).toBe("fidelity");
    expect(reg.get("boa")?.providerId).toBe("boa");
    expect(reg.get("coinbase")?.providerId).toBe("coinbase");
    expect(reg.get("fidelity-snaptrade")).toBeDefined();
    expect(reg.get("boa-simplefin")).toBeDefined();
    expect(reg.get("boa-teller")).toBeDefined();
  });
});
