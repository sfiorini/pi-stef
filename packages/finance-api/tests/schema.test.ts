import { describe, it, expect } from "vitest";
import { MIGRATIONS_V1 } from "../src/store/schema";

describe("schema DDL", () => {
  it("exposes v1 migrations as an ordered, numbered array", () => {
    expect(MIGRATIONS_V1.length).toBeGreaterThan(0);
    for (const m of MIGRATIONS_V1) {
      expect(m.version).toBeGreaterThan(0);
      expect(typeof m.statement).toBe("string");
      expect(m.statement.length).toBeGreaterThan(0);
    }
  });
});
