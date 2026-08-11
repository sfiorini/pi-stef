import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  fmtTimestamp,
  fmtRecency,
  renderShell,
  renderAccountsSection,
  renderTokensSection,
  renderRateLimitsSection,
  renderLoginFailuresSection,
  renderUsageSection,
} from "../../src/server/admin-routes";
import type {
  AdminAccountRow,
  AdminTokenRow,
  AdminRateLimitRow,
  AdminLoginFailureRow,
} from "../../src/store/admin";
import { createApp } from "../../src/server/app";
import { openDb } from "../../src/store/db";
import { reconcileAccounts } from "../../src/store/repo";
import { AccountPool } from "../../src/pool/state";
import { RequestThrottle } from "../../src/pool/throttle";
import type { AppDeps } from "../../src/server/app";

// ── escapeHtml ──────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("neutralizes all 5 special characters", () => {
    const input = `<b>"it's" & fun</b>`;
    const result = escapeHtml(input);
    expect(result).toBe(
      "&lt;b&gt;&quot;it&#39;s&quot; &amp; fun&lt;/b&gt;",
    );
    // Must NOT contain raw special chars
    expect(result).not.toContain("<b>");
    expect(result).not.toContain('"');
    expect(result).not.toContain("'");
    expect(result).not.toContain("& ");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes & first (order matters)", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

// ── fmtTimestamp ─────────────────────────────────────────────────────────────

describe("fmtTimestamp", () => {
  it('returns "—" for null', () => {
    expect(fmtTimestamp(null)).toBe("—");
  });

  it("returns ISO UTC string for a timestamp", () => {
    const ms = Date.UTC(2025, 0, 15, 10, 30, 0); // 2025-01-15T10:30:00.000Z
    expect(fmtTimestamp(ms)).toBe("2025-01-15T10:30:00.000Z");
  });
});

// ── fmtRecency ───────────────────────────────────────────────────────────────

describe("fmtRecency", () => {
  it('returns "just now" for <60s ago', () => {
    const now = Date.now();
    expect(fmtRecency(now - 30_000)).toBe("just now");
  });

  it("returns Xm ago for <60min ago", () => {
    const now = Date.now();
    expect(fmtRecency(now - 300_000)).toBe("5m ago");
  });

  it("returns Xh ago for <24h ago", () => {
    const now = Date.now();
    expect(fmtRecency(now - 7200_000)).toBe("2h ago");
  });

  it("returns Xd ago for >=24h ago", () => {
    const now = Date.now();
    expect(fmtRecency(now - 172_800_000)).toBe("2d ago");
  });
});

// ── renderShell ──────────────────────────────────────────────────────────────

describe("renderShell", () => {
  it("contains auto-poll script with 10000ms interval", () => {
    const html = renderShell("Test Title", "<p>body</p>");
    expect(html).toContain("setInterval");
    expect(html).toContain("10000");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Test Title");
    expect(html).toContain("<p>body</p>");
  });

  it("includes inline styles for state badges", () => {
    const html = renderShell("Test", "");
    expect(html).toContain(".state-active");
    expect(html).toContain(".state-disabled");
  });
});

// ── renderAccountsSection ────────────────────────────────────────────────────

describe("renderAccountsSection", () => {
  it("renders escaped email and state badge", () => {
    const rows: AdminAccountRow[] = [
      { id: 1, email: "a<b>@test.com", ord: 1, state: "active", re_enable_at: null },
    ];
    const html = renderAccountsSection(rows);
    expect(html).toContain("Accounts");
    expect(html).toContain("a&lt;b&gt;@test.com");
    expect(html).toContain("active");
    expect(html).not.toContain("a<b>@test.com");
  });

  it("handles empty array (header only, empty tbody)", () => {
    const html = renderAccountsSection([]);
    expect(html).toContain("Accounts");
    expect(html).toContain("<tbody>");
  });
});

// ── renderTokensSection ──────────────────────────────────────────────────────

describe("renderTokensSection", () => {
  it("renders has_bearer as checkmark/cross", () => {
    const rows: AdminTokenRow[] = [
      { account_id: 1, has_bearer: true, expires_at: null, updated_at: 1000 },
      { account_id: 2, has_bearer: false, expires_at: 5000, updated_at: 2000 },
    ];
    const html = renderTokensSection(rows);
    expect(html).toContain("Tokens");
    expect(html).toContain("✓");
    expect(html).toContain("✗");
  });

  it("renders empty table for no tokens", () => {
    const html = renderTokensSection([]);
    expect(html).toContain("Tokens");
  });
});

// ── renderRateLimitsSection ──────────────────────────────────────────────────

