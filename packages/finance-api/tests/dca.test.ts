import { describe, it, expect } from "vitest";
import { nextDcaBuy } from "../src/quant/dca";

describe("nextDcaBuy", () => {
  it("returns the next due DCA buy given a cadence and last buy", () => {
    const now = new Date("2026-03-16T15:00:00Z").getTime();
    const last = new Date("2026-02-10T15:00:00Z").getTime();
    const r = nextDcaBuy({ amount: 2000, cadence: "monthly", lastBuyAt: last }, now);
    expect(r.due).toBe(true);
    expect(r.amount).toBe(2000);
  });
});
