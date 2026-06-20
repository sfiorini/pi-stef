import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readCompanionsFromManifest, resolveCompanions } from "../src/catalog/companions";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("readCompanionsFromManifest", () => {
  it("returns the pi.companions array when present", () => {
    const manifest = { name: "@pi-stef/pair", pi: { companions: ["git:github.com/obra/superpowers"] } };
    expect(readCompanionsFromManifest(manifest)).toEqual(["git:github.com/obra/superpowers"]);
  });

  it("returns empty array when pi.companions is absent", () => {
    expect(readCompanionsFromManifest({ name: "x" })).toEqual([]);
  });

  it("returns empty array when pi is absent", () => {
    expect(readCompanionsFromManifest({})).toEqual([]);
  });

  it("ignores malformed companions (keeps only non-empty strings)", () => {
    const manifest = { pi: { companions: ["git:github.com/obra/superpowers", "", 123 as unknown as string] } };
    expect(readCompanionsFromManifest(manifest)).toEqual(["git:github.com/obra/superpowers"]);
  });
});

describe("resolveCompanions", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pair-comp-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns companions from the installed package.json, excluding already-installed, deduped", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ pi: { companions: ["git:a", "git:b", "git:a"] } }),
    );
    const result = resolveCompanions(dir, new Set(["git:b"]));
    expect(result).toEqual(["git:a"]); // "git:b" excluded, "git:a" deduped
  });

  it("returns [] when no package.json exists", () => {
    expect(resolveCompanions(dir, new Set())).toEqual([]);
  });

  it("returns [] when the manifest has no companions", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(resolveCompanions(dir, new Set())).toEqual([]);
  });

  it("returns [] when package.json is unparseable", () => {
    writeFileSync(join(dir, "package.json"), "{ not json");
    expect(resolveCompanions(dir, new Set())).toEqual([]);
  });
});
