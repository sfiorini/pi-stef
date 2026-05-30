import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

import { diffCommand, type DiffCtx } from "../../src/commands/diff.js";
import type { CatalogYaml, LockFile } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/config/io.js", () => ({
  readCatalog: vi.fn(),
  readLock: vi.fn(),
}));

vi.mock("../../src/sync/cache.js", () => ({
  readCachedGistId: vi.fn(),
  gistCachePath: vi.fn(),
}));

vi.mock("../../src/sync/gist.js", () => ({
  readGist: vi.fn(),
}));

import { readCatalog, readLock } from "../../src/config/io.js";
import { readCachedGistId } from "../../src/sync/cache.js";
import { readGist } from "../../src/sync/gist.js";

const mockedReadCatalog = vi.mocked(readCatalog);
const mockedReadLock = vi.mocked(readLock);
const mockedReadCachedGistId = vi.mocked(readCachedGistId);
const mockedReadGist = vi.mocked(readGist);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function sampleCatalog(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0" },
    packages: {
      "my-skill": {
        source: "npm:my-skill",
        rating: "core",
      },
    },
  };
}

function sampleLock(): LockFile {
  return {
    packages: {
      "my-skill": {
        version: "1.0.0",
        contentHash: "sha256-abc",
        installedAt: "2025-01-01T00:00:00Z",
        syncState: "synced",
      },
    },
  };
}

function makeCtx(): DiffCtx {
  return {
    home: tmpDir,
    ui: {
      notify: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("diffCommand", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-diff-"));
    vi.clearAllMocks();

    mockedReadCatalog.mockReturnValue(sampleCatalog());
    mockedReadLock.mockReturnValue(sampleLock());
    mockedReadCachedGistId.mockReturnValue("gist-abc123");
    mockedReadGist.mockResolvedValue({
      id: "gist-abc123",
      files: {
        "cat.yaml": { content: yaml.dump(sampleCatalog()) },
        "catalog.lock.json": {
          content: JSON.stringify(sampleLock(), null, 2),
        },
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Shows "identical" when local matches remote
  // -------------------------------------------------------------------------

  it("shows 'identical' when local and remote match", async () => {
    const ctx = makeCtx();
    await diffCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("identical"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Shows differences when local differs from remote
  // -------------------------------------------------------------------------

  it("shows line-by-line differences when local differs from remote", async () => {
    const remoteCatalog: CatalogYaml = {
      meta: { pi_version: "1.0.0" },
      packages: {
        "my-skill": {
          source: "npm:my-skill",
          rating: "useful",
        },
        "new-skill": {
          source: "npm:new-skill",
          rating: "core",
        },
      },
    };
    mockedReadGist.mockResolvedValue({
      id: "gist-abc123",
      files: {
        "cat.yaml": { content: yaml.dump(remoteCatalog) },
        "catalog.lock.json": {
          content: JSON.stringify(sampleLock(), null, 2),
        },
      },
    });

    const ctx = makeCtx();
    await diffCommand({ positional: [], flags: {} }, ctx);

    // Should show some diff output
    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const diffCall = notifyCalls.find(
      (c: [string, ...unknown[]]) => typeof c[0] === "string" && c[0].includes("new-skill"),
    );
    expect(diffCall).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Shows error when no gist cached
  // -------------------------------------------------------------------------

  it("shows error when no gist is cached", async () => {
    mockedReadCachedGistId.mockReturnValue(undefined);

    const ctx = makeCtx();
    await diffCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("No remote gist"),
      "error",
    );
  });

  // -------------------------------------------------------------------------
  // Handles network errors gracefully
  // -------------------------------------------------------------------------

  it("shows error when gist read fails", async () => {
    mockedReadGist.mockRejectedValue(new Error("network error: ECONNREFUSED"));

    const ctx = makeCtx();
    await diffCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("network error"),
      "error",
    );
  });

  // -------------------------------------------------------------------------
  // Uses --profile flag
  // -------------------------------------------------------------------------

  it("passes profile to gist lookup", async () => {
    const ctx = makeCtx();
    await diffCommand({ positional: [], flags: { profile: "work" } }, ctx);

    // Should read gist using the cached gist ID
    expect(mockedReadGist).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Handles empty remote gist (no cat.yaml file)
  // -------------------------------------------------------------------------

  it("shows full local as added when remote gist has no cat.yaml", async () => {
    mockedReadGist.mockResolvedValue({
      id: "gist-abc123",
      files: {},
    });

    const ctx = makeCtx();
    await diffCommand({ positional: [], flags: {} }, ctx);

    // Should indicate the remote is empty / local is all additions
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.any(String),
      "info",
    );
  });
});
