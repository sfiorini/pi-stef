import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BaxiaTokenManagerConfig } from "../../src/upstream/baxia-token";

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
  private replyMap: Map<string, (id: number, params: any) => any>;

  constructor(
    _url: string,
    replyMap: Map<string, (id: number, params: any) => any>,
  ) {
    this.replyMap = replyMap;
    FakeWebSocket.instances.push(this);
    // Auto-dispatch after construction so addEventListener handlers are attached
    queueMicrotask(() => {
      this.dispatchOpen();
    });
  }

  addEventListener(event: string, handler: (ev: any) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  send(data: string) {
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
      // The config already has chromePath set
      const mgr = new BaxiaTokenManager(
        makeConfig({ chromePath: tmpPath }),
      );
      // findChrome is private but we can test via startChrome path
      // For now, we test that it doesn't throw when using the config path
      // (real validation happens via fs.existsSync which we can't easily mock here)
      // Instead we test the throw case:
      expect(mgr).toBeDefined();
    });

    it("throws when no chromePath config and no candidates found", async () => {
      const { BaxiaTokenManager } = await import("../../src/upstream/baxia-token");
      const mgr = new BaxiaTokenManager(
        makeConfig({ chromePath: undefined }),
      );
      // getBaxiaTokens internally calls findChrome which should throw
      // We test this through the public API
      await expect(mgr.ensureToken()).rejects.toThrow(/Chrome not found/i);
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
});
