/**
 * BaxiaTokenManager — Chrome CDP layer for generating Baxia tokens.
 * Spawns headless Chrome, connects via CDP (WebSocket), navigates to
 * chat.qwen.ai, and extracts window.__baxia__ tokens.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { TokenMintError } from "./errors";
import { redactProxyKey } from "./proxy-bridge";
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
  readinessTimeoutMs?: number;
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
  /** Completed requests served through the currently-cached token (reset on each mint). */
  requestsServed: number;
}

// ── CDP session ─────────────────────────────────────────────────────────────

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Deterministic 5-digit fingerprint seed (CloakBrowser --fingerprint range
 *  10000–99999) from a stable string — see startChrome for the rationale. */
export function stableFingerprintSeed(host: string): number {
  // crc32 (IEEE) — tiny table-less implementation, no dependency.
  // Math.imul/>>>0 keep the accumulator unsigned (a naive JS crc32 goes
  // negative on the sign bit, producing out-of-range seeds).
  let crc = 0xffffffff;
  for (let i = 0; i < host.length; i++) {
    crc ^= host.charCodeAt(i);
    for (let k = 0; k < 8; k++) {
      crc = (Math.imul(crc >>> 1, 1) ^ (crc & 1 ? 0xedb88320 : 0)) >>> 0;
    }
  }
  return ((crc ^ 0xffffffff) >>> 0) % 90000 + 10000;
}

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
  private proxyCache = new Map<string, { tokens: BaxiaTokens | null; cachedAt: number | null; lastSpawnDurationMs: number | null; consecutiveFailures: number; requestsServed: number }>();
  private pendingByProxy = new Map<string, Promise<BaxiaTokens>>();
  private lastUsedProxy: string = "";
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly DIRECT_KEY = "";
  private readonly readinessTimeoutMs: number;
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
    this.readinessTimeoutMs = Math.max(5_000, config.readinessTimeoutMs ?? 30_000);
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

    throw new TokenMintError(
      "egress",
      "Chrome not found — set config.chromePath or CHROME_PATH env",
    );
  }

  // ── startChrome ─────────────────────────────────────────────────────────

  /** Stable fingerprint seed per proxy (CloakBrowser --fingerprint=<seed>).
   *
   *  CloakBrowser's default is a RANDOM seed per launch — every mint from a
   *  given exit IP presents a brand-new device (fresh canvas/WebGL/GPU), the
   *  classic detect-farm signature. A seed derived stably from the proxy host
   *  makes each proxy look like a RETURNING visitor on their usual device —
   *  the exact profile of a real user whose guest token expired (CloakBrowser
   *  docs recommend fixed seeds for scoring systems). Cross-proxy separation
   *  falls out for free (nl5 ≠ nl4), burns stay identity-level (fresh
   *  uid/fy/cookie every mint regardless), and vanilla Chromium ignores the
   *  unknown flag (stdio:ignore swallows the warning) so it is passed
   *  unconditionally — no config branch needed.
   *
   *  Deterministic crc32(host) — survives restarts/redeploys, zero state.
   */
  private startChrome(exe: string, proxyServerUrl?: string, upstreamProxy?: string): { child: any; port: number } {
    const port = randomPort(9400, 9999);
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "baxia-chrome-"),
    );
    // Deterministic seed in CloakBrowser's recommended 5-digit range
    // (10000–99999). Derive from the UPSTREAM proxy host — NOT the
    // --proxy-server URL, which in bridge/rotation mode is the LOOPBACK
    // (socks5://127.0.0.1:<port>) shared by every proxy; hashing it would
    // give the whole pool one identical device fingerprint. upstreamProxy
    // carries creds — hash the HOST only. Undefined → "direct" (stable
    // direct-path identity).
    const fpHost = (() => {
      try {
        return upstreamProxy ? new URL(upstreamProxy).hostname : "direct";
      } catch {
        return "direct";
      }
    })();
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
      `--fingerprint=${stableFingerprintSeed(fpHost)}`,
      "--window-size=1280,800",
      `--user-agent=${this.config.userAgent}`,
      "about:blank",
    ];
    // S-M1-7: inject proxy-server + DNS pinning for proxy-affine token gen
    if (proxyServerUrl) {
      args.unshift(`--proxy-server=${proxyServerUrl}`);
      args.unshift("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1");
    }
    const child = (() => {
      try {
        return this._spawn(exe, args, { stdio: "ignore", detached: true });
      } catch (e) {
        throw new TokenMintError(
          "egress",
          `chromium spawn failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
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
      rejectAll(new TokenMintError("egress", "cdp ws error")),
    );
    ws.addEventListener("close", () =>
      rejectAll(new TokenMintError("egress", "cdp ws closed")),
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
    const { child, port } = this.startChrome(exe, proxyServerUrl, proxy);
    this.config.log.info("[baxia-debug] chromium spawn", {
      proxy: redactProxyKey(proxy),
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
        throw new TokenMintError(
          "egress",
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

        // Poll for window.__baxia__.getFYModule to be READY (ceil(readinessTimeoutMs/500) polls, default 30s → 60 polls).
        // Mirrors qwen2api scripts/baxia-token.js: getFYModule is a function-OBJECT
        // whose methods (getUidToken/getFYToken) + fyObj property are attached by the
        // SDK once ready — so DO NOT call getFYModule(); read fm.fyObj/fm.getUidToken()
        // directly. Readiness gate = fm.fyObj exists. Sleep BEFORE each check (gives
        // the page + SDK time to init). Cookies come from document.cookie.
        const baxiaExpr = `(function(){
  var fm = (window.__baxia__||{}).getFYModule;
  if (!fm || !fm.fyObj) return { ready: false, href: location.href };
  var uid='', fy='';
  try { uid = String(fm.getUidToken()); } catch(e) {}
  try { fy = String(fm.getFYToken()); } catch(e) {}
  return { ready: true, href: location.href, uid: uid, fy: fy, cookie: document.cookie || '' };
})()`;

        let baxiaData:
          | { uid: string; fy: string; cookies: string }
          | null = null;
        let lastPageState = "";
        const pollMax = Math.ceil(this.readinessTimeoutMs / 500);
        for (let i = 0; i < pollMax; i++) {
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
                this.config.log.info("[baxia-debug] readiness poll", { poll: i, page: lastPageState.slice(0, 300) });
              } catch { /* page evaluating mid-nav */ }
            }
            const result = await cdp.send("Runtime.evaluate", {
              expression: baxiaExpr,
              returnByValue: true,
            });
            const val = result?.result?.value as
              | {
                  ready: boolean;
                  href?: string;
                  uid?: string;
                  fy?: string;
                  cookie?: string;
                }
              | undefined;
            const href = typeof val?.href === "string" ? val.href : "";
            if (href.startsWith("chrome-error://")) {
              this.config.log.error("[baxia] mint fast-fail — chrome-error page", {
                proxy: redactProxyKey(proxy),
                href: href.slice(0, 120),
              });
              throw new TokenMintError("egress", "page load failed (chrome-error page) — egress unreachable");
            }
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
          } catch (e) {
            if (e instanceof TokenMintError) throw e;
            // evaluation failed, retry
          }
        }

        if (!baxiaData) {
          this.config.log.error(`[baxia-debug] readiness FAILED after ${this.readinessTimeoutMs}ms`, {
            cause: "not-ready",
            proxy: redactProxyKey(proxy),
            lastPage: lastPageState.slice(0, 300),
          });
          throw new TokenMintError(
            "not-ready",
            `window.__baxia__ not ready within ${this.readinessTimeoutMs}ms (page loaded, SDK uninitialized)`,
          );
        }
        this.config.log.info("[baxia-debug] token minted", {
          proxy: redactProxyKey(proxy),
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

  /** Count a completed request against the proxy's currently-cached token (change #7). No-op when no entry. */
  recordRequestServed(proxy?: string): void {
    const key = proxy ?? BaxiaTokenManager.DIRECT_KEY;
    const entry = this.proxyCache.get(key);
    if (entry) entry.requestsServed += 1;
  }

  /** Mark the proxy's cached token burned: drop it so the next ensureToken re-mints.
   *  Logs the measured requests-served count (change #1 + #7). */
  evictToken(proxy?: string): void {
    const key = proxy ?? BaxiaTokenManager.DIRECT_KEY;
    const entry = this.proxyCache.get(key);
    if (!entry) return;
    const now = this.config.now?.() ?? Date.now();
    this.config.log.warn("[baxia] token burned — evicting", {
      proxy: redactProxyKey(proxy),
      requestsServed: entry.requestsServed,
      ageMs: entry.cachedAt != null ? now - entry.cachedAt : null,
    });
    this.proxyCache.set(key, {
      tokens: null,
      cachedAt: null,
      lastSpawnDurationMs: null,
      consecutiveFailures: entry.consecutiveFailures,
      requestsServed: 0,
    });
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
        requestsServed: 0,
      });
      this.lastUsedProxy = key; // SUCCESS only
      return tokens;
    } catch (e) {
      if (e instanceof TokenMintError) {
        this.config.log.error("[baxia] token mint failed", { cause: e.cause, proxy: redactProxyKey(proxy), message: e.message });
      }
      const prev = this.proxyCache.get(key);
      this.proxyCache.set(key, {
        tokens: prev?.tokens ?? null,
        cachedAt: prev?.cachedAt ?? null,
        lastSpawnDurationMs: prev?.lastSpawnDurationMs ?? null,
        consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        requestsServed: prev?.requestsServed ?? 0,
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
      requestsServed: entry?.requestsServed ?? 0,
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
        requestsServed: entry.requestsServed,
      };
    }
    return result;
  }
}


