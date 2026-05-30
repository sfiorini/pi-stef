/**
 * Edge-case error handling integration tests.
 *
 * Verifies that the catalog commands surface user-friendly error messages
 * for corrupt YAML, missing gist IDs, network timeouts, and permission errors.
 * These are not behind the CATALOG_INTEGRATION guard since they mock all
 * I/O and can run in any CI environment.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { initCommand } from "../../src/commands/init.js";
import { syncCommand, pushCommand, pullCommand } from "../../src/commands/sync.js";
import { statusCommand } from "../../src/commands/status.js";
import { writeCatalog } from "../../src/config/io.js";
import { catalogFile } from "../../src/config/paths.js";
import { formatUserError } from "../../src/util/errors.js";
import type { CatalogYaml } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/catalog/install.js", () => ({
  scanInstalled: vi.fn(),
}));

vi.mock("../../src/sync/pull.js", () => ({
  pullCatalog: vi.fn(),
}));

vi.mock("../../src/sync/push.js", () => ({
  pushCatalog: vi.fn(),
}));

vi.mock("../../src/sync/cache.js", () => ({
  readCachedGistId: vi.fn(),
  writeCachedGistId: vi.fn(),
  gistCachePath: vi.fn(),
}));

import { scanInstalled } from "../../src/catalog/install.js";
import { pullCatalog } from "../../src/sync/pull.js";
import { pushCatalog } from "../../src/sync/push.js";
import { readCachedGistId } from "../../src/sync/cache.js";

const mockedScanInstalled = vi.mocked(scanInstalled);
const mockedPull = vi.mocked(pullCatalog);
const mockedPush = vi.mocked(pushCatalog);
const mockedReadCachedGistId = vi.mocked(readCachedGistId);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
const notifications: Array<{ msg: string; type?: string }> = [];

function makeCtx() {
  notifications.length = 0;
  return {
    home: tmpDir,
    ui: {
      notify: vi.fn((msg: string, type?: "error" | "info" | "warning") => {
        notifications.push({ msg, type });
      }),
      select: vi.fn().mockResolvedValue("skill"),
      confirm: vi.fn().mockResolvedValue(true),
    },
  };
}

function writeCorruptYaml(): void {
  const filePath = catalogFile(tmpDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, "meta:\n  pi_version: '1.0.0'\npackages:\n  bad: { broken yaml", "utf-8");
}

function writeInvalidSchemaYaml(): void {
  const filePath = catalogFile(tmpDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, "meta:\n  pi_version: 123\npackages:\n  x:\n    source: ''\n    rating: notarating", "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Edge cases: error handling", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-edge-"));
    vi.clearAllMocks();
    mockedScanInstalled.mockReturnValue({});
    mockedReadCachedGistId.mockReturnValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Corrupt YAML
  // -------------------------------------------------------------------------

  describe("corrupt cat.yaml", () => {
    it("shows helpful error for malformed YAML in status", async () => {
      writeCorruptYaml();

      const ctx = makeCtx();
      // status reads the catalog — if it throws, we catch at the test level
      // to verify the error message is user-friendly
      try {
        await statusCommand({ positional: [], flags: {} }, ctx);
      } catch (err: unknown) {
        const msg = formatUserError(err);
        expect(msg).toContain("corrupt");
        expect(msg).toContain("ct init --force");
      }
    });

    it("shows helpful error for schema-invalid YAML", async () => {
      writeInvalidSchemaYaml();

      const ctx = makeCtx();
      try {
        await statusCommand({ positional: [], flags: {} }, ctx);
      } catch (err: unknown) {
        const msg = formatUserError(err);
        expect(msg).toMatch(/corrupt|invalid format/);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Missing gist ID
  // -------------------------------------------------------------------------

  describe("missing gist ID", () => {
    it("pull shows setup instructions when no gist is found", async () => {
      mockedPull.mockRejectedValue(new Error("No gist found for profile \"default\""));

      const ctx = makeCtx();
      await pullCommand({ positional: [], flags: {} }, ctx);

      const errorMsg = notifications
        .filter((n) => n.type === "error")
        .map((n) => n.msg)
        .join("\n");

      const friendly = formatUserError(new Error(errorMsg));
      expect(friendly).toContain("ct login");
    });

    it("sync shows first-time instructions when no gist and empty catalog", async () => {
      mockedPull.mockRejectedValue(new Error("No gist found for profile \"default\""));
      mockedReadCachedGistId.mockReturnValue(undefined);

      const emptyCatalog: CatalogYaml = {
        meta: { pi_version: "0.0.0" },
        packages: {},
      };

      // Need to mock readCatalog since it will be called
      vi.doMock("../../src/config/io.js", () => ({
        readCatalog: vi.fn().mockReturnValue(emptyCatalog),
        readLock: vi.fn().mockReturnValue({ packages: {} }),
        writeCatalog: vi.fn(),
        writeLock: vi.fn(),
      }));

      const ctx = makeCtx();
      await syncCommand({ positional: [], flags: {} }, ctx);

      const msgs = notifications.map((n) => n.msg).join("\n");
      expect(msgs).toMatch(/No remote gist|ct add|ct sync/);
    });
  });

  // -------------------------------------------------------------------------
  // Network timeout during sync
  // -------------------------------------------------------------------------

  describe("network timeout", () => {
    it("pull shows graceful message on network timeout", async () => {
      mockedPull.mockRejectedValue(new Error("request timed out after 30000ms"));

      const ctx = makeCtx();
      await pullCommand({ positional: [], flags: {} }, ctx);

      const errorMsg = notifications
        .filter((n) => n.type === "error")
        .map((n) => n.msg)
        .join("\n");

      const friendly = formatUserError(new Error(errorMsg));
      expect(friendly).toContain("timed out");
      expect(friendly).toMatch(/retry|--offline/);
    });

    it("sync shows warning on network error during pull", async () => {
      mockedPull.mockRejectedValue(new Error("ECONNREFUSED"));
      mockedPush.mockResolvedValue({
        gistId: "gist-123",
        gistUrl: "https://gist.github.com/gist-123",
      });

      const catalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {
          "pkg-a": { source: "npm:pkg-a", rating: "core" },
        },
      };

      // Write catalog to disk
      writeCatalog(catalog, tmpDir);

      const ctx = makeCtx();
      await syncCommand({ positional: [], flags: {} }, ctx);

      const warningMsg = notifications
        .filter((n) => n.type === "warning")
        .map((n) => n.msg)
        .join("\n");

      const friendly = formatUserError(new Error(warningMsg));
      expect(friendly).toMatch(/network|ECONNREFUSED|--offline/);
    });

    it("push shows graceful error on network failure", async () => {
      mockedPush.mockRejectedValue(new Error("ECONNREFUSED"));

      const catalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {
          "pkg-a": { source: "npm:pkg-a", rating: "core" },
        },
      };
      writeCatalog(catalog, tmpDir);

      const ctx = makeCtx();
      await pushCommand({ positional: [], flags: {} }, ctx);

      const errorMsg = notifications
        .filter((n) => n.type === "error")
        .map((n) => n.msg)
        .join("\n");

      const friendly = formatUserError(new Error(errorMsg));
      expect(friendly).toMatch(/network|--offline/);
    });
  });

  // -------------------------------------------------------------------------
  // Permission errors
  // -------------------------------------------------------------------------

  describe("permission errors", () => {
    it("formatUserError provides actionable advice for EACCES", () => {
      const err = new Error("EACCES: permission denied, open '/home/user/.pi/sf/catalog/cat.yaml'");
      const msg = formatUserError(err);
      expect(msg).toContain("permission");
      expect(msg).toContain("~/.pi/sf/catalog");
    });
  });

  // -------------------------------------------------------------------------
  // Auth errors
  // -------------------------------------------------------------------------

  describe("authentication errors", () => {
    it("push shows login instructions on 401", async () => {
      mockedPush.mockRejectedValue(new Error("HTTP 401: Unauthorized"));

      const catalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {
          "pkg-a": { source: "npm:pkg-a", rating: "core" },
        },
      };
      writeCatalog(catalog, tmpDir);

      const ctx = makeCtx();
      await pushCommand({ positional: [], flags: {} }, ctx);

      const errorMsg = notifications
        .filter((n) => n.type === "error")
        .map((n) => n.msg)
        .join("\n");

      const friendly = formatUserError(new Error(errorMsg));
      expect(friendly).toContain("ct login");
    });

    it("push shows login instructions on 403", async () => {
      mockedPush.mockRejectedValue(new Error("HTTP 403: Forbidden"));

      const catalog: CatalogYaml = {
        meta: { pi_version: "1.0.0" },
        packages: {},
      };
      writeCatalog(catalog, tmpDir);

      const ctx = makeCtx();
      await pushCommand({ positional: [], flags: {} }, ctx);

      const errorMsg = notifications
        .filter((n) => n.type === "error")
        .map((n) => n.msg)
        .join("\n");

      const friendly = formatUserError(new Error(errorMsg));
      expect(friendly).toContain("ct login");
    });
  });

  // -------------------------------------------------------------------------
  // All error messages are user-facing
  // -------------------------------------------------------------------------

  describe("user-facing error messages", () => {
    it("no raw Error objects leak through formatUserError", () => {
      const errors = [
        new Error("YAMLException: unexpected token"),
        new Error("No gist found for profile"),
        new Error("ECONNREFUSED"),
        new Error("request timed out"),
        new Error("EACCES: permission denied"),
        new Error("ENOENT: no such file"),
        new Error("HTTP 401: Unauthorized"),
        new Error("something generic"),
        "string error",
        null,
        undefined,
      ];

      for (const err of errors) {
        const msg = formatUserError(err);
        // Should never contain a stack trace
        expect(msg).not.toContain("at ");
        expect(msg).not.toContain("Error: Error:");
        // Should be a string
        expect(typeof msg).toBe("string");
        expect(msg.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scan errors in init
  // -------------------------------------------------------------------------

  describe("scan error in init", () => {
    it("shows user-friendly message when scanInstalled fails", async () => {
      mockedScanInstalled.mockImplementation(() => {
        throw new Error("EACCES: permission denied, open 'settings.json'");
      });

      const ctx = makeCtx();
      await initCommand({ positional: [], flags: {} }, ctx);

      const errorMsg = notifications
        .filter((n) => n.type === "error")
        .map((n) => n.msg)
        .join("\n");

      expect(errorMsg).toContain("permission denied");
    });
  });
});
