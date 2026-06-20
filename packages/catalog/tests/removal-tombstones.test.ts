import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordRemoval,
  readTombstones,
  applyRemovalTombstones,
} from "../src/catalog/removal-tombstones";

describe("removal tombstones", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "pi-catalog-tombstones-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reads empty when no tombstone file exists", () => {
    expect(readTombstones(tmpHome)).toEqual([]);
  });

  it("records and reads a removal", () => {
    recordRemoval("superpowers-adapter", tmpHome);
    expect(readTombstones(tmpHome)).toEqual(["superpowers-adapter"]);
  });

  it("accumulates multiple removals", () => {
    recordRemoval("pkg-a", tmpHome);
    recordRemoval("pkg-b", tmpHome);
    expect(readTombstones(tmpHome)).toEqual(["pkg-a", "pkg-b"]);
  });

  it("is idempotent — does not duplicate a package name", () => {
    recordRemoval("x", tmpHome);
    recordRemoval("x", tmpHome);
    expect(readTombstones(tmpHome)).toEqual(["x"]);
  });

  it("applyRemovalTombstones drops named packages and clears the log", () => {
    recordRemoval("superpowers-adapter", tmpHome);
    const catalog = {
      meta: { pi_version: "0.0.0" },
      packages: {
        pair: { source: "npm:@pi-stef/pair" },
        "superpowers-adapter": { source: "npm:@pi-stef/superpowers-adapter" },
        team: { source: "npm:@pi-stef/team" },
      },
    };
    applyRemovalTombstones(catalog, tmpHome);
    expect(catalog.packages).toEqual({
      pair: { source: "npm:@pi-stef/pair" },
      team: { source: "npm:@pi-stef/team" },
    });
    // Tombsones are cleared after application — a "re-add remotely"
    // scenario on the next sync won't be silently dropped.
    expect(readTombstones(tmpHome)).toEqual([]);
  });

  it("applyRemovalTombstones is a no-op when no tombstones exist", () => {
    const catalog = {
      meta: { pi_version: "0.0.0" },
      packages: { pair: { source: "npm:@pi-stef/pair" } },
    };
    applyRemovalTombstones(catalog, tmpHome);
    expect(Object.keys(catalog.packages)).toEqual(["pair"]);
    expect(readTombstones(tmpHome)).toEqual([]);
  });
});
