import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import type { BaxiaTokenManagerConfig } from "../../src/upstream/baxia-token";
import { TokenMintError } from "../../src/upstream/errors";

// Auto-mock node:fs so vi.spyOn/vi.mocked works with ESM namespace imports
vi.mock("node:fs");

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * FakeWebSocket that dispatches CDP replies.
 * Records sent messages and auto-replies to known methods.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners: Record<string, Array<(ev: any) => void>> = {};
  sent: any[] = [];
  closed = false;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeWebSocket.CONNECTING;
  private replyMap: Map<string, (id: number, params: any) => any>;

  constructor(
    _url: string,
    replyMap: Map<string, (id: number, params: any) => any>,
  ) {
    this.replyMap = replyMap;
    FakeWebSocket.instances.push(this);
    // Auto-dispatch after construction so addEventListener handlers are attached
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchOpen();
    });
  }

  addEventListener(event: string, handler: (ev: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      // Mirror the browser WebSocket: sending before the OPEN event throws
      // InvalidStateError ("Sent before connected"). cdpConnect must await open.
      throw new Error("InvalidStateError: Sent before connected.");
    }
    const msg = JSON.parse(data);
    this.sent.push(msg);
    const handler = this.replyMap.get(msg.method);
    if (handler) {
      const result = handler(msg.id, msg.params);
      queueMicrotask(() => {
        this.dispatchMessage({ data: JSON.stringify({ id: msg.id, result }) });
      });
    }
  }

  close() {
    this.closed = true;
  }

  // Trigger helpers
  dispatchOpen() {
    for (const h of this.listeners["open"] ?? []) h({});
  }

  dispatchMessage(ev: { data: string }) {
    for (const h of this.listeners["message"] ?? []) h(ev);
  }

  dispatchError(ev?: any) {
    for (const h of this.listeners["error"] ?? []) h(ev ?? new Error("ws error"));
  }

  dispatchClose() {
    for (const h of this.listeners["close"] ?? []) h({});
  }
}

function makeDefaultReplyMap(
  baxiaResult: {
    ready: boolean;
    uid?: string;
    fy?: string;
    cookie?: string;
  } = {
    ready: true,
    uid: "T2gA" + "a".repeat(24),
    fy: "FYFAKE",
    cookie: "c1=v1; c2=v2",
  },
): Map<string, (id: number, params: any) => any> {
  const map = new Map<string, (id: number, params: any) => any>();
  map.set("Page.enable", () => ({}));
  map.set("Runtime.enable", () => ({}));
  map.set("Page.navigate", () => ({ frameId: "f1" }));
  map.set("Runtime.evaluate", (_id, params) => {
    if (params?.expression?.includes("__baxia__")) {
      // Mirrors CDP Runtime.evaluate returnByValue for an object result.
      return { result: { type: "object", value: baxiaResult } };
    }
    return { result: { type: "undefined" } };
  });
  return map;
}

