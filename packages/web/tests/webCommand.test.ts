import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureProfileDir } from "../src/browser/session";
import { loadWebAccessConfig } from "../src/config";
import { handleWebCommand } from "../src/tools";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fh-web-command-test-"));
  process.env.SF_WEB_PROFILES_DIR = path.join(root, "profiles");
});

afterEach(async () => {
  delete process.env.SF_WEB_PROFILES_DIR;
  await rm(root, { force: true, recursive: true });
});

describe("/sf-web command", () => {
  it("lists and clears browser sessions", async () => {
    const config = await loadWebAccessConfig();
    await ensureProfileDir(config, "default");
    await import("../src/browser/session").then((module) =>
      module.writeSessionMetadata(config, "default", { finalUrl: "https://example.com/app", updatedAt: "2026-04-30T00:00:00.000Z" }),
    );

    await expect(handleWebCommand("sessions")).resolves.toContain("default");
    await expect(handleWebCommand("sessions")).resolves.toContain("https://example.com/app");
    await expect(handleWebCommand("clear-session default")).resolves.toContain("requires confirmation");
    await expect(handleWebCommand("clear-session default --yes")).resolves.toContain("removed");
    await expect(handleWebCommand("sessions")).resolves.toContain("No sessions");
  });
});
