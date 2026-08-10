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
  renderVideoJobsSection,
  renderUsageSection,
} from "../../src/server/admin-routes";
import type {
  AdminAccountRow,
  AdminTokenRow,
  AdminRateLimitRow,
  AdminLoginFailureRow,
  AdminVideoJobCount,
} from "../../src/store/admin";

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

// ── renderVideoJobsSection ───────────────────────────────────────────────────

describe("renderVideoJobsSection", () => {
  it("renders job counts by status", () => {
    const rows: AdminVideoJobCount[] = [
      { account_id: 1, status: "queued", count: 3 },
      { account_id: 1, status: "succeeded", count: 5 },
    ];
    const html = renderVideoJobsSection(rows);
    expect(html).toContain("Video Jobs");
    expect(html).toContain("queued");
    expect(html).toContain("succeeded");
    expect(html).toContain("3");
    expect(html).toContain("5");
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
    const videoCounts: AdminVideoJobCount[] = [
      { account_id: 1, status: "succeeded", count: 10 },
    ];
    const html = renderUsageSection(accounts, failureCounts, tokens, videoCounts);
    expect(html).toContain("Usage");
    expect(html).toContain("a@test.com");
    expect(html).toContain("3"); // failure count
    expect(html).toContain("5m ago"); // token refresh recency
    expect(html).toContain("10"); // video count
  });
});