function makeConfig(overrides: Partial<BaxiaTokenManagerConfig> = {}): BaxiaTokenManagerConfig {
  return {
    chatUrl: "https://chat.qwen.ai",
    chromePath: "/usr/bin/fake-chrome",
    cacheTtlMs: 1_500_000,
    baxiaVersion: "2.5.37",
    fallback: false,
    userAgent: "Mozilla/5.0 TestAgent",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("BaxiaTokenManager", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  describe("findChrome", () => {
    it("uses config.chromePath when provided", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const tmpPath = "/tmp/fake-chrome-" + Date.now();

      const replyMap = makeDefaultReplyMap();
      const spawnFn = vi.fn(() => ({ pid: 1, kill: vi.fn() }));
      const fetcherFn = vi.fn(async (url: string) => {
        if (url.includes("/json/list")) {
          return {
            ok: true,
            json: async () => [
              { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      });

      const mgr = new BaxiaTokenManager(
        makeConfig({
          chromePath: tmpPath,
          spawn: spawnFn as any,
          WebSocketCtor: function (url: string) {
            return new FakeWebSocket(url, replyMap) as any;
          } as any,
          fetcher: fetcherFn as any,
          sleep: () => Promise.resolve(),
          now: () => 1000,
        }),
      );

      // Mock existsSync so startChrome doesn't fail on mkdtempSync etc.
      // (just needs to pass findChrome which checks config.chromePath first)
      await mgr.ensureToken();
      // Verify spawn was called with the configured chromePath
      expect(spawnFn).toHaveBeenCalledWith(
        tmpPath,
        expect.arrayContaining(["--headless=new"]),
        expect.any(Object),
      );
    });

    it("throws when no chromePath config and no candidates found", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      // P2: mock fs.existsSync to return false for ALL paths so findChrome
      // deterministically throws "Chrome not found" regardless of what's installed.
      // This makes the test fully hermetic — no real Chrome binary is ever touched.
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const mgr = new BaxiaTokenManager(
        makeConfig({ chromePath: undefined }),
      );
      await expect(mgr.ensureToken()).rejects.toThrow(/Chrome not found/i);
      await expect(mgr.ensureToken()).rejects.toBeInstanceOf(TokenMintError);
      await expect(mgr.ensureToken()).rejects.toMatchObject({ cause: "egress" });
    });

    it("fetcher never returns /json/list → TokenMintError(egress)", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const fetcherFn = vi.fn(async () => ({
        ok: false,
        json: async () => ({}),
      }));
      const replyMap = makeDefaultReplyMap();
      const child = { pid: 1, kill: vi.fn() };

      const mgr = new BaxiaTokenManager(
        makeConfig({
          spawn: vi.fn(() => child) as any,
          WebSocketCtor: function (url: string) {
            return new FakeWebSocket(url, replyMap) as any;
          } as any,
          fetcher: fetcherFn as any,
          sleep: () => Promise.resolve(),
          now: () => 1000,
        }),
      );

      await expect(mgr.ensureToken()).rejects.toMatchObject({ cause: "egress" });
      await expect(mgr.ensureToken()).rejects.toThrow(/never returned a page/i);
    });

    it("sync spawn throw → TokenMintError(egress)", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const replyMap = makeDefaultReplyMap();
      const fetcherFn = vi.fn(async (url: string) => {
        if (url.includes("/json/list")) {
          return {
            ok: true,
            json: async () => [
              { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      });

      const mgr = new BaxiaTokenManager(
        makeConfig({
          spawn: (() => { throw new Error("spawn EACCES"); }) as any,
          WebSocketCtor: function (url: string) {
            return new FakeWebSocket(url, replyMap) as any;
          } as any,
          fetcher: fetcherFn as any,
          sleep: () => Promise.resolve(),
          now: () => 1000,
        }),
      );

      await expect(mgr.ensureToken()).rejects.toMatchObject({ cause: "egress" });
      await expect(mgr.ensureToken()).rejects.toThrow(/chromium spawn failed/i);
    });

    // P0 regression: ensure internal _spawn is a real function, not a module namespace
    it("resolves spawn to a callable function when no spawn is injected (P0 regression)", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      // Construct WITHOUT injecting config.spawn
      const mgr = new BaxiaTokenManager(
        makeConfig({
          spawn: undefined as any,
          chromePath: "/nonexistent/chrome",
        }),
      );
      // Access the exposed getter to verify it resolved to a real function
      // (the P0 bug assigned the child_process MODULE NAMESPACE instead)
      const spawnFn = (mgr as any).getSpawnFn();
      expect(typeof spawnFn).toBe("function");
    });
  });

  describe("cdpConnect", () => {
    it("rejects pending on ws error (GAP-FIX)", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const replyMap = makeDefaultReplyMap();

      const mgr = new BaxiaTokenManager(
        makeConfig({
          spawn: vi.fn(() => ({
            pid: 1, kill: vi.fn(),
          })) as any,
          WebSocketCtor: function (url: string) {
            const ws = new FakeWebSocket(url, replyMap);
            // Override: fire error synchronously inside open handler
            // so it rejects pending promises before CDP replies arrive
            const origAddEventListener = ws.addEventListener.bind(ws);
            ws.addEventListener = (event: string, handler: (ev: any) => void) => {
              origAddEventListener(event, handler);
              if (event === "open") {
                // Queue error handler to run right after open completes
                queueMicrotask(() => {
                  ws.dispatchError(new Error("connection refused"));
                });
              }
              if (event === "error") {
                // When a send triggers cdpConnect, the WS send goes first,
                // then the error fires in a microtask
              }
            };
            // Also patch send to fire error BEFORE the reply (queueMicrotask FIFO)
            const origSend = ws.send.bind(ws);
            let firstSend = true;
            ws.send = (data: string) => {
              if (firstSend) {
                firstSend = false;
                // Queue error BEFORE origSend queues the reply
                queueMicrotask(() => {
                  ws.dispatchError(new Error("connection refused"));
                });
              }
              origSend(data);
            };
            return ws as any;
          } as any,
          fetcher: vi.fn(async () => ({
            ok: true,
            json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }],
          })) as any,
          sleep: () => Promise.resolve(),
          now: () => 1000,
        }),
      );

      // GAP-FIX: the error handler rejects all pending CDP promises
      await expect(mgr.ensureToken()).rejects.toThrow(/cdp ws error/i);
      await expect(mgr.ensureToken()).rejects.toBeInstanceOf(TokenMintError);
      await expect(mgr.ensureToken()).rejects.toMatchObject({ cause: "egress" });
    });

    it("rejects pending on ws close (GAP-FIX)", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const replyMap = makeDefaultReplyMap();

      const mgr = new BaxiaTokenManager(
        makeConfig({
          spawn: vi.fn(() => ({
            pid: 1, kill: vi.fn(),
          })) as any,
          WebSocketCtor: function (url: string) {
            const ws = new FakeWebSocket(url, replyMap);
            // Patch send to fire close BEFORE the reply (queueMicrotask FIFO)
            const origSend = ws.send.bind(ws);
            let firstSend = true;
            ws.send = (data: string) => {
              if (firstSend) {
                firstSend = false;
                // Queue close BEFORE origSend queues the reply
                queueMicrotask(() => {
                  ws.dispatchClose();
                });
              }
              origSend(data);
            };
            return ws as any;
          } as any,
          fetcher: vi.fn(async () => ({
            ok: true,
            json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }],
          })) as any,
          sleep: () => Promise.resolve(),
          now: () => 1000,
        }),
      );

      await expect(mgr.ensureToken()).rejects.toThrow(/cdp ws closed/i);
      await expect(mgr.ensureToken()).rejects.toBeInstanceOf(TokenMintError);
      await expect(mgr.ensureToken()).rejects.toMatchObject({ cause: "egress" });
    });
  });

  describe("getBaxiaTokens", () => {
    it("extracts bxUa=fy, bxUmidToken=uid, bxV=config version, gates /^T2gA/ len>20", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const replyMap = makeDefaultReplyMap();
      FakeWebSocket.instances = [];

      const spawnFn = vi.fn(() => ({
        pid: 1,
        kill: vi.fn(),
      }));

      const fetcherFn = vi.fn(async (url: string) => {
        if (url.includes("/json/list")) {
          return {
            ok: true,
            json: async () => [
              { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      });

      const mgr = new BaxiaTokenManager(
        makeConfig({
          spawn: spawnFn as any,
          WebSocketCtor: function (url: string) {
            return new FakeWebSocket(url, replyMap) as any;
          } as any,
          fetcher: fetcherFn as any,
          sleep: () => Promise.resolve(),
          now: () => 1000,
        }),
      );

      const tokens = await mgr.ensureToken();
      expect(tokens.bxUa).toBe("FYFAKE");
      expect(tokens.bxUmidToken).toMatch(/^T2gA/);
      expect(tokens.bxUmidToken.length).toBeGreaterThan(20);
      expect(tokens.bxV).toBe("2.5.37");
    });

    it("retries Runtime.evaluate until __baxia__ ready within 60×500ms", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      let evalCount = 0;
      const uid = "T2gA" + "b".repeat(24);
      const baxiaResult = { ready: true, fy: "FY_RETRY", uid, cookie: "ck=v" };

      const replyMap = new Map<string, (id: number, params: any) => any>();
      replyMap.set("Page.enable", () => ({}));
      replyMap.set("Runtime.enable", () => ({}));
      replyMap.set("Page.navigate", () => ({ frameId: "f1" }));
      replyMap.set("Runtime.evaluate", (_id, params) => {
        if (params?.expression?.includes("__baxia__")) {
          evalCount++;
          if (evalCount < 3) {
            // First two calls: __baxia__.getFYModule.fyObj not ready yet
            return { result: { type: "object", value: { ready: false } } };
          }
          return { result: { type: "object", value: baxiaResult } };
        }
        return { result: { type: "undefined" } };
      });

      const mgr = new BaxiaTokenManager(
        makeConfig({
          spawn: vi.fn(() => ({ pid: 1, kill: vi.fn() })) as any,
          WebSocketCtor: function (url: string) {
            return new FakeWebSocket(url, replyMap) as any;
          } as any,
          fetcher: vi.fn(async () => ({
            ok: true,
            json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }],
          })) as any,
          sleep: () => Promise.resolve(),
          now: () => 1000,
        }),
      );

      const tokens = await mgr.ensureToken();
      expect(tokens.bxUmidToken).toBe(uid);
      expect(evalCount).toBe(3); // 2 failures + 1 success
    });

    it("kills child in finally even on failure", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const childKill = vi.fn();
      const child = { pid: 1, kill: childKill };

      // Make fetcher fail so getBaxiaTokens fails after Chrome is spawned
      const fetcherFn = vi.fn(async () => {
        throw new Error("network down");
      });

      const replyMap = makeDefaultReplyMap();

      const mgr = new BaxiaTokenManager(
        makeConfig({
          spawn: vi.fn(() => child) as any,
          WebSocketCtor: function (url: string) {
            return new FakeWebSocket(url, replyMap) as any;
          } as any,
          fetcher: fetcherFn as any,
          sleep: () => Promise.resolve(),
          now: () => 1000,
        }),
      );

      await expect(mgr.ensureToken()).rejects.toThrow();
      expect(childKill).toHaveBeenCalledWith("SIGKILL");
    });
  });

  // ── Orchestration tests (S-M1-4) ────────────────────────────────────────

  describe("ensureToken orchestration", () => {
    function makeOrchestrationSetup(overrides: Partial<BaxiaTokenManagerConfig> = {}) {
      const replyMap = makeDefaultReplyMap();
      const spawnFn = vi.fn(() => ({ pid: 1, kill: vi.fn() }));
      const fetcherFn = vi.fn(async (url: string) => {
        if (url.includes("/json/list")) {
          return {
            ok: true,
            json: async () => [
              { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" },
            ],
          };
        }
        return { ok: false, json: async () => ({}) };
      });
      const sleepFn = vi.fn(async () => {});
      let currentTime = 1000;
      const nowFn = vi.fn(() => currentTime);

      const config = makeConfig({
        spawn: spawnFn as any,
        WebSocketCtor: function (url: string) {
          return new FakeWebSocket(url, replyMap) as any;
        } as any,
        fetcher: fetcherFn as any,
        sleep: sleepFn,
        now: nowFn,
        ...overrides,
      });

      return { spawnFn, fetcherFn, config, advance: (ms: number) => { currentTime += ms; } };
    }

    it("cache hit: 2 ensureToken within TTL → spawn called once", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const { spawnFn, config, advance } = makeOrchestrationSetup();
      const mgr = new BaxiaTokenManager(config);

      // First call — cold, should spawn Chrome
      const t1 = await mgr.ensureToken();
      expect(t1.bxUmidToken).toMatch(/^T2gA/);
      expect(spawnFn).toHaveBeenCalledTimes(1);

      // Advance time but stay within TTL (1,500,000 ms)
      advance(60_000);

      // Second call — cache hit, no spawn
      const t2 = await mgr.ensureToken();
      expect(t2.bxUmidToken).toBe(t1.bxUmidToken);
      expect(spawnFn).toHaveBeenCalledTimes(1); // still 1
    });

    it("cache miss after TTL → re-spawn", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const { spawnFn, config, advance } = makeOrchestrationSetup();
      const mgr = new BaxiaTokenManager(config);

      await mgr.ensureToken();
      expect(spawnFn).toHaveBeenCalledTimes(1);

      // Advance past TTL
      advance(1_500_001);

      await mgr.ensureToken();
      expect(spawnFn).toHaveBeenCalledTimes(2); // re-spawned
    });

    it("single-flight: 2 concurrent cold ensureToken → 1 spawn", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const { spawnFn, config } = makeOrchestrationSetup();
      const mgr = new BaxiaTokenManager(config);

      // Two concurrent calls — both cold
      const [t1, t2] = await Promise.all([mgr.ensureToken(), mgr.ensureToken()]);
      expect(t1.bxUmidToken).toBe(t2.bxUmidToken);
      expect(spawnFn).toHaveBeenCalledTimes(1); // single-flight: only 1 spawn
    });

    it("forceRefresh:true ignores cache → spawn", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const { spawnFn, config, advance } = makeOrchestrationSetup();
      const mgr = new BaxiaTokenManager(config);

      await mgr.ensureToken();
      expect(spawnFn).toHaveBeenCalledTimes(1);

      // Advance a tiny bit (still within TTL)
      advance(1000);

      // forceRefresh should ignore cache
      await mgr.ensureToken({ forceRefresh: true });
      expect(spawnFn).toHaveBeenCalledTimes(2);
    });

    it("startRefreshLoop sets interval = cacheTtlMs - 120_000 and calls .unref()", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const unrefFn = vi.fn();
      const intervalId = { unref: unrefFn } as any;
      const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(intervalId);

      try {
        const { config } = makeOrchestrationSetup();
        const mgr = new BaxiaTokenManager(config);

        mgr.startRefreshLoop();

        // interval = Math.max(60_000, 1_500_000 - 120_000) = 1_380_000
        expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_380_000);
        expect(unrefFn).toHaveBeenCalled();

        // Idempotent — second call doesn't set another interval
        mgr.startRefreshLoop();
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        mgr.stop();
      } finally {
        setIntervalSpy.mockRestore();
      }
    });

    it("stop clears the timer", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");
      const unrefFn = vi.fn();
      const intervalId = { unref: unrefFn } as any;
      const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(intervalId);

      try {
        const { config } = makeOrchestrationSetup();
        const mgr = new BaxiaTokenManager(config);

        mgr.startRefreshLoop();
        mgr.stop();

        expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);

        // Stop is idempotent — second call is a no-op
        mgr.stop();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      } finally {
        clearIntervalSpy.mockRestore();
        setIntervalSpy.mockRestore();
      }
    });

    it("status reports cached/cachedAt/ageMs/ttlMs/consecutiveFailures", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const { config, advance } = makeOrchestrationSetup();
      const mgr = new BaxiaTokenManager(config);

      // Before any token: cached=false
      const s0 = mgr.status();
      expect(s0.cached).toBe(false);
      expect(s0.cachedAt).toBeNull();
      expect(s0.ageMs).toBeNull();
      expect(s0.ttlMs).toBe(1_500_000);
      expect(s0.consecutiveFailures).toBe(0);
      expect(s0.lastSpawnDurationMs).toBeNull();

      // After fetching: cached=true
      await mgr.ensureToken();
      advance(5000); // age = 5s
      const s1 = mgr.status();
      expect(s1.cached).toBe(true);
      expect(s1.cachedAt).toBe(1000); // now() always returns 1000 in mock; P3 fix sets after getBaxiaTokens() resolves
      expect(s1.ageMs).toBe(5000);
      expect(s1.consecutiveFailures).toBe(0);
      expect(s1.lastSpawnDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("failure with fallback:false → ensureToken throws + consecutiveFailures increments", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const replyMap = makeDefaultReplyMap();
      const fetcherFn = vi.fn(async () => {
        throw new Error("network down");
      });

      const config = makeConfig({
        spawn: vi.fn(() => ({ pid: 1, kill: vi.fn() })) as any,
        WebSocketCtor: function (url: string) {
          return new FakeWebSocket(url, replyMap) as any;
        } as any,
        fetcher: fetcherFn as any,
        sleep: () => Promise.resolve(),
        now: () => 1000,
        fallback: false,
      });

      const mgr = new BaxiaTokenManager(config);

      await expect(mgr.ensureToken()).rejects.toThrow();
      expect(mgr.status().consecutiveFailures).toBe(1);

      // Second failure increments
      await expect(mgr.ensureToken()).rejects.toThrow();
      expect(mgr.status().consecutiveFailures).toBe(2);
    });

    it("cold failure (no prior entry) → cachedAt:null, ageMs:null, no epoch-0 leak", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const fetcherFn = vi.fn(async () => { throw new Error("network down"); });

      const config = makeConfig({
        spawn: vi.fn(() => ({ pid: 1, kill: vi.fn() })) as any,
        WebSocketCtor: function (url: string) { return new FakeWebSocket(url, makeDefaultReplyMap()) as any; } as any,
        fetcher: fetcherFn as any,
        sleep: () => Promise.resolve(),
        now: () => 1000,
        fallback: false,
      });

      const mgr = new BaxiaTokenManager(config);

      // Cold failure: no prior token exists
      await expect(mgr.ensureToken()).rejects.toThrow();
      const s = mgr.status();
      expect(s.cached).toBe(false);
      expect(s.cachedAt).toBeNull(); // no epoch-0 leak
      expect(s.ageMs).toBeNull();    // no huge ageMs
      expect(s.consecutiveFailures).toBe(1);
    });
  });

  // ── S-M1-5: per-proxy cache tests ──────────────────────────────────────

  describe("per-proxy cache", () => {
    function makeProxySetup(overrides: Partial<BaxiaTokenManagerConfig> = {}) {
      let evalCount = 0;
      const replyMap = new Map<string, (id: number, params: any) => any>();
      replyMap.set("Page.enable", () => ({}));
      replyMap.set("Runtime.enable", () => ({}));
      replyMap.set("Page.navigate", () => ({ frameId: "f1" }));
      replyMap.set("Runtime.evaluate", (_id, params) => {
        if (params?.expression?.includes("__baxia__")) {
          evalCount++;
          const uid = "T2gA" + String.fromCharCode(65 + evalCount - 1).repeat(24);
          return { result: { type: "object", value: { ready: true, fy: "FY" + evalCount, uid, cookie: "ck" + evalCount } } };
        }
        return { result: { type: "undefined" } };
      });

      let currentTime = 1000;
      const nowFn = vi.fn(() => currentTime);
      const spawnFn = vi.fn(() => ({ pid: 1, kill: vi.fn() }));
      const fetcherFn = vi.fn(async (url: string) => {
        if (url.includes("/json/list")) {
          return { ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }] };
        }
        return { ok: false, json: async () => ({}) };
      });

      const config = makeConfig({
        spawn: spawnFn as any,
        WebSocketCtor: function (url: string) { return new FakeWebSocket(url, replyMap) as any; } as any,
        fetcher: fetcherFn as any,
        sleep: () => Promise.resolve(),
        now: nowFn,
        ...overrides,
      });

      return { spawnFn, config, evalCount: () => evalCount, advance: (ms: number) => { currentTime += ms; } };
    }

    it("per-proxy separates: A then B → 2 distinct tokens, 2 spawns; A within TTL → 0 spawns", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const { spawnFn, config, advance } = makeProxySetup();
      const mgr = new BaxiaTokenManager(config);

      const tA = await mgr.ensureToken({ proxy: "socks5://u:p@proxyA:1080" });
      expect(spawnFn).toHaveBeenCalledTimes(1);

      const tB = await mgr.ensureToken({ proxy: "socks5://u:p@proxyB:1080" });
      expect(spawnFn).toHaveBeenCalledTimes(2);
      expect(tB.bxUmidToken).not.toBe(tA.bxUmidToken); // distinct tokens

      advance(60_000);
      const tA2 = await mgr.ensureToken({ proxy: "socks5://u:p@proxyA:1080" });
      expect(spawnFn).toHaveBeenCalledTimes(2); // cache hit for A
      expect(tA2.bxUmidToken).toBe(tA.bxUmidToken);
    });

    it("lazy spawn: TTL per proxy; DIRECT_KEY unaffected", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const { spawnFn, config, advance } = makeProxySetup();
      const mgr = new BaxiaTokenManager(config);

      await mgr.ensureToken({ proxy: "socks5://u:p@proxyA:1080" });
      expect(spawnFn).toHaveBeenCalledTimes(1);

      // DIRECT_KEY (no proxy) should still be a separate cache
      await mgr.ensureToken();
      expect(spawnFn).toHaveBeenCalledTimes(2); // separate spawn for direct

      // Proxy A cache hit
      advance(60_000);
      await mgr.ensureToken({ proxy: "socks5://u:p@proxyA:1080" });
      expect(spawnFn).toHaveBeenCalledTimes(2);
    });

    it("same-proxy piggyback: Promise.all same proxy → 1 spawn", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const { spawnFn, config } = makeProxySetup();
      const mgr = new BaxiaTokenManager(config);

      const proxy = "socks5://u:p@proxyA:1080";
      const [t1, t2] = await Promise.all([
        mgr.ensureToken({ proxy }),
        mgr.ensureToken({ proxy }),
      ]);
      expect(t1.bxUmidToken).toBe(t2.bxUmidToken);
      expect(spawnFn).toHaveBeenCalledTimes(1); // piggybacked
    });

    it("legacy ≡ today: ensureToken() twice within TTL → 1 spawn", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const { spawnFn, config, advance } = makeProxySetup();
      const mgr = new BaxiaTokenManager(config);

      const t1 = await mgr.ensureToken();
      expect(spawnFn).toHaveBeenCalledTimes(1);

      advance(60_000);
      const t2 = await mgr.ensureToken();
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(t2.bxUmidToken).toBe(t1.bxUmidToken);
    });
  });
});

