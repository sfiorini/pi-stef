import { describe, it, expect } from "vitest";
import { resolveInstalledDir } from "../src/catalog/install";

describe("resolveInstalledDir", () => {
  it("resolves an npm source to the pi-managed node_modules path", () => {
    const dir = resolveInstalledDir("npm:@pi-stef/figma", "/home/u");
    expect(dir).toBe("/home/u/.pi/agent/npm/node_modules/@pi-stef/figma");
  });

  it("returns undefined for a git source (no reverse mapping)", () => {
    expect(resolveInstalledDir("git:github.com/obra/superpowers", "/home/u")).toBeUndefined();
  });

  it("returns undefined for an empty source", () => {
    expect(resolveInstalledDir("", "/home/u")).toBeUndefined();
  });
});
