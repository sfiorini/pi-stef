import { describe, it, expect, vi } from "vitest";
import { ProxyPool, ProxyDispatcherCache, fetchWithProxy, normalizeSocksUrl, parseProxyUrls, createProxyPool } from "../../src/pool/proxy-pool";

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

// ── normalizeSocksUrl ───────────────────────────────────────────────────────

describe("normalizeSocksUrl", () => {
  it("accepts socks5:// and defaults port to 1080", () => {
    expect(normalizeSocksUrl("socks5://myuser:mypass@host.example.com", undefined, undefined)).toBe("socks5://myuser:mypass@host.example.com:1080");
  });

  it("accepts socks5h:// protocol", () => {
    expect(normalizeSocksUrl("socks5h://myuser:mypass@host.example.com", undefined, undefined)).toBe("socks5h://myuser:mypass@host.example.com:1080");
  });

  it("rejects non-socks5 protocol", () => {
    expect(normalizeSocksUrl("http://host.example.com", undefined, undefined)).toBeNull();
  });

  it("rejects socks4:// protocol", () => {
    expect(normalizeSocksUrl("socks4://host.example.com", undefined, undefined)).toBeNull();
  });

  it("merges global creds when URL lacks both user and pass", () => {
    expect(normalizeSocksUrl("socks5://host.example.com", "globalUser", "globalPass")).toBe("socks5://globalUser:globalPass@host.example.com:1080");
  });

  it("keeps URL creds when both present, ignores global", () => {
    expect(normalizeSocksUrl("socks5://urlUser:urlPass@host.example.com", "globalUser", "globalPass")).toBe("socks5://urlUser:urlPass@host.example.com:1080");
  });

  it("drops (null) when no creds at all (URL or global)", () => {
    expect(normalizeSocksUrl("socks5://host.example.com", undefined, undefined)).toBeNull();
  });

  it("drops (null) when only partial creds (user xor pass)", () => {
    expect(normalizeSocksUrl("socks5://host.example.com", "globalUser", undefined)).toBeNull();
    expect(normalizeSocksUrl("socks5://host.example.com", undefined, "globalPass")).toBeNull();
  });

  it("preserves explicit port", () => {
    expect(normalizeSocksUrl("socks5://myuser:mypass@host.example.com:9999", undefined, undefined)).toBe("socks5://myuser:mypass@host.example.com:9999");
  });

  it("does not double-encode percent-encoded URL creds (round-trip safe)", () => {
    // Input has percent-encoded creds (@ → %40). normalizeSocksUrl must NOT
    // re-encodeURIComponent them (WHATWG URL already stores them encoded).
    const input = "socks5://us%40er:p%40ss@proxy:1080";
    const normalized = normalizeSocksUrl(input, undefined, undefined);
    expect(normalized).toBe("socks5://us%40er:p%40ss@proxy:1080");
  });

  it("rejects empty string", () => {
    expect(normalizeSocksUrl("", undefined, undefined)).toBeNull();
  });

  it("rejects whitespace-only", () => {
    expect(normalizeSocksUrl("   ", undefined, undefined)).toBeNull();
  });
});

// ── parseProxyUrls ──────────────────────────────────────────────────────────