// ── S-M1-6: global serialization + fallback + status (simplified) ─────────
describe("global serialization + fallback + status", () => {
  function makeProxySetup(overrides: Partial<BaxiaTokenManagerConfig> = {}) {
    let evalCount = 0;
    const replyMap = new Map<string, (id: number, params: any) => any>();
    replyMap.set("Page.enable", () => ({}));
    replyMap.set("Runtime.enable", () => ({}));
    replyMap.set("Page.navigate", () => ({ frameId: "f1" }));
    replyMap.set("Runtime.evaluate", (_id, params) => {
      if (params?.expression?.includes("__baxia__")) { evalCount++;
        const uid = "T2gA" + String.fromCharCode(65 + evalCount - 1).repeat(24);
        return { result: { type: "object", value: { ready: true, fy: "FY" + evalCount, uid, cookie: "ck" + evalCount } } }; }
      return { result: { type: "undefined" } }; });
    let currentTime = 1000; const nowFn = vi.fn(() => currentTime);
    const spawnFn = vi.fn(() => ({ pid: 1, kill: vi.fn() }));
    const fetcherFn = vi.fn(async (url: string) => {
      if (url.includes("/json/list")) return { ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }] };
      return { ok: false, json: async () => ({}) }; });
    const config = makeConfig({ spawn: spawnFn as any, WebSocketCtor: function (url: string) { return new FakeWebSocket(url, replyMap) as any; } as any,
      fetcher: fetcherFn as any, sleep: () => Promise.resolve(), now: nowFn, ...overrides });
    return { spawnFn, config, evalCount: () => evalCount, advance: (ms: number) => { currentTime += ms; } };
  }

  it("concurrent A+B → 2 spawns, distinct tokens (serialized via withSpawnLock)", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const { spawnFn, config } = makeProxySetup();
    const mgr = new BaxiaTokenManager(config);
    const [tA, tB] = await Promise.all([
      mgr.ensureToken({ proxy: "socks5://u:p@A:1080" }),
      mgr.ensureToken({ proxy: "socks5://u:p@B:1080" }),
    ]);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(tA.bxUmidToken).not.toBe(tB.bxUmidToken);
  });

  it("fallback:true on fail → returns same-proxy stale token", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const { config, advance } = makeProxySetup({ fallback: true });
    const mgr = new BaxiaTokenManager(config);
    const proxy = "socks5://u:p@A:1080";
    const t1 = await mgr.ensureToken({ proxy });
    advance(999_999); // past TTL
    // Make fetcher fail → getBaxiaTokens throws → stale fallback
    (config.fetcher as any).mockImplementation(async () => ({ ok: false, json: async () => ({}) }));
    const t2 = await mgr.ensureToken({ proxy, forceRefresh: true });
    expect(t2.bxUmidToken).toBe(t1.bxUmidToken); // stale token returned
  });

  it("status after seeding proxy X: cached + proxyStatuses has X", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const { config, advance } = makeProxySetup();
    const mgr = new BaxiaTokenManager(config);
    await mgr.ensureToken({ proxy: "socks5://u:p@X:1080" });
    advance(5000);
    expect(mgr.status().cached).toBe(true);
    expect(mgr.status().ageMs).toBe(5000);
    const ps = mgr.proxyStatuses();
    expect(ps["socks5://u:p@X:1080"]).toBeDefined();
    expect(ps["socks5://u:p@X:1080"].cached).toBe(true);
  });
});

