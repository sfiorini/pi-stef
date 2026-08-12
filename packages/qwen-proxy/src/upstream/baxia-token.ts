/**
 * BaxiaTokenManager — Chrome CDP layer for generating Baxia tokens.
 * Spawns headless Chrome, connects via CDP (WebSocket), navigates to
 * chat.qwen.ai, and extracts window.__baxia__ tokens.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { NetworkError } from "./errors";
import type { Logger } from "../server/logger";

// ── Public types ────────────────────────────────────────────────────────────

export interface BaxiaTokens {
  bxUa: string;
  bxUmidToken: string;
  bxV: string;
  cookies: string;
}

export interface BaxiaTokenManagerConfig {
  useChromeBaxia: boolean;
  chatUrl: string;
  chromePath?: string;
  cacheTtlMs: number;
  baxiaVersion: string;
  fallback: boolean;
  userAgent: string;
  log: Logger;
  now?: () => number;
  spawn?: typeof import("node:child_process").spawn;
  WebSocketCtor?: typeof WebSocket;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface BaxiaStatus {
  cached: boolean;
  cachedAt: number | null;
  ageMs: number | null;
  ttlMs: number;
  nextRefreshInMs: number | null;
  lastSpawnDurationMs: number | null;
  consecutiveFailures: number;
}

// ── CDP session ─────────────────────────────────────────────────────────────

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function randomPort(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const CHROME_CANDIDATES_MACOS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const CHROME_CANDIDATES_LINUX = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
];

const CHROME_CANDIDATES_WIN = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

// ── BaxiaTokenManager ──────────────────────────────────────────────────────

export class BaxiaTokenManager {
  private config: BaxiaTokenManagerConfig;
  private _spawn: typeof import("node:child_process").spawn;
  private _WebSocketCtor: typeof WebSocket;
  private _fetcher: typeof fetch;
  private _sleep: (ms: number) => Promise<void>;

  // Orchestration state
  private cached: BaxiaTokens | null = null;
  private cachedAt = 0;
  private pending: Promise<BaxiaTokens> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private lastSpawnDurationMs: number | null = null;

  constructor(config: BaxiaTokenManagerConfig) {
    this.config = config;
    this._spawn = config.spawn ?? nodeSpawn;
    this._WebSocketCtor = config.WebSocketCtor ?? (globalThis as any).WebSocket;
    this._fetcher = config.fetcher ?? globalThis.fetch;
    this._sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Expose resolved spawn fn for P0 regression testing. */
  getSpawnFn(): typeof import("node:child_process").spawn {
    return this._spawn;
  }

  // ── findChrome ──────────────────────────────────────────────────────────

  private findChrome(): string {
    // 1. Explicit config
    if (this.config.chromePath) return this.config.chromePath;

    // 2. Environment variable
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

    // 3. Platform candidates
    const candidates: string[] =
      process.platform === "darwin"
        ? CHROME_CANDIDATES_MACOS
        : process.platform === "win32"
          ? CHROME_CANDIDATES_WIN
          : CHROME_CANDIDATES_LINUX;

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    throw new Error(
      "Chrome not found — set config.chromePath or CHROME_PATH env",
    );
  }

  // ── startChrome ─────────────────────────────────────────────────────────

  private startChrome(exe: string): { child: any; port: number } {
    const port = randomPort(9400, 9999);
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "baxia-chrome-"),
    );
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,800",
      `--user-agent=${this.config.userAgent}`,
      "about:blank",
    ];
    const child = this._spawn(exe, args, { stdio: "ignore" });
    return { child, port };
  }

  // ── cdpConnect ──────────────────────────────────────────────────────────

  private cdpConnect(wsUrl: string): CdpSession {
    let id = 0;
    const pending = new Map<
      number,
      { resolve: (v: any) => void; reject: (e: Error) => void }
    >();

    const ws = new this._WebSocketCtor(wsUrl);

    // Await the WebSocket OPEN event before any send(): the browser WebSocket
    // throws InvalidStateError ("Sent before connected") if send() is called
    // while still CONNECTING. The unit-test fake mirrors this via readyState.
    let openResolve!: () => void;
    let openReject!: (e: Error) => void;
    const openPromise = new Promise<void>((resolve, reject) => {
      openResolve = resolve;
      openReject = reject;
    });
    let opened = false;

    // GAP-FIX: reject all pending on error/close (and the open promise if not yet open)
    function rejectAll(err: Error) {
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      if (!opened) openReject(err);
    }

    ws.addEventListener("open", () => {
      opened = true;
      openResolve();
    });
    ws.addEventListener("error", () =>
      rejectAll(new NetworkError("cdp ws error")),
    );
    ws.addEventListener("close", () =>
      rejectAll(new Error("cdp ws closed")),
    );

    ws.addEventListener("message", (ev: any) => {
      try {
        const data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        if (data.id !== undefined && pending.has(data.id)) {
          const p = pending.get(data.id)!;
          if (data.error) {
            p.reject(new Error(data.error.message || "cdp error"));
          } else {
            p.resolve(data.result);
          }
          pending.delete(data.id);
        }
      } catch {
        // ignore parse errors
      }
    });

    return {
      async send(method: string, params?: Record<string, unknown>): Promise<any> {
        await openPromise; // rejects on error/close-before-open
        return new Promise((resolve, reject) => {
          const msgId = ++id;
          pending.set(msgId, { resolve, reject });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      async close(): Promise<void> {
        try {
          await openPromise;
          // Close the browser tab/target
          const closeId = ++id;
          ws.send(JSON.stringify({ id: closeId, method: "Target.closeTarget" }));
        } catch {
          // never opened — best effort
        }
        ws.close();
      },
    };
  }

  // ── getBaxiaTokens ──────────────────────────────────────────────────────

  private async getBaxiaTokens(): Promise<BaxiaTokens> {
    const exe = this.findChrome();
    const { child, port } = this.startChrome(exe);

    try {
      // Wait for Chrome to start /json/list endpoint
      let wsUrl: string | null = null;
      for (let i = 0; i < 40; i++) {
        try {
          const res = await this._fetcher(
            `http://127.0.0.1:${port}/json/list`,
          );
          if (res.ok) {
            const list = (await res.json()) as Array<{
              type: string;
              webSocketDebuggerUrl: string;
            }>;
            const page = list.find((e) => e.type === "page");
            if (page) {
              wsUrl = page.webSocketDebuggerUrl;
              break;
            }
          }
        } catch {
          // Chrome not ready yet
        }
        await this._sleep(250);
      }

      if (!wsUrl) {
        throw new NetworkError(
          "Chrome /json/list never returned a page (40×250ms)",
        );
      }

      // Connect via CDP
      const cdp = this.cdpConnect(wsUrl);

      try {
        // Enable required domains
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");

        // Navigate to chat.qwen.ai
        await cdp.send("Page.navigate", { url: this.config.chatUrl });

        // Poll for window.__baxia__ to be available (60 × 500ms = 30s max)
        const baxiaExpr = `JSON.stringify({fy: window.__baxia__?.getFYModule?.()?.getFYToken?.(), uid: window.__baxia__?.getFYModule?.()?.getUidToken?.()})`;

        let baxiaData: { fy: string; uid: string } | null = null;
        for (let i = 0; i < 60; i++) {
          try {
            const result = await cdp.send("Runtime.evaluate", {
              expression: baxiaExpr,
              returnByValue: true,
            });
            if (result?.result?.type === "string" && result.result.value) {
              const parsed = JSON.parse(result.result.value) as {
                fy: string;
                uid: string;
              };
              // Gate: uid must match /^T2gA/i AND length > 20
              if (
                parsed.uid &&
                /^T2gA/i.test(parsed.uid) &&
                parsed.uid.length > 20
              ) {
                baxiaData = parsed;
                break;
              }
            }
          } catch {
            // evaluation failed, retry
          }
          await this._sleep(500);
        }

        if (!baxiaData) {
          throw new Error(
            "window.__baxia__ tokens not available within 30s",
          );
        }

        // Get cookies
        let cookies = "";
        try {
          const cookieResult = await cdp.send("Network.getAllCookies");
          if (cookieResult?.cookies) {
            cookies = cookieResult.cookies
              .map((c: any) => `${c.name}=${c.value}`)
              .join("; ");
          }
        } catch {
          // best-effort cookies
        }

        return {
          bxUa: baxiaData.fy || "231!" + baxiaData.uid,
          bxUmidToken: baxiaData.uid,
          bxV: this.config.baxiaVersion,
          cookies,
        };
      } finally {
        await cdp.close();
      }
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
    }
  }

  // ── Orchestration (S-M1-4) ───────────────────────────────────────────

  async ensureToken(
    opts?: { forceRefresh?: boolean },
  ): Promise<BaxiaTokens> {
    const now = this.config.now?.() ?? Date.now();

    // Cache hit
    if (
      !opts?.forceRefresh &&
      this.cached &&
      now - this.cachedAt < this.config.cacheTtlMs
    ) {
      return this.cached;
    }

    // Single-flight: if a refresh is already in-flight, piggyback on it
    if (this.pending) return this.pending;

    // Start a new refresh (assigned synchronously before any await)
    this.pending = this.doRefresh(now);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  private async doRefresh(now: number): Promise<BaxiaTokens> {
    const start = now;
    try {
      const tokens = await this.getBaxiaTokens();
      this.cached = tokens;
      this.cachedAt = this.config.now?.() ?? Date.now(); // P3: set after token obtained
      this.consecutiveFailures = 0;
      this.lastSpawnDurationMs =
        (this.config.now?.() ?? Date.now()) - start;
      return tokens;
    } catch (e) {
      this.consecutiveFailures++;
      if (this.config.fallback) {
        // Return stale cache if available, otherwise rethrow
        if (this.cached) return this.cached;
      }
      throw e;
    }
  }

  startRefreshLoop(): void {
    if (this.refreshTimer) return; // idempotent
    const interval = Math.max(60_000, this.config.cacheTtlMs - 120_000);
    this.refreshTimer = setInterval(() => {
      this.ensureToken({ forceRefresh: true }).catch(() => {});
    }, interval);
    this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  status(): BaxiaStatus {
    const now = this.config.now?.() ?? Date.now();
    return {
      cached: this.cached !== null,
      cachedAt: this.cached ? this.cachedAt : null,
      ageMs: this.cached ? now - this.cachedAt : null,
      ttlMs: this.config.cacheTtlMs,
      nextRefreshInMs: this.refreshTimer
        ? Math.max(60_000, this.config.cacheTtlMs - 120_000)
        : null,
      lastSpawnDurationMs: this.lastSpawnDurationMs,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}


