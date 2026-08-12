import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { Logger } from "./logger";
import { adminGate } from "./admin-gate";

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

// ── Dashboard orchestrator ───────────────────────────────────────────────────

/** Minimal guest-mode dashboard (M7 will add baxia status). */
export function renderDashboard(): string {
  return renderShell("qwen-proxy admin", `<h1>qwen-proxy admin</h1><p class="text-muted">Guest mode. Account/token/rate-limit tables removed (M5).</p>`);
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
  app.get("/", (c) => c.html(renderDashboard()));

  return app;
}