// ── S-M1-7: bridge integration ─────────────────────────────────────────────
describe("bridge integration", () => {
  function makeBridgeSetup(bridgePort = 12345) {
    const setUpstreamFn = vi.fn();
    const fakeBridge = {
      getPort: () => bridgePort,
      setUpstream: setUpstreamFn,
    };

    let evalCount = 0;
    const replyMap = new Map<string, (id: number, params: any) => any>();
    replyMap.set("Page.enable", () => ({}));
    replyMap.set("Runtime.enable", () => ({}));
    replyMap.set("Page.navigate", () => ({ frameId: "f1" }));
    replyMap.set("Runtime.evaluate", (_id, params) => {
      if (params?.expression?.includes("__baxia__")) { evalCount++;
        const uid = "T2gA" + String.fromCharCode(65 + evalCount - 1).repeat(24);
        return { result: { type: "object", value: { ready: true, fy: "FY" + evalCount, uid, cookie: "ck" + evalCount } } }; }
      return { result: { type: "undefined" } }; });
    let currentTime = 1000; const nowFn = vi.fn(() => currentTime);
    const spawnFn = vi.fn(() => ({ pid: 1, kill: vi.fn() }));
    const fetcherFn = vi.fn(async (url: string) => {
      if (url.includes("/json/list")) return { ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }] };
      return { ok: false, json: async () => ({}) }; });

    const config = makeConfig({ spawn: spawnFn as any, WebSocketCtor: function (url: string) { return new FakeWebSocket(url, replyMap) as any; } as any,
      fetcher: fetcherFn as any, sleep: () => Promise.resolve(), now: nowFn, bridge: fakeBridge as any });
    return { spawnFn, setUpstreamFn, config, fakeBridge, advance: (ms: number) => { currentTime += ms; } };
  }

  it("rotation: spawn gets --proxy-server + --host-resolver-rules args", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const { spawnFn, config } = makeBridgeSetup(9999);
    const mgr = new BaxiaTokenManager(config);

    await mgr.ensureToken({ proxy: "socks5://u:p@proxyA:1080" });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const args = (spawnFn.mock.calls[0] as any)[1] as string[];
    expect(args).toContain("--proxy-server=socks5://127.0.0.1:9999");
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1");
  });

  it("rotation: bridge.setUpstream called with proxy key before getBaxiaTokens", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const { spawnFn, setUpstreamFn, config } = makeBridgeSetup();
    const mgr = new BaxiaTokenManager(config);

    const proxy = "socks5://u:p@proxyA:1080";
    await mgr.ensureToken({ proxy });

    expect(setUpstreamFn).toHaveBeenCalledWith(proxy);
    // setUpstream must be called BEFORE spawn (which calls getBaxiaTokens)
    expect(setUpstreamFn.mock.invocationCallOrder[0]).toBeLessThan(
      spawnFn.mock.invocationCallOrder[0],
    );
  });

  it("legacy (no bridge): spawn gets NEITHER --proxy-server NOR --host-resolver-rules", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const replyMap = makeDefaultReplyMap();
    const spawnFn = vi.fn(() => ({ pid: 1, kill: vi.fn() }));
    const fetcherFn = vi.fn(async (url: string) => {
      if (url.includes("/json/list")) return { ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }] };
      return { ok: false, json: async () => ({}) }; });

    const config = makeConfig({ spawn: spawnFn as any, WebSocketCtor: function (url: string) { return new FakeWebSocket(url, replyMap) as any; } as any,
      fetcher: fetcherFn as any, sleep: () => Promise.resolve(), now: () => 1000 });
    const mgr = new BaxiaTokenManager(config);

    await mgr.ensureToken();

    const args = (spawnFn.mock.calls[0] as any)[1] as string[];
    expect(args).not.toContain(expect.stringMatching(/--proxy-server/));
    expect(args).not.toContain(expect.stringMatching(/--host-resolver-rules/));
  });

  it("lazy refresh: startRefreshLoop is no-op when bridge set, no setInterval", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    try {
      const { config } = makeBridgeSetup();
      const mgr = new BaxiaTokenManager(config);

      mgr.startRefreshLoop();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect(mgr.status().nextRefreshInMs).toBeNull();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});