describe("parseProxyUrls", () => {
  it("splits comma-separated URLs", () => {
    const result = parseProxyUrls("socks5://u:p@a:1080,socks5://u:p@b:1080", undefined, undefined);
    expect(result).toEqual(["socks5://u:p@a:1080", "socks5://u:p@b:1080"]);
  });

  it("splits whitespace-separated URLs", () => {
    const result = parseProxyUrls("socks5://u:p@a:1080  socks5://u:p@b:1080", undefined, undefined);
    expect(result).toEqual(["socks5://u:p@a:1080", "socks5://u:p@b:1080"]);
  });

  it("deduplicates invalid/empty entries", () => {
    const result = parseProxyUrls("socks5://u:p@a:1080,,  ,socks5://u:p@b:1080", undefined, undefined);
    expect(result).toEqual(["socks5://u:p@a:1080", "socks5://u:p@b:1080"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseProxyUrls("", undefined, undefined)).toEqual([]);
  });

  it("filters out invalid protocol entries", () => {
    const result = parseProxyUrls("socks5://u:p@a:1080,http://bad:8080,socks5://u:p@b:1080", undefined, undefined);
    expect(result).toEqual(["socks5://u:p@a:1080", "socks5://u:p@b:1080"]);
  });
});

// ── createProxyPool ──────────────────────────────────────────────────────────

describe("createProxyPool", () => {
  it("explicit URLs win over proxyCount (discovery skipped)", async () => {
    const pool = await createProxyPool({
      proxyUrlsRaw: "socks5://u:p@a:1080,socks5://u:p@b:1080",
      proxyCount: 5,
      proxyUser: "global",
      proxyPass: "global",
    });
    expect(pool.size).toBe(2);
    expect(pool.getKeys()).toEqual(["socks5://u:p@a:1080", "socks5://u:p@b:1080"]);
  });

  it("returns empty pool when no explicit URLs and no discovery stub", async () => {
    const pool = await createProxyPool({
      proxyUrlsRaw: "",
      proxyCount: 0,
    });
    expect(pool.size).toBe(0);
  });

  it("returns empty pool when explicit URLs are all invalid", async () => {
    const pool = await createProxyPool({
      proxyUrlsRaw: "http://bad:8080,ftp://also-bad",
      proxyCount: 0,
    });
    expect(pool.size).toBe(0);
  });

  it("merges global creds into URL entries", async () => {
    const pool = await createProxyPool({
      proxyUrlsRaw: "socks5://host-a:1080,socks5://host-b:1080",
      proxyCount: 0,
      proxyUser: "myuser",
      proxyPass: "mypass",
    });
    expect(pool.size).toBe(2);
    expect(pool.getKeys()).toEqual([
      "socks5://myuser:mypass@host-a:1080",
      "socks5://myuser:mypass@host-b:1080",
    ]);
  });

  it("drops URLs with no creds after merge", async () => {
    const pool = await createProxyPool({
      proxyUrlsRaw: "socks5://host-a:1080,socks5://host-b:1080",
      proxyCount: 0,
      // no global creds → both dropped
    });
    expect(pool.size).toBe(0);
  });

  describe("discovery (NordVPN)", () => {
    it("sorts by load ascending and takes N", async () => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify([
        { hostname: "us1.example.com", load: 50, locations: [{ country: { code: "US" } }] },
        { hostname: "de1.example.com", load: 10, locations: [{ country: { code: "DE" } }] },
        { hostname: "us2.example.com", load: 30, locations: [{ country: { code: "US" } }] },
      ]), { status: 200 }));

      const pool = await createProxyPool({
        proxyUrlsRaw: "",
        proxyCount: 2,
        proxyUser: "u",
        proxyPass: "p",
        fetcher,
      });
      expect(pool.size).toBe(2);
      // Sorted by load: de1(10), us2(30), us1(50)
      expect(pool.getKeys()).toEqual([
        "socks5://u:p@de1.example.com:1080",
        "socks5://u:p@us2.example.com:1080",
      ]);
    });

    it("filters by country BEFORE sort (case-insensitive)", async () => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify([
        { hostname: "us1.example.com", load: 10, locations: [{ country: { code: "US" } }] },
        { hostname: "de1.example.com", load: 5, locations: [{ country: { code: "DE" } }] },
        { hostname: "us2.example.com", load: 20, locations: [{ country: { code: "US" } }] },
      ]), { status: 200 }));

      const pool = await createProxyPool({
        proxyUrlsRaw: "",
        proxyCount: 10,
        proxyUser: "u",
        proxyPass: "p",
        proxyCountriesRaw: "de",
        fetcher,
      });
      expect(pool.size).toBe(1);
      expect(pool.getKeys()).toEqual(["socks5://u:p@de1.example.com:1080"]);
    });

    it("graceful degrade: M<N usable → use M", async () => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify([
        { hostname: "us1.example.com", load: 10, locations: [{ country: { code: "US" } }] },
      ]), { status: 200 }));

      const log = { warn: vi.fn() };
      const pool = await createProxyPool({
        proxyUrlsRaw: "",
        proxyCount: 5,
        proxyUser: "u",
        proxyPass: "p",
        log,
        fetcher,
      });
      expect(pool.size).toBe(1);
      expect(log.warn).toHaveBeenCalled();
    });

    it("0 usable → size 0 + warn", async () => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));

      const log = { warn: vi.fn() };
      const pool = await createProxyPool({
        proxyUrlsRaw: "",
        proxyCount: 5,
        proxyUser: "u",
        proxyPass: "p",
        log,
        fetcher,
      });
      expect(pool.size).toBe(0);
      expect(log.warn).toHaveBeenCalled();
    });

    it("non-OK response → size 0", async () => {
      const fetcher = vi.fn(async () => new Response("error", { status: 500 }));

      const log = { warn: vi.fn() };
      const pool = await createProxyPool({
        proxyUrlsRaw: "",
        proxyCount: 5,
        proxyUser: "u",
        proxyPass: "p",
        log,
        fetcher,
      });
      expect(pool.size).toBe(0);
      expect(log.warn).toHaveBeenCalled();
    });

    it("missing creds short-circuits (fetch not called)", async () => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify([
        { hostname: "us1.example.com", load: 10, locations: [{ country: { code: "US" } }] },
      ]), { status: 200 }));

      const log = { warn: vi.fn() };
      const pool = await createProxyPool({
        proxyUrlsRaw: "",
        proxyCount: 5,
        // no creds
        log,
        fetcher,
      });
      expect(pool.size).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    });

    it("explicit URLs skip discovery entirely", async () => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify([
        { hostname: "us1.example.com", load: 10, locations: [{ country: { code: "US" } }] },
      ]), { status: 200 }));

      const pool = await createProxyPool({
        proxyUrlsRaw: "socks5://u:p@custom:1080",
        proxyCount: 5,
        proxyUser: "u",
        proxyPass: "p",
        fetcher,
      });
      expect(pool.size).toBe(1);
      expect(pool.getKeys()).toEqual(["socks5://u:p@custom:1080"]);
      expect(fetcher).not.toHaveBeenCalled();
    });
  });
});

