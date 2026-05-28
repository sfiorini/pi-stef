import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearSession, ensureProfileDir, listSessions, profilePath, writeSessionMetadata } from "../src/browser/session";
import type { WebAccessConfig } from "../src/types";

let root = "";
let config: WebAccessConfig;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fh-web-session-test-"));
  config = {
    allowPrivateNetworks: false,
    fetchMaxBytes: 2 * 1024 * 1024,
    fetchTimeoutMs: 1000,
    maxBytes: 1000,
    maxLines: 100,
    maxResults: 5,
    outputDir: path.join(root, "output"),
    profilesDir: path.join(root, "profiles"),
    searchProviders: ["duckduckgo"],
    sensitiveQueryKeys: [],
    userAgent: "sf-test",
  };
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("browser session profiles", () => {
  it("sanitizes profile names and creates private profile directories", async () => {
    const dir = await ensureProfileDir(config, "Team Admin/Profile");

    expect(dir).toBe(path.join(config.profilesDir, "Team-Admin-Profile"));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("lists, locates, and clears sessions with confirmation", async () => {
    const dir = await ensureProfileDir(config, "default");
    await writeSessionMetadata(config, "default", { finalUrl: "https://example.com", updatedAt: "2026-04-30T00:00:00.000Z" });

    expect(profilePath(config, "default")).toBe(dir);
    await expect(readFile(path.join(dir, "sf-session.json"), "utf8")).resolves.toContain("example.com");

    const sessions = await listSessions(config);
    expect(sessions).toMatchObject([{ name: "default", path: dir }]);

    await expect(clearSession(config, "default", false)).rejects.toThrow(/requires confirmation/i);
    await expect(clearSession(config, "default", true)).resolves.toMatchObject({ removed: true, name: "default" });
    expect(await listSessions(config)).toEqual([]);
  });
});