// ── requests-per-token counter (S-M1-2) ─────────────────────────────────────

describe("requests-per-token counter", () => {
  function makeCounterSetup() {
    let evalCount = 0;
    const replyMap = new Map<string, (id: number, params: any) => any>();
    replyMap.set("Page.enable", () => ({}));
    replyMap.set("Runtime.enable", () => ({}));
    replyMap.set("Page.navigate", () => ({ frameId: "f1" }));
    replyMap.set("Runtime.evaluate", (_id, params) => {
      if (params?.expression?.includes("__baxia__")) {
        evalCount++;
        const uid = "T2gA" + String.fromCharCode(65 + evalCount - 1).repeat(24);
        return { result: { type: "object", value: { ready: true, fy: "FY" + evalCount, uid, cookie: "ck" + evalCount } } };
      }
      return { result: { type: "undefined" } };
    });
    const fetcherFn = vi.fn(async (url: string) => {
      if (url.includes("/json/list")) {
        return { ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }] };
      }
      return { ok: false, json: async () => ({}) };
    });
    const config = makeConfig({
      spawn: vi.fn(() => ({ pid: 1, kill: vi.fn() })) as any,
      WebSocketCtor: function (url: string) { return new FakeWebSocket(url, replyMap) as any; } as any,
      fetcher: fetcherFn as any,
      sleep: () => Promise.resolve(),
      now: vi.fn(() => 1000),
    });
    return { config, spawnCount: () => (config.spawn as ReturnType<typeof vi.fn>).mock.calls.length };
  }

  it("recordRequestServed increments per-proxy entry; proxyStatuses exposes it", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const { config } = makeCounterSetup();
    const mgr = new BaxiaTokenManager(config);
    const P = "socks5://u:p@counterA:1080";

    await mgr.ensureToken({ proxy: P });
    mgr.recordRequestServed(P);
    mgr.recordRequestServed(P);
    mgr.recordRequestServed(P);
    expect(mgr.proxyStatuses()[P].requestsServed).toBe(3);
  });

  it("forceRefresh re-mint resets the counter to 0", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const { config } = makeCounterSetup();
    const mgr = new BaxiaTokenManager(config);
    const P = "socks5://u:p@counterB:1080";

    await mgr.ensureToken({ proxy: P });
    mgr.recordRequestServed(P);
    mgr.recordRequestServed(P);
    await mgr.ensureToken({ forceRefresh: true, proxy: P });
    expect(mgr.proxyStatuses()[P].requestsServed).toBe(0);
  });

  it("recordRequestServed on unknown key is a no-op (no throw, no entry created)", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const { config } = makeCounterSetup();
    const mgr = new BaxiaTokenManager(config);
    expect(() => mgr.recordRequestServed("socks5://u:p@never-minted:1080")).not.toThrow();
    expect(mgr.proxyStatuses()["socks5://u:p@never-minted:1080"]).toBeUndefined();
  });

  it("status() reports requestsServed for the last-used proxy", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const { config } = makeCounterSetup();
    const mgr = new BaxiaTokenManager(config);
    const P = "socks5://u:p@counterC:1080";
    await mgr.ensureToken({ proxy: P });
    mgr.recordRequestServed(P);
    expect(mgr.status().requestsServed).toBe(1);
  });
});

