import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/store/migrations";
import { getToken } from "../src/store/repo";
import {
  decodeExpiryMs,
  AuthScheduler,
  createInternalLogin,
} from "../src/upstream/auth";
import type { LoginFn, LoginResult, AuthSchedulerDeps } from "../src/upstream/auth";
import type { QwenProxyConfig } from "../src/config/types";
import type { Logger } from "../src/server/logger";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  return db;
}

function makeConfig(overrides: Partial<QwenProxyConfig> = {}): QwenProxyConfig {
  return {
    host: "127.0.0.1",
    port: 7790,
    dbPath: ":memory:",
    authUrl: "https://chat.qwen.ai",
    apiUrl: "https://qwen.aikit.club",
    jwtRefreshMs: 21_600_000,
    refreshThresholdMs: 21_600_000,
    loginTimeoutMs: 10_000,
    staggerMs: 0, // no stagger in tests
    rateLimitCooldownMs: 86_400_000,
    emptyCooldownMs: 600_000,
    minRequestGapMs: 0,    reenableIntervalMs: 60_000,
    apiKeyEnv: [],
    modelAliasesRaw: "",
    logLevel: "info",
    accounts: [
      { id: 1, email: "a@b.com", password: "pw1", ord: 1 },
    ],
    adminKey: undefined,
    baxia: { useChromeBaxia: false, chromePath: undefined, cacheTtlMs: 1_500_000, baxiaVersion: "2.5.37", preWarm: false, fallback: false },
    ...overrides,
  };
}

function makeLogger(): Logger & { warnCalls: unknown[] } {
  const warnCalls: unknown[] = [];
  return {
    info: vi.fn(),
    warn: vi.fn((msg: string, ctx?: unknown) => warnCalls.push({ msg, ctx })),
    error: vi.fn(),
    warnCalls,
  };
}

/**
 * Build a real-looking JWT with a given `exp` claim (seconds).
 * Header: {"alg":"none"}; Payload: {"exp":<sec>}; Signature: empty.
 */
function fakeJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.`;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("decodeExpiryMs", () => {
  it("(5a) returns ms for a real JWT with exp", () => {
    const exp = 1700000000; // seconds
    const token = fakeJwt(exp);
    expect(decodeExpiryMs(token)).toBe(exp * 1000);
  });

  it("(5b) returns null for garbage string", () => {
    expect(decodeExpiryMs("not-a-jwt")).toBeNull();
  });

  it("(5c) returns null for JWT without exp", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "user1" })).toString("base64url");
    const token = `${header}.${payload}.`;
    expect(decodeExpiryMs(token)).toBeNull();
  });
});

describe("AuthScheduler", () => {
  let db: Database.Database;
  let log: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    db = makeMemoryDb();
    log = makeLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Build scheduler deps from a config.
   * Inserts accounts from config into the db.
   */
  function makeSchedulerDeps(
    login: LoginFn,
    configOverrides: Partial<QwenProxyConfig> = {},
  ): AuthSchedulerDeps {
    const cfg = makeConfig(configOverrides);
    // Insert accounts into the db
    const insert = db.prepare(
      "INSERT OR IGNORE INTO accounts (id, email, password, ord) VALUES (?, ?, ?, ?)",
    );
    for (const a of cfg.accounts) {
      insert.run(a.id, a.email, a.password, a.ord);
    }
    return {
      db,
      config: cfg,
      login,
      log,
      now: () => Date.now(),
    };
  }

  it("(1) startup re-login upserts bearer+exp into tokens", async () => {
    const nowMs = 1700000000000;
    vi.setSystemTime(nowMs);
    const exp = Math.floor(nowMs / 1000) + 3600;
    const bearer = fakeJwt(exp);
    const login = vi.fn<(email: string, password: string) => Promise<LoginResult>>().mockResolvedValue({ bearer, expiresAt: exp * 1000 });

    const deps = makeSchedulerDeps(login as unknown as LoginFn);
    const scheduler = new AuthScheduler(deps);

    // start() fires staggered logins via setTimeout(…, 0)
    const startPromise = scheduler.start();
    // Flush the staggered login callbacks
    await vi.advanceTimersByTimeAsync(0);
    await startPromise;

    expect(login).toHaveBeenCalledWith("a@b.com", "pw1");
    const token = getToken(db, 1);
    expect(token).toBeDefined();
    expect(token!.bearer).toBe(bearer);
    expect(token!.expires_at).toBe(exp * 1000);
    scheduler.stop();
  });

  it("(2) JWT timer fires at max(jwtRefreshMs, expiresAt - refreshThresholdMs)", async () => {
    const nowMs = 1700000000000;
    vi.setSystemTime(nowMs);
    const nowSec = nowMs / 1000;

    // Use small time values to keep fake-timer advances manageable.
    // jwtRefreshMs=10s, refreshThresholdMs=5s
    const jwtRefreshMs = 10_000;
    const refreshThresholdMs = 5_000;

    // ── Case A: token expires soon → delay clamps to jwtRefreshMs ──
    // expiresAt = now + 3s → expiresAt - threshold - now = 3s - 5s = -2s
    // max(10s, -2s) = 10s → clamp to jwtRefreshMs
    const expSoonSec = nowSec + 3;
    const bearerSoon = fakeJwt(expSoonSec);
    let loginCountA = 0;
    const loginA = vi.fn<(email: string, password: string) => Promise<LoginResult>>().mockImplementation(async () => {
      loginCountA++;
      return { bearer: bearerSoon, expiresAt: expSoonSec * 1000 };
    });

    const depsA = makeSchedulerDeps(loginA as unknown as LoginFn, {
      accounts: [{ id: 10, email: "a@test.com", password: "pw", ord: 10 }],
      jwtRefreshMs,
      refreshThresholdMs,
    });
    const schedulerA = new AuthScheduler(depsA);
    const startA = schedulerA.start();
    await vi.advanceTimersByTimeAsync(0);
    await startA;
    loginCountA = 0;

    // Advance by less than jwtRefreshMs — should NOT fire yet
    await vi.advanceTimersByTimeAsync(jwtRefreshMs - 1000);
    expect(loginCountA).toBe(0);

    // Advance past jwtRefreshMs — should fire now
    await vi.advanceTimersByTimeAsync(2000);
    expect(loginCountA).toBe(1);
    schedulerA.stop();

    // ── Case B: far-future token → delay is expiresAt-threshold (NOT jwtRefreshMs) ──
    // expiresAt = now + 30s → expiresAt - threshold - now = 30s - 5s = 25s
    // max(10s, 25s) = 25s → the threshold-based delay controls
    schedulerA.stop();
    // Reset fake clock and db to avoid interference from case A
    vi.setSystemTime(nowMs);
    db = makeMemoryDb();
    log = makeLogger();
    const expFarSec = nowSec + 30;
    const bearerFar = fakeJwt(expFarSec);
    let loginCountB = 0;
    const loginB = vi.fn<(email: string, password: string) => Promise<LoginResult>>().mockImplementation(async () => {
      loginCountB++;
      return { bearer: bearerFar, expiresAt: expFarSec * 1000 };
    });

    const depsB = makeSchedulerDeps(loginB as unknown as LoginFn, {
      accounts: [{ id: 11, email: "b@test.com", password: "pw", ord: 11 }],
      jwtRefreshMs,
      refreshThresholdMs,
    });
    const schedulerB = new AuthScheduler(depsB);
    const startB = schedulerB.start();
    await vi.advanceTimersByTimeAsync(0);
    await startB;
    loginCountB = 0;

    // Does NOT fire within jwtRefreshMs even though the scheduled delay is 25s
    await vi.advanceTimersByTimeAsync(jwtRefreshMs - 1000);
    expect(loginCountB).toBe(0);

    // Advances past jwtRefreshMs but still not 25s → still 0
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loginCountB).toBe(0);

    // Now advance to 25s total → should fire
    await vi.advanceTimersByTimeAsync(6_000);
    expect(loginCountB).toBe(1);
    schedulerB.stop();
  });

  it("(2b) long-lived JWT (>24.8d) caps refresh delay at the setTimeout 32-bit max", async () => {
    // Regression: a token expiring in ~30 days yields a raw delay of ~2.57e9 ms,
    // which overflows Node's 32-bit setTimeout (max ~24.8 days / 2^31-1 ms) and
    // would spin at 1ms. The scheduler must cap the delay at MAX_TIMEOUT_MS.
    const nowMs = 1_700_000_000_000;
    vi.setSystemTime(nowMs);
    const nowSec = nowMs / 1000;

    const jwtRefreshMs = 21_600_000; // 6h
    const refreshThresholdMs = 21_600_000; // 6h
    const MAX_TIMEOUT_MS = 2_147_483_000; // mirrors the cap in auth.ts

    // Token expires in 30 days → raw delay = 30d - 6h threshold = 2,570,400,000 ms (> cap)
    const expSec = nowSec + 30 * 86_400;
    const bearer = fakeJwt(expSec);
    let loginCount = 0;
    const login = vi.fn<(email: string, password: string) => Promise<LoginResult>>().mockImplementation(async () => {
      loginCount++;
      return { bearer, expiresAt: expSec * 1000 };
    });

    const deps = makeSchedulerDeps(login as unknown as LoginFn, {
      accounts: [{ id: 20, email: "c@test.com", password: "pw", ord: 20 }],
      jwtRefreshMs,
      refreshThresholdMs,
    });
    const scheduler = new AuthScheduler(deps);
    const start = scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await start;
    loginCount = 0;

    // One ms short of the cap → the capped timer has NOT fired yet
    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS - 1);
    expect(loginCount).toBe(0);

    // Cross the cap → the refresh timer (capped, not the raw ~2.57e9) fires once
    await vi.advanceTimersByTimeAsync(2);
    expect(loginCount).toBe(1);

    scheduler.stop();
  });

  it("(3) non-JWT (expiresAt=null) uses fixed jwtRefreshMs + emits exactly ONE warn", async () => {
    const login = vi.fn<(email: string, password: string) => Promise<LoginResult>>().mockResolvedValue({
      bearer: "opaque-token-not-jwt",
      expiresAt: null,
    });

    const deps = makeSchedulerDeps(login as unknown as LoginFn, {
      accounts: [{ id: 2, email: "c@test.com", password: "pw", ord: 2 }],
      jwtRefreshMs: 10_000,
    });
    const scheduler = new AuthScheduler(deps);
    const startP = scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await startP;

    // Should have warned once about non-JWT
    const nonJwtWarns = log.warnCalls.filter((c: any) =>
      typeof c.msg === "string" && c.msg.includes("not a decodable JWT"),
    );
    expect(nonJwtWarns.length).toBe(1);

    login.mockClear();
    // Advance by jwtRefreshMs — should trigger re-login
    await vi.advanceTimersByTimeAsync(10_000);
    expect(login).toHaveBeenCalledTimes(1);

    // No additional warns should have been emitted
    const nonJwtWarnsAfter = log.warnCalls.filter((c: any) =>
      typeof c.msg === "string" && c.msg.includes("not a decodable JWT"),
    );
    expect(nonJwtWarnsAfter.length).toBe(1); // still exactly one

    scheduler.stop();
  });

  it("(4) refreshOnDemand re-logins and updates the token", async () => {
    const nowMs = 1700000000000;
    vi.setSystemTime(nowMs);
    const exp = Math.floor(nowMs / 1000) + 3600;
    const bearer1 = fakeJwt(exp);
    const bearer2 = fakeJwt(exp + 3600);

    const login = vi.fn<(email: string, password: string) => Promise<LoginResult>>()
      .mockResolvedValueOnce({ bearer: bearer1, expiresAt: exp * 1000 })
      .mockResolvedValueOnce({ bearer: bearer2, expiresAt: (exp + 3600) * 1000 });

    const deps = makeSchedulerDeps(login as unknown as LoginFn, {
      accounts: [{ id: 3, email: "d@test.com", password: "pw", ord: 3 }],
    });
    const scheduler = new AuthScheduler(deps);
    const startP = scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await startP;

    const token1 = getToken(db, 3);
    expect(token1).toBeDefined();
    expect(token1!.bearer).toBe(bearer1);

    const result = await scheduler.refreshOnDemand(3);
    expect(result.bearer).toBe(bearer2);
    const token2 = getToken(db, 3);
    expect(token2!.bearer).toBe(bearer2);
    expect(token2!.expires_at).toBe((exp + 3600) * 1000);

    scheduler.stop();
  });

  it("(7) two concurrent refreshOnDemand for same account → exactly ONE login (mutex)", async () => {
    const nowMs = 1700000000000;
    vi.setSystemTime(nowMs);
    const exp = Math.floor(nowMs / 1000) + 3600;
    const bearer = fakeJwt(exp);

    // LoginFn that resolves after a small async delay
    let loginCallCount = 0;
    const login = vi.fn<(email: string, password: string) => Promise<LoginResult>>().mockImplementation(async () => {
      loginCallCount++;
      // Use thenable to simulate async work
      await Promise.resolve();
      return { bearer, expiresAt: exp * 1000 };
    });

    const deps = makeSchedulerDeps(login as unknown as LoginFn, {
      accounts: [{ id: 4, email: "e@test.com", password: "pw", ord: 4 }],
    });
    const scheduler = new AuthScheduler(deps);
    const startP = scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await startP;

    login.mockClear();
    loginCallCount = 0;

    // Fire two concurrent refreshOnDemand calls
    const p1 = scheduler.refreshOnDemand(4);
    const p2 = scheduler.refreshOnDemand(4);

    // Flush microtasks
    await vi.advanceTimersByTimeAsync(0);
    const [r1, r2] = await Promise.all([p1, p2]);

    // Both should get the same result
    expect(r1.bearer).toBe(bearer);
    expect(r2.bearer).toBe(bearer);

    // But login should have been called exactly ONCE
    expect(login).toHaveBeenCalledTimes(1);
    expect(loginCallCount).toBe(1);

    scheduler.stop();
  });
});

describe("createInternalLogin", () => {
  it("POSTs to /api/v1/auths/signin with SHA-256 hashed password", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const bearer = fakeJwt(exp);

    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: bearer }),
    });

    const config = makeConfig({ authUrl: "https://chat.qwen.ai" });
    const login = createInternalLogin(config, fetcher);

    const result = await login("user@test.com", "mypassword");
    expect(result.bearer).toBe(bearer);
    expect(result.expiresAt).toBe(exp * 1000);

    // Verify the fetch call
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, opts] = fetcher.mock.calls[0];
    expect(url).toBe("https://chat.qwen.ai/api/v1/auths/signin");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.email).toBe("user@test.com");
    // password should be SHA-256 hex of "mypassword"
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256").update("mypassword", "utf8").digest("hex");
    expect(body.password).toBe(expectedHash);
  });
});
