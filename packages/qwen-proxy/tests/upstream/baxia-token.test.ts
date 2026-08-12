import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import type { BaxiaTokenManagerConfig } from "../../src/upstream/baxia-token";

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
  baxiaResult: string = JSON.stringify({
    fy: "FYFAKE",
    uid: "T2gA" + "a".repeat(24),
  }),
): Map<string, (id: number, params: any) => any> {
  const map = new Map<string, (id: number, params: any) => any>();
  map.set("Page.enable", () => ({}));
  map.set("Runtime.enable", () => ({}));
  map.set("Page.navigate", () => ({ frameId: "f1" }));
  map.set("Network.getAllCookies", () => ({
    cookies: [
      { name: "c1", value: "v1", domain: ".qwen.ai" },
      { name: "c2", value: "v2", domain: ".qwen.ai" },
    ],
  }));
  map.set("Runtime.evaluate", (_id, params) => {
    if (params?.expression?.includes("__baxia__")) {
      return { result: { type: "string", value: baxiaResult } };
    }
    return { result: { type: "undefined" } };
  });
  return map;
}

function makeConfig(overrides: Partial<BaxiaTokenManagerConfig> = {}): BaxiaTokenManagerConfig {
  return {
    useChromeBaxia: true,
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
      const baxiaResult = JSON.stringify({ fy: "FY_RETRY", uid });

      const replyMap = new Map<string, (id: number, params: any) => any>();
      replyMap.set("Page.enable", () => ({}));
      replyMap.set("Runtime.enable", () => ({}));
      replyMap.set("Page.navigate", () => ({ frameId: "f1" }));
      replyMap.set("Network.getAllCookies", () => ({ cookies: [] }));
      replyMap.set("Runtime.evaluate", (_id, params) => {
        if (params?.expression?.includes("__baxia__")) {
          evalCount++;
          if (evalCount < 3) {
            // First two calls: __baxia__ is undefined
            return { result: { type: "undefined" } };
          }
            return { result: { type: "string", value: baxiaResult } };
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
  });
});