// ── evictToken (S-M1-3) ─────────────────────────────────────────────────────

describe("evictToken", () => {
  it("evicted token re-mints on next ensureToken even within TTL", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    let evalCount = 0;
    const replyMap = new Map<string, (id: number, params: any) => any>();
    replyMap.set("Page.enable", () => ({}));
    replyMap.set("Runtime.enable", () => ({}));
    replyMap.set("Page.navigate", () => ({ frameId: "f1" }));
    replyMap.set("Runtime.evaluate", (_id, params) => {
      if (params?.expression?.includes("__baxia__")) {
        evalCount++;
        const uid = "T2gA" + String.fromCharCode(65 + evalCount - 1).repeat(24);
        return { result: { type: "object", value: { ready: true, fy: "FY" + evalCount, uid, cookie: "ck" + evalCount } } };
      }
      return { result: { type: "undefined" } };
    });
    const spawnFn = vi.fn(() => ({ pid: 1, kill: vi.fn() }));
    const config = makeConfig({
      spawn: spawnFn as any,
      WebSocketCtor: function (url: string) { return new FakeWebSocket(url, replyMap) as any; } as any,
      fetcher: vi.fn(async (url: string) => {
        if (url.includes("/json/list")) {
          return { ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }] };
        }
        return { ok: false, json: async () => ({}) };
      }) as any,
      sleep: () => Promise.resolve(),
      now: vi.fn(() => 1000),
    });
    const mgr = new BaxiaTokenManager(config);
    const P = "socks5://u:p@evictA:1080";

    const t1 = await mgr.ensureToken({ proxy: P });
    expect(spawnFn).toHaveBeenCalledTimes(1);

    mgr.evictToken(P);

    // Within TTL — but the entry was evicted, so this MUST re-mint.
    const t2 = await mgr.ensureToken({ proxy: P });
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(t2.bxUmidToken).not.toBe(t1.bxUmidToken);

    // New generation's counter starts at 0.
    expect(mgr.proxyStatuses()[P].requestsServed).toBe(0);
  });

  it("evictToken on unknown key is a no-op (no throw, no log)", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const warn = vi.fn();
    const config = makeConfig({ log: { info: vi.fn(), warn, error: vi.fn() } });
    const mgr = new BaxiaTokenManager(config);
    expect(() => mgr.evictToken("socks5://u:p@unknown:1080")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("evictToken logs requestsServed + redacted proxy + ageMs", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const records: Array<{ msg: string; ctx: any }> = [];
    const log = {
      info: vi.fn(),
      warn: (msg: string, ctx?: unknown) => records.push({ msg, ctx }),
      error: vi.fn(),
    };
    let currentTime = 1000;
    let evalCount = 0;
    const replyMap = new Map<string, (id: number, params: any) => any>();
    replyMap.set("Page.enable", () => ({}));
    replyMap.set("Runtime.enable", () => ({}));
    replyMap.set("Page.navigate", () => ({ frameId: "f1" }));
    replyMap.set("Runtime.evaluate", (_id, params) => {
      if (params?.expression?.includes("__baxia__")) {
        evalCount++;
        const uid = "T2gA" + String.fromCharCode(65 + evalCount - 1).repeat(24);
        return { result: { type: "object", value: { ready: true, fy: "FY" + evalCount, uid, cookie: "ck" + evalCount } } };
      }
      return { result: { type: "undefined" } };
    });
    const config = makeConfig({
      spawn: vi.fn(() => ({ pid: 1, kill: vi.fn() })) as any,
      WebSocketCtor: function (url: string) { return new FakeWebSocket(url, replyMap) as any; } as any,
      fetcher: vi.fn(async (url: string) => {
        if (url.includes("/json/list")) {
          return { ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }] };
        }
        return { ok: false, json: async () => ({}) };
      }) as any,
      sleep: () => Promise.resolve(),
      now: () => currentTime,
      log,
    });
    const mgr = new BaxiaTokenManager(config);
    const P = "socks5://secretuser:secretpass@evictB:1080";

    await mgr.ensureToken({ proxy: P });
    mgr.recordRequestServed(P);
    mgr.recordRequestServed(P);
    mgr.recordRequestServed(P);
    currentTime += 45_000;
    mgr.evictToken(P);

    const burn = records.find((r) => r.msg.includes("token burned"));
    expect(burn).toBeDefined();
    expect(burn!.ctx.proxy).toBe("evictB:1080");            // redacted — no creds
    expect(burn!.ctx.requestsServed).toBe(3);
    expect(burn!.ctx.ageMs).toBe(45_000);
    expect(JSON.stringify(records)).not.toContain("secretuser");
    expect(JSON.stringify(records)).not.toContain("secretpass");
  });
});

