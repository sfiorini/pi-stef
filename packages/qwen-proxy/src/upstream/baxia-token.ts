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
  chatUrl: string;
  chromePath?: string;
  cacheTtlMs: number;
  baxiaVersion: string;
  fallback: boolean;
  userAgent: string;
  log: Logger;
  /** Optional bridge for proxy-affine token generation (S-M1-7). */
  bridge?: { getPort(): number; setUpstream(key: string): void };
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
  private proxyCache = new Map<string, { tokens: BaxiaTokens | null; cachedAt: number | null; lastSpawnDurationMs: number | null; consecutiveFailures: number }>();
  private pendingByProxy = new Map<string, Promise<BaxiaTokens>>();
  private lastUsedProxy: string = "";
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly DIRECT_KEY = "";
  // Global spawn mutex — serializes all doRefresh calls
  private spawnChain: Promise<void> = Promise.resolve();
  // Optional bridge for proxy-affine token generation (S-M1-7)
  private bridge?: { getPort(): number; setUpstream(key: string): void };

  constructor(config: BaxiaTokenManagerConfig) {
    this.config = config;
    this._spawn = config.spawn ?? nodeSpawn;
    this._WebSocketCtor = config.WebSocketCtor ?? (globalThis as any).WebSocket;
    this._fetcher = config.fetcher ?? globalThis.fetch;
    this._sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.bridge = config.bridge;
  }

  /** Set the bridge for proxy-affine token generation (S-M1-7 / S-M2-2). */
  setBridge(bridge: { getPort(): number; setUpstream(key: string): void }): void {
    this.bridge = bridge;
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

  private startChrome(exe: string, proxyServerUrl?: string): { child: any; port: number } {
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
      // Kill Chromium telemetry/background traffic — each CONNECT through the
      // SOCKS bridge is a full SOCKS5 auth handshake against NordVPN, and
      // Google/telemetry beacons were >50% of all handshakes (observed live:
      // 76 Google/* vs 42 chat.qwen.ai in one hour), tripping NordVPN's
      // per-server credential throttle ("User was rejected by the SOCKS5
      // server"). These flags stop the phone-home; only page-essential
      // traffic remains.
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-domain-reliability",
      "--no-pings",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,MediaRouter",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,800",
      `--user-agent=${this.config.userAgent}`,
      "about:blank",
    ];
    // S-M1-7: inject proxy-server + DNS pinning for proxy-affine token gen
    if (proxyServerUrl) {
      args.unshift(`--proxy-server=${proxyServerUrl}`);
      args.unshift("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1");
    }
    const child = this._spawn(exe, args, { stdio: "ignore", detached: true });
    return { child, port };
  }

  /** Kill the whole Chromium process TREE (not just the main pid). Spawned
   *  with detached:true so the browser forms its own process group; killing
   *  -pid takes down every subprocess. Without this, SIGKILLing only the main
   *  pid orphans the renderer/gpu/pad children → zombie accumulation under
   *  node-as-PID-1 (observed: 79-207 chrome procs after a few spawns). */
  private killChromeTree(child: { pid?: number; kill?: (s?: string) => void }): void {
    // Guard: never group-kill pid 1 (in unit tests the mocked spawn returns
    // pid:1 — process.kill(-1) would kill the TEST process group itself).
    try {
      if (child.pid && child.pid > 1) process.kill(-child.pid, "SIGKILL"); // negative pid = process group
      else child.kill?.("SIGKILL");
    } catch {
      try { child.kill?.("SIGKILL"); } catch { /* already dead */ }
    }
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

  private async getBaxiaTokens(proxy?: string): Promise<BaxiaTokens> {
    const exe = this.findChrome();
    // S-M1-7: compute loopback SOCKS5 URL for proxy-affine token gen
    const proxyServerUrl = (proxy && this.bridge)
      ? `socks5://127.0.0.1:${this.bridge.getPort()}`
      : undefined;
    const { child, port } = this.startChrome(exe, proxyServerUrl);
    this.config.log.info("[baxia-debug] chromium spawn", {
      proxy: proxy ?? "(direct)",
      pid: child.pid,
      port,
      via: proxyServerUrl ?? "direct",
    });

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

        // Poll for window.__baxia__.getFYModule to be READY (60 × 500ms = 30s max).
        // Mirrors qwen2api scripts/baxia-token.js: getFYModule is a function-OBJECT
        // whose methods (getUidToken/getFYToken) + fyObj property are attached by the
        // SDK once ready — so DO NOT call getFYModule(); read fm.fyObj/fm.getUidToken()
        // directly. Readiness gate = fm.fyObj exists. Sleep BEFORE each check (gives
        // the page + SDK time to init). Cookies come from document.cookie.
        const baxiaExpr = `(function(){
  var fm = (window.__baxia__||{}).getFYModule;
  if (!fm || !fm.fyObj) return { ready: false };
  var uid='', fy='';
  try { uid = String(fm.getUidToken()); } catch(e) {}
  try { fy = String(fm.getFYToken()); } catch(e) {}
  return { ready: true, uid: uid, fy: fy, cookie: document.cookie || '' };
})()`;

        let baxiaData:
          | { uid: string; fy: string; cookies: string }
          | null = null;
        let lastPageState = "";
        for (let i = 0; i < 60; i++) {
          await this._sleep(500); // sleep first (qwen2api ordering — lets the SDK init)
          try {
            // Every 10th poll (~5s), capture the page state — reveals CAPTCHA
            // interstitials / error pages / wrong-language redirects instantly.
            if (i % 10 === 0) {
              try {
                const st = await cdp.send("Runtime.evaluate", {
                  expression: "JSON.stringify({href: location.href, title: document.title, bodyLen: document.body ? document.body.innerHTML.length : 0, hasBaxia: !!(window.__baxia__ && window.__baxia__.getFYModule)})",
                  returnByValue: true,
                });
                lastPageState = String((st?.result?.value as string) ?? "");
                this.config.log.warn("[baxia-debug] readiness poll", { poll: i, page: lastPageState.slice(0, 300) });
              } catch { /* page evaluating mid-nav */ }
            }
            const result = await cdp.send("Runtime.evaluate", {
              expression: baxiaExpr,
              returnByValue: true,
            });
            const val = result?.result?.value as
              | {
                  ready: boolean;
                  uid?: string;
                  fy?: string;
                  cookie?: string;
                }
              | undefined;
            if (
              val?.ready &&
              typeof val.uid === "string" &&
              /^T2gA/i.test(val.uid) &&
              val.uid.length > 20
            ) {
              baxiaData = {
                uid: val.uid,
                fy: val.fy ?? "",
                cookies: val.cookie ?? "",
              };
              break;
            }
          } catch {
            // evaluation failed, retry
          }
        }

        if (!baxiaData) {
          this.config.log.error("[baxia-debug] readiness FAILED after 30s", {
            proxy: proxy ?? "(direct)",
            lastPage: lastPageState.slice(0, 300),
          });
          throw new Error(
            "window.__baxia__ tokens not available within 30s",
          );
        }
        this.config.log.info("[baxia-debug] token minted", {
          proxy: proxy ?? "(direct)",
          uidPrefix: baxiaData.uid.slice(0, 8),
          uidLen: baxiaData.uid.length,
          fyLen: baxiaData.fy.length,
          cookieLen: baxiaData.cookies.length,
        });

        return {
          bxUa: baxiaData.fy || "231!" + baxiaData.uid,
          bxUmidToken: baxiaData.uid,
          bxV: this.config.baxiaVersion,
          cookies: baxiaData.cookies,
        };
      } finally {
        await cdp.close();
      }
    } finally {
      this.killChromeTree(child);
    }
  }

  // ── Orchestration (S-M1-5 per-proxy cache) ──────────────────────────

  async ensureToken(
    opts?: { forceRefresh?: boolean; proxy?: string },
  ): Promise<BaxiaTokens> {
    const key = opts?.proxy ?? BaxiaTokenManager.DIRECT_KEY;
    const now = this.config.now?.() ?? Date.now();
    const entry = this.proxyCache.get(key);

    // Cache hit (lazy TTL per key)
    if (
      !opts?.forceRefresh &&
      entry?.tokens &&
      entry.cachedAt != null &&
      now - entry.cachedAt < this.config.cacheTtlMs
    ) {
      return entry.tokens;
    }

    // Single-flight: if a refresh is already in-flight for this proxy, piggyback
    const existing = this.pendingByProxy.get(key);
    if (existing) return existing;

    // Start a new refresh (assigned synchronously before any await)
    const p = this.doRefresh(key);
    this.pendingByProxy.set(key, p);
    try {
      return await p;
    } finally {
      this.pendingByProxy.delete(key);
    }
  }

  private async withSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto spawnChain so new spawns wait for the previous one to settle
    const chained = this.spawnChain.then(fn, fn);
    // Re-chain the settled promise (never rejects — fn is called for both resolve/reject)
    this.spawnChain = chained.then(() => {}, () => {});
    return chained;
  }

  private async doRefresh(key: string): Promise<BaxiaTokens> {
    const proxy = key !== BaxiaTokenManager.DIRECT_KEY ? key : undefined;
    return this.withSpawnLock(async () => {
    const start = this.config.now?.() ?? Date.now();
    try {
      // S-M1-7: set upstream proxy on bridge before spawning Chrome
      if (proxy && this.bridge) {
        this.bridge.setUpstream(proxy);
      }
      const tokens = await this.getBaxiaTokens(proxy);
      this.proxyCache.set(key, {
        tokens,
        cachedAt: this.config.now?.() ?? Date.now(),
        lastSpawnDurationMs: (this.config.now?.() ?? Date.now()) - start,
        consecutiveFailures: 0,
      });
      this.lastUsedProxy = key; // SUCCESS only
      return tokens;
    } catch (e) {
      const prev = this.proxyCache.get(key);
      this.proxyCache.set(key, {
        tokens: prev?.tokens ?? null,
        cachedAt: prev?.cachedAt ?? null,
        lastSpawnDurationMs: prev?.lastSpawnDurationMs ?? null,
        consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
      });
      if (this.config.fallback && prev?.tokens) {
        return prev.tokens;
      }
      throw e;
    }
    });
  }

  startRefreshLoop(): void {
    // S-M1-7: bridge mode uses lazy per-proxy refresh (no periodic loop)
    if (this.bridge) return;
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
    const key = this.lastUsedProxy ?? BaxiaTokenManager.DIRECT_KEY;
    const entry = this.proxyCache.get(key);
    const now = this.config.now?.() ?? Date.now();
    return {
      cached: entry?.tokens != null,
      cachedAt: entry?.cachedAt ?? null,
      ageMs: entry?.cachedAt != null ? now - entry.cachedAt : null,
      ttlMs: this.config.cacheTtlMs,
      nextRefreshInMs: this.refreshTimer
        ? Math.max(60_000, this.config.cacheTtlMs - 120_000)
        : null,
      lastSpawnDurationMs: entry?.lastSpawnDurationMs ?? null,
      consecutiveFailures: entry?.consecutiveFailures ?? 0,
    };
  }

  proxyStatuses(): Record<string, BaxiaStatus> {
    const now = this.config.now?.() ?? Date.now();
    const result: Record<string, BaxiaStatus> = {};
    for (const [key, entry] of this.proxyCache) {
      result[key] = {
        cached: entry.tokens != null,
        cachedAt: entry.cachedAt,
        ageMs: entry.cachedAt != null ? now - entry.cachedAt : null,
        ttlMs: this.config.cacheTtlMs,
        nextRefreshInMs: this.refreshTimer
          ? Math.max(60_000, this.config.cacheTtlMs - 120_000)
          : null,
        lastSpawnDurationMs: entry.lastSpawnDurationMs,
        consecutiveFailures: entry.consecutiveFailures,
      };
    }
    return result;
  }
}


