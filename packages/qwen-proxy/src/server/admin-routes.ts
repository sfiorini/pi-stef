import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { Logger } from "./logger";
import { adminGate } from "./admin-gate";
import {
  listAccountsForAdmin,
  listTokensForAdmin,
  listRateLimitsForAdmin,
  listRecentLoginFailures,
  countVideoJobsByStatus,
  countLoginFailuresByAccount,
  getActiveAccountId,
  type AdminAccountRow,
  type AdminTokenRow,
  type AdminRateLimitRow,
  type AdminLoginFailureRow,
  type AdminVideoJobCount,
} from "../store/admin";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters (XSS prevention).
 * Order: & first (to avoid double-escaping), then <, >, ", '.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format a millisecond timestamp as ISO UTC, or "—" for null. */
export function fmtTimestamp(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toISOString();
}

/** Format a millisecond timestamp as a human-readable recency string. */
export function fmtRecency(ms: number): string {
  const now = Date.now();
  const diffMs = now - ms;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

// ── Shell ────────────────────────────────────────────────────────────────────

/** Full HTML document shell with inline styles and auto-poll script. */
export function renderShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 1rem; background: #f5f5f5; color: #333; }
  h1 { font-size: 1.4rem; margin-bottom: 1rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; border-bottom: 1px solid #ccc; padding-bottom: 0.3rem; }
  table { width: 100%; border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.85rem; margin-bottom: 1rem; }
  th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #eee; }
  th { background: #e8e8e8; font-weight: 600; }
  .banner { padding: 0.5rem; margin-bottom: 1rem; border-radius: 4px; font-weight: 600; }
  .banner-ok { background: #d4edda; color: #155724; }
  .banner-warn { background: #fff3cd; color: #856404; }
  .state-active { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; background: #28a745; color: white; font-size: 0.75rem; }
  .state-disabled { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; background: #6c757d; color: white; font-size: 0.75rem; }
  .text-muted { color: #999; }
  .text-danger { color: #dc3545; }
</style>
</head>
<body>
${body}
<script>setInterval(function(){location.reload();},10000);</script>
</body>
</html>`;
}

// ── Section renderers ────────────────────────────────────────────────────────

/** Render the accounts section. */
export function renderAccountsSection(rows: AdminAccountRow[]): string {
  const badge = (state: string) =>
    state === "active"
      ? '<span class="state-active">active</span>'
      : `<span class="state-disabled">${escapeHtml(state)}</span>`;

  return `<h2>Accounts</h2>
<table>
<thead><tr><th>ID</th><th>Email</th><th>Ord</th><th>State</th><th>Re-enable At</th></tr></thead>
<tbody>
${rows.map((r) => `<tr><td>${r.id}</td><td>${escapeHtml(r.email)}</td><td>${r.ord}</td><td>${badge(r.state)}</td><td>${fmtTimestamp(r.re_enable_at)}</td></tr>`).join("\n")}
</tbody>
</table>`;
}

/** Render the tokens section. */
export function renderTokensSection(rows: AdminTokenRow[]): string {
  return `<h2>Tokens</h2>
<table>
<thead><tr><th>Account</th><th>Bearer</th><th>Expires At</th><th>Last Refresh</th></tr></thead>
<tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${r.account_id}</td><td>${r.has_bearer ? "✓" : "✗"}</td><td>${fmtTimestamp(r.expires_at)}</td><td>${fmtRecency(r.updated_at)}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>`;
}

/** Render the rate limits section. */
export function renderRateLimitsSection(rows: AdminRateLimitRow[]): string {
  return `<h2>Rate Limits</h2>
<table>
<thead><tr><th>Account</th><th>Last 429</th><th>Retry After</th><th>Re-enable At</th><th>Updated</th></tr></thead>
<tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${r.account_id}</td><td>${fmtTimestamp(r.last_429_at)}</td><td>${fmtTimestamp(r.retry_after_at)}</td><td>${fmtTimestamp(r.re_enable_at)}</td><td>${fmtTimestamp(r.updated_at)}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>`;
}

/** Render the recent login failures section. */
export function renderLoginFailuresSection(
  rows: AdminLoginFailureRow[],
): string {
  return `<h2>Login Failures</h2>
<table>
<thead><tr><th>ID</th><th>Account</th><th>Time</th><th>Reason</th><th>Status</th></tr></thead>
<tbody>
${rows
  .map(
    (r) =>
      `<tr><td>${r.id}</td><td>${r.account_id}</td><td>${fmtTimestamp(r.attempted_at)}</td><td>${escapeHtml(r.reason)}</td><td>${r.status_code ?? "—"}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>`;
}

/** Render the video jobs section. */
export function renderVideoJobsSection(rows: AdminVideoJobCount[]): string {
  // Compute totals
  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.status, (totals.get(r.status) ?? 0) + r.count);
  }

  const totalRow = totals.size > 0
    ? `<tr class="text-muted"><td colspan="2"><strong>Total</strong></td>${[...totals.entries()].map(([s, c]) => `<td>${escapeHtml(s)}: ${c}</td>`).join("")}</tr>`
    : "";

  return `<h2>Video Jobs</h2>
<table>
<thead><tr><th>Account</th><th>Status</th><th>Count</th></tr></thead>
<tbody>
${rows.map((r) => `<tr><td>${r.account_id ?? "—"}</td><td>${escapeHtml(r.status)}</td><td>${r.count}</td></tr>`).join("\n")}
${totalRow}
</tbody>
</table>`;
}

/** Render the derived usage section (pure composition, no queries). */
export function renderUsageSection(
  accounts: AdminAccountRow[],
  failureCounts: { account_id: number; count: number }[],
  tokens: AdminTokenRow[],
  videoCounts: AdminVideoJobCount[],
): string {
  const failMap = new Map(failureCounts.map((f) => [f.account_id, f.count]));
  const tokenMap = new Map(tokens.map((t) => [t.account_id, t]));
  // Aggregate video counts per account
  const videoMap = new Map<number, Map<string, number>>();
  for (const v of videoCounts) {
    const aid = v.account_id;
    if (aid === null) continue;
    if (!videoMap.has(aid)) videoMap.set(aid, new Map());
    const m = videoMap.get(aid)!;
    m.set(v.status, (m.get(v.status) ?? 0) + v.count);
  }

  return `<h2>Usage</h2>
<table>
<thead><tr><th>Account</th><th>Email</th><th>Failures (24h)</th><th>Last Token Refresh</th><th>Video Jobs</th></tr></thead>
<tbody>
${accounts
  .map((a) => {
    const fails = failMap.get(a.id) ?? 0;
    const tok = tokenMap.get(a.id);
    const lastRefresh = tok ? fmtRecency(tok.updated_at) : "—";
    const vids = videoMap.get(a.id);
    const vidStr = vids
      ? [...vids.entries()].map(([s, c]) => `${escapeHtml(s)}: ${c}`).join(", ")
      : "—";
    return `<tr><td>${a.id}</td><td>${escapeHtml(a.email)}</td><td>${fails}</td><td>${lastRefresh}</td><td>${vidStr}</td></tr>`;
  })
  .join("\n")}
</tbody>
</table>`;
}

// ── Dashboard orchestrator ───────────────────────────────────────────────────

/** Render the full admin dashboard HTML. */
export function renderDashboard(deps: { db: Database.Database }): string {
  const { db } = deps;

  const accounts = listAccountsForAdmin(db);
  const tokens = listTokensForAdmin(db);
  const rateLimits = listRateLimitsForAdmin(db);
  const loginFailures = listRecentLoginFailures(db);
  const videoJobCounts = countVideoJobsByStatus(db);
  const now = Date.now();
  const failureCounts = countLoginFailuresByAccount(db, now - 86_400_000);

  // Pool snapshot banner
  const activeId = getActiveAccountId(db);
  let banner: string;
  if (activeId !== null) {
    const activeAccount = accounts.find((a) => a.id === activeId);
    const email = activeAccount ? activeAccount.email : "unknown";
    banner = `<div class="banner banner-ok">Active account: #${activeId} (${escapeHtml(email)})</div>`;
  } else {
    banner = `<div class="banner banner-warn">⚠ Pool exhausted — no active account</div>`;
  }

  const body = `${banner}
${renderAccountsSection(accounts)}
${renderTokensSection(tokens)}
${renderRateLimitsSection(rateLimits)}
${renderLoginFailuresSection(loginFailures)}
${renderVideoJobsSection(videoJobCounts)}
${renderUsageSection(accounts, failureCounts, tokens, videoJobCounts)}`;

  return renderShell("qwen-proxy admin", body);
}

// ── Route handler ────────────────────────────────────────────────────────────

export interface AdminRouteDeps {
  db: Database.Database;
  adminKey: string | undefined;
  log: Logger;
}

/**
 * Create the admin dashboard Hono sub-app.
 *
 * Uses plain `new Hono()` (NOT createOpenApiSubApp) so /admin
 * stays out of the OpenAPI registry.
 */
export function adminRoutes(deps: AdminRouteDeps): Hono {
  const app = new Hono();

  // Gate all admin routes
  app.use("/*", adminGate({ adminKey: deps.adminKey }));

  // Dashboard
  app.get("/", (c) => c.html(renderDashboard({ db: deps.db })));

  return app;
}