// ── log redaction (S-M1-4) ──────────────────────────────────────────────────

describe("baxia log redaction", () => {
  it("no log record contains proxy credentials; proxy fields are host:port", async () => {
    const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
    const records: Array<{ msg: string; ctx: any }> = [];
    const log = {
      info: (msg: string, ctx?: unknown) => records.push({ msg, ctx }),
      warn: (msg: string, ctx?: unknown) => records.push({ msg, ctx }),
      error: (msg: string, ctx?: unknown) => records.push({ msg, ctx }),
    };
    const replyMap = makeDefaultReplyMap();
    const config = makeConfig({
      spawn: vi.fn(() => ({ pid: 1, kill: vi.fn() })) as any,
      WebSocketCtor: function (url: string) { return new FakeWebSocket(url, replyMap) as any; } as any,
      fetcher: vi.fn(async (url: string) => {
        if (url.includes("/json/list")) {
          return { ok: true, json: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/abc" }] };
        }
        return { ok: false, json: async () => ({}) };
      }) as any,
      sleep: () => Promise.resolve(),
      now: vi.fn(() => 1000),
      log,
    });
    const mgr = new BaxiaTokenManager(config);
    const CREDS = "socks5://leakyuser:leakypass@redact-me:1080";

    await mgr.ensureToken({ proxy: CREDS });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("leakyuser");
    expect(serialized).not.toContain("leakypass");
    const spawnLog = records.find((r) => r.msg.includes("chromium spawn"));
    expect(spawnLog).toBeDefined();
    expect(spawnLog!.ctx.proxy).toBe("redact-me:1080");
  });
});
