import { describe, it, expect, vi } from "vitest";
import { ProxyPool, ProxyDispatcherCache, fetchWithProxy } from "../../src/pool/proxy-pool";

// ── ProxyPool ────────────────────────────────────────────────────────────────

describe("ProxyPool", () => {
  describe("round-robin", () => {
    it("cycles through keys A→B→C→A", () => {
      const pool = new ProxyPool(["A", "B", "C"]);
      expect(pool.getActive()).toBe("A");
      expect(pool.rotate()).toBe("B");
      expect(pool.rotate()).toBe("C");
      expect(pool.rotate()).toBe("A");
    });

    it("retains all keys after rotation", () => {
      const pool = new ProxyPool(["A", "B", "C"]);
      pool.rotate();
      pool.rotate();
      pool.rotate();
      expect(pool.getKeys()).toEqual(["A", "B", "C"]);
    });

    it("exposes size", () => {
      const pool = new ProxyPool(["A", "B", "C"]);
      expect(pool.size).toBe(3);
    });
  });

  describe("single-key", () => {
    it("rotate is a no-op for single key", () => {
      const pool = new ProxyPool(["A"]);
      expect(pool.rotate()).toBe("A");
      expect(pool.getActive()).toBe("A");
    });
  });

  describe("empty", () => {
    it("size is 0", () => {
      const pool = new ProxyPool([]);
      expect(pool.size).toBe(0);
    });

    it("getActive returns undefined", () => {
      const pool = new ProxyPool([]);
      expect(pool.getActive()).toBeUndefined();
    });

    it("rotate returns undefined", () => {
      const pool = new ProxyPool([]);
      expect(pool.rotate()).toBeUndefined();
    });
  });
});

// ── ProxyDispatcherCache ─────────────────────────────────────────────────────

describe("ProxyDispatcherCache", () => {
  it("memoizes dispatcher per key (factory called once)", () => {
    const factory = vi.fn((key: string) => ({ type: "fake", key }));
    const cache = new ProxyDispatcherCache({ agentFactory: factory });

    const d1 = cache.get("socks5://a:1080");
    const d2 = cache.get("socks5://a:1080");

    expect(d1).toBe(d2);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("socks5://a:1080");
  });

  it("separate keys get separate dispatchers", () => {
    const factory = vi.fn((key: string) => ({ type: "fake", key }));
    const cache = new ProxyDispatcherCache({ agentFactory: factory });

    const da = cache.get("socks5://a:1080");
    const db = cache.get("socks5://b:1080");

    expect(da).not.toBe(db);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("recreate(key) returns a new dispatcher", () => {
    const factory = vi.fn((key: string) => ({ type: "fake", key }));
    const cache = new ProxyDispatcherCache({ agentFactory: factory });

    const d1 = cache.get("socks5://a:1080");
    const d2 = cache.recreate("socks5://a:1080");

    expect(d1).not.toBe(d2);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

// ── fetchWithProxy ───────────────────────────────────────────────────────────

describe("fetchWithProxy", () => {
  it("appends dispatcher when set", async () => {
    const fakeDispatcher = { type: "fake" } as any;
    const fetcher = vi.fn(async (_url: string, _init: any) => new Response("ok"));

    await fetchWithProxy(fetcher, "https://example.com", { method: "GET" }, fakeDispatcher);

    expect(fetcher).toHaveBeenCalledWith("https://example.com", {
      method: "GET",
      dispatcher: fakeDispatcher,
    });
  });

  it("passes through when dispatcher is undefined", async () => {
    const fetcher = vi.fn(async (_url: string, _init: any) => new Response("ok"));

    await fetchWithProxy(fetcher, "https://example.com", { method: "GET" }, undefined);

    expect(fetcher).toHaveBeenCalledWith("https://example.com", { method: "GET" });
  });

  it("passes through when dispatcher is omitted", async () => {
    const fetcher = vi.fn(async (_url: string, _init: any) => new Response("ok"));

    await fetchWithProxy(fetcher, "https://example.com", { method: "GET" });

    expect(fetcher).toHaveBeenCalledWith("https://example.com", { method: "GET" });
  });
});