// ── per-proxy serialization slots (S-M3-1) ──────────────────────────────────

describe("ProxyPool slots", () => {
  const K1 = "socks5://u:p@h1:1080";
  const K2 = "socks5://u:p@h2:1080";
  const K3 = "socks5://u:p@h3:1080";

  it("sticky: sequential acquire/release returns the same key", async () => {
    const pool = new ProxyPool([K1, K2, K3]);
    const a = await pool.acquire();
    expect(a).toBe(K1);
    pool.release(a);
    const b = await pool.acquire();
    expect(b).toBe(K1); // head slot free → same proxy (avoid extra mints)
    pool.release(b);
  });

  it("spread: concurrent acquire lands on distinct proxies", async () => {
    const pool = new ProxyPool([K1, K2, K3]);
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a).toBe(K1);
    expect(b).toBe(K2); // K1 busy → next free slot
    expect(pool.getActive()).toBe(K2); // head tracks last acquisition
    pool.release(a);
    pool.release(b);
  });

  it("release then acquire reuses the freed slot (scan wraps from head)", async () => {
    const pool = new ProxyPool([K1, K2]);
    const a = await pool.acquire(); // K1, head=K1
    const b = await pool.acquire(); // K2, head=K2
    expect(b).toBe(K2);
    pool.release(a); // K1 free, head stays K2
    const c = await pool.acquire(); // K2 busy → wraps to K1
    expect(c).toBe(K1);
    pool.release(b);
    pool.release(c);
  });

  it("all slots busy: acquire blocks FIFO until release", async () => {
    const pool = new ProxyPool([K1]);
    const a = await pool.acquire();
    expect(a).toBe(K1);
    let resolved = "";
    const pending = pool.acquire().then((k) => { resolved = k; return k; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(""); // still blocked
    pool.release(a);
    const k = await pending;
    expect(k).toBe(K1);
  });

  it("getActive/rotate/getKeys/size unchanged by slots", async () => {
    const pool = new ProxyPool([K1, K2, K3]);
    expect(pool.size).toBe(3);
    expect(pool.getKeys()).toEqual([K1, K2, K3]);
    expect(pool.rotate()).toBe(K2);
    expect(pool.getActive()).toBe(K2);
  });
});
