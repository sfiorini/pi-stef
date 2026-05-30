import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  profilesCommand,
  profileCommand,
  type ProfilesCtx,
} from "../../src/commands/profiles.js";
import type { CatalogYaml } from "../../src/config/schema.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/config/io.js", () => ({
  readCatalog: vi.fn(),
  writeCatalog: vi.fn(),
}));

import { readCatalog, writeCatalog } from "../../src/config/io.js";

const mockedReadCatalog = vi.mocked(readCatalog);
const mockedWriteCatalog = vi.mocked(writeCatalog);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function catalogWithProfiles(): CatalogYaml {
  return {
    meta: { pi_version: "1.0.0", activeProfile: "work" },
    packages: {
      "base-pkg": { source: "npm:base-pkg", rating: "core" },
    },
    profiles: {
      work: {
        packages: {
          "work-tool": { source: "npm:work-tool", rating: "core" },
        },
      },
      personal: {
        packages: {
          "home-tool": { source: "npm:home-tool", rating: "useful" },
        },
      },
    },
  };
}

function makeCtx(overrides?: Partial<ProfilesCtx>): ProfilesCtx {
  return {
    home: tmpDir,
    ui: {
      notify: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// profilesCommand
// ---------------------------------------------------------------------------

describe("profilesCommand", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-profiles-"));
    vi.clearAllMocks();
    mockedReadCatalog.mockReturnValue(catalogWithProfiles());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists all profiles with active indicator", async () => {
    const ctx = makeCtx();
    await profilesCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const msg = notifyCalls[0][0] as string;
    expect(msg).toContain("default");
    expect(msg).toContain("work");
    expect(msg).toContain("personal");
  });

  it("marks the active profile with an indicator", async () => {
    const ctx = makeCtx();
    await profilesCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const msg = notifyCalls[0][0] as string;
    // "work" should be marked as active
    const lines = msg.split("\n");
    const workLine = lines.find((l: string) => l.includes("work"));
    expect(workLine).toContain("*");
  });

  it("shows default as active when no activeProfile is set", async () => {
    const cat = catalogWithProfiles();
    delete cat.meta.activeProfile;
    mockedReadCatalog.mockReturnValue(cat);

    const ctx = makeCtx();
    await profilesCommand({ positional: [], flags: {} }, ctx);

    const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls;
    const msg = notifyCalls[0][0] as string;
    const lines = msg.split("\n");
    const defaultLine = lines.find((l: string) => l.includes("default"));
    expect(defaultLine).toContain("*");
  });
});

// ---------------------------------------------------------------------------
// profileCommand — switch
// ---------------------------------------------------------------------------

describe("profileCommand — switch", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-profile-"));
    vi.clearAllMocks();
    mockedReadCatalog.mockReturnValue(catalogWithProfiles());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("switches to an existing profile", async () => {
    const ctx = makeCtx();
    await profileCommand(
      { positional: ["personal"], flags: {} },
      ctx,
    );

    expect(mockedWriteCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ activeProfile: "personal" }),
      }),
      tmpDir,
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("personal"),
      "info",
    );
  });

  it("notifies error when switching to nonexistent profile", async () => {
    const ctx = makeCtx();
    await profileCommand(
      { positional: ["nonexistent"], flags: {} },
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      "error",
    );
    expect(mockedWriteCatalog).not.toHaveBeenCalled();
  });

  it("shows current profile when called with no positional args", async () => {
    const ctx = makeCtx();
    await profileCommand({ positional: [], flags: {} }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("work"),
      "info",
    );
  });
});

// ---------------------------------------------------------------------------
// profileCommand — create
// ---------------------------------------------------------------------------

describe("profileCommand — create", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-profile-"));
    vi.clearAllMocks();
    mockedReadCatalog.mockReturnValue(catalogWithProfiles());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new profile with --create flag", async () => {
    const ctx = makeCtx();
    await profileCommand(
      { positional: ["staging"], flags: { create: true } },
      ctx,
    );

    expect(mockedWriteCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: expect.objectContaining({
          staging: { packages: {} },
        }),
      }),
      tmpDir,
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("staging"),
      "info",
    );
  });

  it("notifies error when creating an existing profile", async () => {
    const ctx = makeCtx();
    await profileCommand(
      { positional: ["work"], flags: { create: true } },
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("already exists"),
      "error",
    );
    expect(mockedWriteCatalog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// profileCommand — delete
// ---------------------------------------------------------------------------

describe("profileCommand — delete", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-profile-"));
    vi.clearAllMocks();
    mockedReadCatalog.mockReturnValue(catalogWithProfiles());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes a profile with --delete flag after confirmation", async () => {
    const ctx = makeCtx();
    await profileCommand(
      { positional: ["personal"], flags: { delete: true } },
      ctx,
    );

    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      expect.stringContaining("personal"),
    );
    expect(mockedWriteCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        profiles: expect.not.objectContaining({
          personal: expect.anything(),
        }),
      }),
      tmpDir,
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("personal"),
      "info",
    );
  });

  it("does not delete when confirmation is denied", async () => {
    const ctx = makeCtx({
      ui: {
        notify: vi.fn(),
        confirm: vi.fn().mockResolvedValue(false),
      },
    });

    await profileCommand(
      { positional: ["personal"], flags: { delete: true } },
      ctx,
    );

    expect(ctx.ui.confirm).toHaveBeenCalled();
    expect(mockedWriteCatalog).not.toHaveBeenCalled();
  });

  it("notifies error when deleting nonexistent profile", async () => {
    const ctx = makeCtx();
    await profileCommand(
      { positional: ["nonexistent"], flags: { delete: true } },
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      "error",
    );
    expect(mockedWriteCatalog).not.toHaveBeenCalled();
  });

  it("notifies error when deleting default profile", async () => {
    const ctx = makeCtx();
    await profileCommand(
      { positional: ["default"], flags: { delete: true } },
      ctx,
    );

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Cannot delete"),
      "error",
    );
    expect(mockedWriteCatalog).not.toHaveBeenCalled();
  });
});
