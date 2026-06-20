import { describe, it, expect } from "vitest";
import { CatalogPackageSchema } from "../src/config/schema";

describe("CatalogPackageSchema", () => {
  it("accepts an optional companions string array", () => {
    const entry = CatalogPackageSchema.parse({
      source: "git:github.com/obra/superpowers",
      companions: ["git:github.com/obra/superpowers"],
    });
    expect(entry.companions).toEqual(["git:github.com/obra/superpowers"]);
  });

  it("defaults companions to undefined when absent", () => {
    const entry = CatalogPackageSchema.parse({ source: "npm:@pi-stef/pair" });
    expect(entry.companions).toBeUndefined();
  });

  it("rejects non-string companions", () => {
    expect(() =>
      CatalogPackageSchema.parse({ source: "npm:x", companions: [123] }),
    ).toThrow();
  });
});
