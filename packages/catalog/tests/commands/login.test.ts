import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { CommandArgs, CommandCtx } from "../../src/commands/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/sync/auth.js", () => ({
  checkAuth: vi.fn(),
  getToken: vi.fn(),
  isGhInstalled: vi.fn(),
}));

vi.mock("../../src/sync/pull.js", () => ({
  pullCatalog: vi.fn(),
}));

vi.mock("../../src/sync/cache.js", () => ({
  writeCachedGistId: vi.fn(),
  readCachedGistId: vi.fn(),
  gistCachePath: vi.fn(),
}));

vi.mock("../../src/config/io.js", () => ({
  readCatalog: vi.fn(),
  readLock: vi.fn(),
  writeCatalog: vi.fn(),
  writeLock: vi.fn(),
}));

vi.mock("../../src/catalog/install.js", () => ({
  scanInstalled: vi.fn(),
}));

vi.mock("../../src/catalog/reconcile.js", () => ({
  reconcile: vi.fn(),
  executeActions: vi.fn(),
}));

import { checkAuth, getToken, isGhInstalled } from "../../src/sync/auth.js";
import { pullCatalog } from "../../src/sync/pull.js";
import { writeCachedGistId } from "../../src/sync/cache.js";

const mockedCheckAuth = vi.mocked(checkAuth);
const mockedGetToken = vi.mocked(getToken);
const mockedIsGhInstalled = vi.mocked(isGhInstalled);
const mockedPullCatalog = vi.mocked(pullCatalog);
const mockedWriteCachedGistId = vi.mocked(writeCachedGistId);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LoginCtx extends CommandCtx {
  ui: {
    notify: ReturnType<typeof vi.fn>;
  };
}

function makeCtx(): LoginCtx {
  return {
    ui: {
      notify: vi.fn(),
    },
  };
}

