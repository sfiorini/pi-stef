import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  fmtTimestamp,
  fmtRecency,
  renderShell,
} from "../../src/server/admin-routes";
import { createApp } from "../../src/server/app";
import { openDb } from "../../src/store/db";
import { SingleAccountPool } from "../../src/pool/single";
import { RequestThrottle } from "../../src/pool/throttle";
import type { AppDeps } from "../../src/server/app";
import type { BaxiaStatus } from "../../src/upstream/baxia-token";

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

// ── Integration tests via createApp ─────────────────────────────────────────

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeStubDeps(adminKey?: string): AppDeps {
  const db = openDb(":memory:");
  const pool = new SingleAccountPool({ log: noopLog });
  return {
    db,
    pool,
    client: {} as any,
    scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
    config: {
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      rateLimitCooldownMs: 86400000,
      emptyCooldownMs: 600_000,
      minRequestGapMs: 0,
      maxConcurrency: 1,
      apiKeyEnv: [],
      modelAliasesRaw: "",
      logLevel: "info",
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
  it("GET /admin?key=test-admin-key returns 200 with HTML", async () => {
    const deps = makeStubDeps("test-admin-key");
    const app = createApp(deps);
    const res = await app.request("/admin?key=test-admin-key");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<html");
    expect(body).toContain("Guest mode");
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

  it("GET /admin renders Baxia section when baxiaStatus provided", async () => {
    const deps = makeStubDeps("test-admin-key");
    const baxia: BaxiaStatus = {
      cached: true,
      cachedAt: Date.now() - 120_000,
      ageMs: 120_000,
      ttlMs: 1_500_000,
      nextRefreshInMs: 1_380_000,
      lastSpawnDurationMs: 3_200,
      consecutiveFailures: 0,
    };
    deps.baxiaStatus = () => baxia;
    const app = createApp(deps);
    const res = await app.request("/admin?key=test-admin-key");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Baxia token cache");
    expect(body).toContain("cached");
  });

  it("GET /admin omits Baxia section when baxiaStatus undefined", async () => {
    const deps = makeStubDeps("test-admin-key");
    const app = createApp(deps);
    const res = await app.request("/admin?key=test-admin-key");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("Baxia token cache");
  });

  it("GET /admin Baxia section shows cold-start marker when not cached", async () => {
    const deps = makeStubDeps("test-admin-key");
    const baxia: BaxiaStatus = {
      cached: false,
      cachedAt: null,
      ageMs: null,
      ttlMs: 1_500_000,
      nextRefreshInMs: null,
      lastSpawnDurationMs: null,
      consecutiveFailures: 0,
    };
    deps.baxiaStatus = () => baxia;
    const app = createApp(deps);
    const res = await app.request("/admin?key=test-admin-key");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Baxia token cache");
    expect(body).toContain("cold start");
  });

  it("GET /admin returns 404 when adminKey unset even with baxiaStatus provided (D15 gate runs first)", async () => {
    const deps = makeStubDeps(undefined);
    deps.baxiaStatus = () => ({
      cached: true,
      cachedAt: Date.now(),
      ageMs: 0,
      ttlMs: 1_500_000,
      nextRefreshInMs: 1_500_000,
      lastSpawnDurationMs: 3_000,
      consecutiveFailures: 0,
    });
    const app = createApp(deps);
    const res = await app.request("/admin");
    expect(res.status).toBe(404);
  });
});