describe("renderRateLimitsSection", () => {
  it("renders rate limit fields", () => {
    const rows: AdminRateLimitRow[] = [
      { account_id: 1, last_429_at: 1000, retry_after_at: 2000, re_enable_at: null, updated_at: 3000 },
    ];
    const html = renderRateLimitsSection(rows);
    expect(html).toContain("Rate Limits");
    expect(html).toContain("1970-01-01T00:00:01.000Z"); // 1000ms
    expect(html).toContain("1970-01-01T00:00:02.000Z"); // 2000ms
    expect(html).toContain("—"); // null re_enable_at
  });
});

// ── renderLoginFailuresSection ───────────────────────────────────────────────

describe("renderLoginFailuresSection", () => {
  it("renders escaped reason", () => {
    const rows: AdminLoginFailureRow[] = [
      { id: 1, account_id: 1, attempted_at: 1000, reason: "<script>alert(1)</script>", status_code: 401 },
    ];
    const html = renderLoginFailuresSection(rows);
    expect(html).toContain("Login Failures");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders empty table for no failures", () => {
    const html = renderLoginFailuresSection([]);
    expect(html).toContain("Login Failures");
  });
});

// ── renderUsageSection ───────────────────────────────────────────────────────

describe("renderUsageSection", () => {
  it("renders usage data per account", () => {
    const accounts: AdminAccountRow[] = [
      { id: 1, email: "a@test.com", ord: 1, state: "active", re_enable_at: null },
    ];
    const failureCounts = [{ account_id: 1, count: 3 }];
    const tokens: AdminTokenRow[] = [
      { account_id: 1, has_bearer: true, expires_at: null, updated_at: Date.now() - 300_000 },
    ];
    const html = renderUsageSection(accounts, failureCounts, tokens);
    expect(html).toContain("Usage");
    expect(html).toContain("a@test.com");
    expect(html).toContain("3"); // failure count
    expect(html).toContain("5m ago"); // token refresh recency
  });
});

// ── Integration tests via createApp ─────────────────────────────────────────

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeStubDeps(adminKey?: string): AppDeps {
  const db = openDb(":memory:");
  reconcileAccounts(db, []);
  const pool = new AccountPool({ db, log: noopLog });
  pool.hydrate();
  return {
    db,
    pool,
    client: {} as any,
    scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
    config: {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      authUrl: "",
      apiUrl: "",
      jwtRefreshMs: 21600000,
      refreshThresholdMs: 21600000,
      loginTimeoutMs: 10000,
      staggerMs: 5000,
      rateLimitCooldownMs: 86400000,
      emptyCooldownMs: 600_000,
      minRequestGapMs: 0,
      reenableIntervalMs: 60000,
      apiKeyEnv: [],
      modelAliasesRaw: "",
      logLevel: "info",
      accounts: [],
      adminKey,
      baxia: { useChromeBaxia: false, chromePath: undefined, cacheTtlMs: 1_500_000, baxiaVersion: "2.5.37", preWarm: false, fallback: false },
    },
    retry: (async () => {}) as any,
    retryStream: (async function* () {}) as any,
    throttle: new RequestThrottle({ minGapMs: 0 }),
    log: noopLog,
  };
}

describe("adminRoutes integration via createApp", () => {
  it("GET /admin?key=test-admin-key returns 200 with escaped HTML", async () => {
    const deps = makeStubDeps("test-admin-key");
    // Seed an account with XSS email
    reconcileAccounts(deps.db, [
      { id: 1, email: "a<b>@test.com", password: "pw", ord: 1 },
    ]);
    // Set account active
    deps.db.prepare("UPDATE accounts SET state = 'active' WHERE id = 1").run();

    const app = createApp(deps);
    const res = await app.request("/admin?key=test-admin-key");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<html");
    expect(body).toContain("a&lt;b&gt;@test.com");
    expect(body).not.toContain("a<b>@test.com");
    expect(body).toContain("Accounts");
    expect(body).toContain("Tokens");
    expect(body).not.toContain("Video Jobs");
  });

  it("GET /admin without auth returns 401", async () => {
    const deps = makeStubDeps("test-admin-key");
    const app = createApp(deps);
    const res = await app.request("/admin");
    expect(res.status).toBe(401);
  });

  it("GET /admin with adminKey undefined returns 404 (D15)", async () => {
    const deps = makeStubDeps(undefined);
    const app = createApp(deps);
    const res = await app.request("/admin");
    expect(res.status).toBe(404);
  });

  it("/admin is absent from OpenAPI document", async () => {
    const deps = makeStubDeps("test-admin-key");
    const app = createApp(deps);
    const doc = (app as any).getOpenAPI31Document({});
    expect(Object.keys(doc.paths ?? {})).not.toContain("/admin");
  });

  it("GET /v1/health still returns 200 (no regression)", async () => {
    const deps = makeStubDeps("test-admin-key");
    const app = createApp(deps);
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);
  });
});