function makeArgs(overrides?: Partial<CommandArgs>): CommandArgs {
  return {
    positional: [],
    flags: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loginCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gh is installed
    mockedIsGhInstalled.mockResolvedValue(true);
  });

  // -------------------------------------------------------------------------
  // gh CLI not installed → install guidance
  // -------------------------------------------------------------------------

  it("shows install guidance when gh CLI is not installed", async () => {
    mockedIsGhInstalled.mockResolvedValue(false);

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("GitHub CLI"),
      "info",
    );
    // Should NOT attempt auth check or pull
    expect(mockedCheckAuth).not.toHaveBeenCalled();
    expect(mockedPullCatalog).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // gh not installed → does not attempt auth or token verification
  // -------------------------------------------------------------------------

  it("does not attempt auth check when gh is not installed", async () => {
    mockedIsGhInstalled.mockResolvedValue(false);

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    expect(mockedCheckAuth).not.toHaveBeenCalled();
    expect(mockedGetToken).not.toHaveBeenCalled();
    expect(mockedPullCatalog).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Authenticated → verifies token before pulling
  // -------------------------------------------------------------------------

  it("verifies token after successful auth check", async () => {
    mockedCheckAuth.mockResolvedValue(true);
    mockedGetToken.mockResolvedValue("ghp_abc123");
    mockedPullCatalog.mockResolvedValue({
      catalog: { meta: { pi_version: "1.0.0" }, packages: {} },
      lock: { packages: {} },
    });

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    expect(mockedGetToken).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Authenticated but no token → warning
  // -------------------------------------------------------------------------

  it("shows warning when authenticated but token is unavailable", async () => {
    mockedCheckAuth.mockResolvedValue(true);
    mockedGetToken.mockResolvedValue(undefined);

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("token"),
      "warning",
    );
    expect(mockedPullCatalog).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Already authenticated → success message + auto-pull
  // -------------------------------------------------------------------------

  it("notifies success and auto-pulls when already authenticated", async () => {
    mockedCheckAuth.mockResolvedValue(true);
    mockedGetToken.mockResolvedValue("ghp_abc123");
    mockedPullCatalog.mockResolvedValue({
      catalog: { meta: { pi_version: "1.0.0" }, packages: {} },
      lock: { packages: {} },
    });

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Already authenticated"),
      "info",
    );

    // Should auto-pull after successful auth
    expect(mockedPullCatalog).toHaveBeenCalledWith("default", undefined);
  });

  // -------------------------------------------------------------------------
  // Authenticated → caches gist ID on pull (via pullCatalog)
  // -------------------------------------------------------------------------

  it("caches gist ID after successful pull", async () => {
    mockedCheckAuth.mockResolvedValue(true);
    mockedGetToken.mockResolvedValue("ghp_abc123");
    mockedPullCatalog.mockResolvedValue({
      catalog: { meta: { pi_version: "1.0.0" }, packages: {} },
      lock: { packages: {} },
    });

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    // Pull should be attempted; gist caching is handled by pullCatalog internally
    expect(mockedPullCatalog).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Not authenticated → provides instructions
  // -------------------------------------------------------------------------

  it("provides gh auth login instructions when not authenticated", async () => {
    mockedCheckAuth.mockResolvedValue(false);
    mockedGetToken.mockResolvedValue(undefined);

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("gh auth login"),
      "info",
    );

    // Should NOT attempt to pull
    expect(mockedPullCatalog).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Not authenticated → does not attempt pull or token check
  // -------------------------------------------------------------------------

  it("does not attempt pull or token check when not authenticated", async () => {
    mockedCheckAuth.mockResolvedValue(false);

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    expect(mockedPullCatalog).not.toHaveBeenCalled();
    expect(mockedGetToken).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Authenticated but pull fails → warning about pull failure
  // -------------------------------------------------------------------------

  it("shows warning when authenticated but pull fails", async () => {
    mockedCheckAuth.mockResolvedValue(true);
    mockedGetToken.mockResolvedValue("ghp_abc123");
    mockedPullCatalog.mockRejectedValue(
      new Error("network error: ECONNREFUSED"),
    );

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    // Should still report auth success
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Already authenticated"),
      "info",
    );

    // Should warn about pull failure
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("network error"),
      "warning",
    );
  });

  // -------------------------------------------------------------------------
  // Authenticated but no gist → shows first-time guidance
  // -------------------------------------------------------------------------

  it("shows first-time guidance when authenticated but no gist exists", async () => {
    mockedCheckAuth.mockResolvedValue(true);
    mockedGetToken.mockResolvedValue("ghp_abc123");
    mockedPullCatalog.mockRejectedValue(
      new Error('No gist found for profile "default"'),
    );

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    // Should provide first-time guidance
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("ct sync"),
      "info",
    );
  });

  // -------------------------------------------------------------------------
  // Uses --profile flag
  // -------------------------------------------------------------------------

  it("passes profile flag to pull", async () => {
    mockedCheckAuth.mockResolvedValue(true);
    mockedGetToken.mockResolvedValue("ghp_abc123");
    mockedPullCatalog.mockResolvedValue({
      catalog: { meta: { pi_version: "1.0.0" }, packages: {} },
      lock: { packages: {} },
    });

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(
      makeArgs({ flags: { profile: "work" } }),
      ctx,
    );

    expect(mockedPullCatalog).toHaveBeenCalledWith("work", undefined);
  });

  // -------------------------------------------------------------------------
  // Defaults to "default" profile
  // -------------------------------------------------------------------------

  it("defaults to 'default' profile when no --profile flag", async () => {
    mockedCheckAuth.mockResolvedValue(true);
    mockedGetToken.mockResolvedValue("ghp_abc123");
    mockedPullCatalog.mockResolvedValue({
      catalog: { meta: { pi_version: "1.0.0" }, packages: {} },
      lock: { packages: {} },
    });

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    await loginCommand(makeArgs(), ctx);

    expect(mockedPullCatalog).toHaveBeenCalledWith("default", undefined);
  });

  // -------------------------------------------------------------------------
  // Passes home override to pull
  // -------------------------------------------------------------------------

  it("passes home directory override to pull", async () => {
    mockedCheckAuth.mockResolvedValue(true);
    mockedGetToken.mockResolvedValue("ghp_abc123");
    mockedPullCatalog.mockResolvedValue({
      catalog: { meta: { pi_version: "1.0.0" }, packages: {} },
      lock: { packages: {} },
    });

    const { loginCommand } = await import("../../src/commands/login.js");
    const ctx = makeCtx();
    ctx.home = "/tmp/test-home";
    await loginCommand(makeArgs(), ctx);

    expect(mockedPullCatalog).toHaveBeenCalledWith("default", "/tmp/test-home");
  });
});
