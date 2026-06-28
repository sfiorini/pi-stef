import { describe, it, expect } from "vitest";
import { classifySession } from "../src/market/session";

describe("classifySession", () => {
  // 2026-03-16 is a Monday; all times ET
  it("classifies pre-market, intraday, post-market, closed", () => {
    expect(classifySession(new Date("2026-03-16T11:00:00Z"))).toBe("pre");    // 07:00 ET
    expect(classifySession(new Date("2026-03-16T15:00:00Z"))).toBe("intraday"); // 11:00 ET
    expect(classifySession(new Date("2026-03-16T21:30:00Z"))).toBe("post");   // 17:30 ET
    expect(classifySession(new Date("2026-03-16T01:00:00Z"))).toBe("closed"); // 21:00 prev ET
  });
  it("weekend is closed", () => {
    expect(classifySession(new Date("2026-03-21T15:00:00Z"))).toBe("closed"); // Saturday
  });
});
