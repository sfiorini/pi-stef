import { describe, it, expect, vi } from "vitest";
import * as net from "node:net";

// S-M1-1: parseSocksUrl
describe("parseSocksUrl", () => {
  let parseSocksUrl: (key: string) => { host: string; port: number; user: string; pass: string };

  it("parses socks5 URL with user:pass", async () => {
    const mod = await import("../../src/upstream/proxy-bridge");
    parseSocksUrl = mod.parseSocksUrl;
    const r = parseSocksUrl("socks5://alice:secret@proxy.example.com:1080");
    expect(r.host).toBe("proxy.example.com");
    expect(r.port).toBe(1080);
    expect(r.user).toBe("alice");
    expect(r.pass).toBe("secret");
  });

  it("decodes URL-encoded credentials", async () => {
    const mod = await import("../../src/upstream/proxy-bridge");
    parseSocksUrl = mod.parseSocksUrl;
    const r = parseSocksUrl("socks5://us%40er:p%40ss@proxy:1080");
    expect(r.user).toBe("us@er");
    expect(r.pass).toBe("p@ss");
  });

  it("defaults port to 1080 when omitted", async () => {
    const mod = await import("../../src/upstream/proxy-bridge");
    parseSocksUrl = mod.parseSocksUrl;
    const r = parseSocksUrl("socks5://u:p@proxy");
    expect(r.port).toBe(1080);
  });

  it("accepts socks5h protocol", async () => {
    const mod = await import("../../src/upstream/proxy-bridge");
    parseSocksUrl = mod.parseSocksUrl;
    const r = parseSocksUrl("socks5h://u:p@proxy:2080");
    expect(r.host).toBe("proxy");
    expect(r.port).toBe(2080);
  });

  it("throws on http protocol", async () => {
    const mod = await import("../../src/upstream/proxy-bridge");
    parseSocksUrl = mod.parseSocksUrl;
    expect(() => parseSocksUrl("http://u:p@proxy:1080")).toThrow(/socks5/);
  });

  it("throws on missing host", async () => {
    const mod = await import("../../src/upstream/proxy-bridge");
    parseSocksUrl = mod.parseSocksUrl;
    // new URL() throws ERR_INVALID_URL for malformed host; our guard also covers empty hostname
    expect(() => parseSocksUrl("socks5://:pass@:1080")).toThrow();
  });

  it("throws on missing credentials", async () => {
    const mod = await import("../../src/upstream/proxy-bridge");
    parseSocksUrl = mod.parseSocksUrl;
    expect(() => parseSocksUrl("socks5://proxy:1080")).toThrow(/cred/i);
  });
});

// S-M1-2: ProxyBridge lifecycle + loopback + setUpstream
describe("ProxyBridge", () => {
  async function createBridge(overrides?: Record<string, unknown>) {
    const mod = await import("../../src/upstream/proxy-bridge");
    return new mod.ProxyBridge({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, ...overrides });
  }

  it("start returns port > 0 and isStarted becomes true", async () => {
    const bridge = await createBridge();
    expect(bridge.isStarted()).toBe(false);
    const port = await bridge.start();
    expect(port).toBeGreaterThan(0);
    expect(bridge.isStarted()).toBe(true);
    expect(bridge.getPort()).toBe(port);
    await bridge.stop();
  });

  it("getPort throws before start", async () => {
    const bridge = await createBridge();
    expect(() => bridge.getPort()).toThrow(/not started/i);
  });

  it("start is idempotent (same port on 2nd call)", async () => {
    const bridge = await createBridge();
    const p1 = await bridge.start();
    const p2 = await bridge.start();
    expect(p2).toBe(p1);
    await bridge.stop();
  });

  it("loopback: can connect to 127.0.0.1:<port> after start", async () => {
    const bridge = await createBridge();
    const port = await bridge.start();
    const sock = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      sock.on("connect", () => { sock.destroy(); resolve(); });
      sock.on("error", reject);
    });
    await bridge.stop();
  });

  it("stop: connect refused after stop", async () => {
    const bridge = await createBridge();
    const port = await bridge.start();
    await bridge.stop();
    const sock = net.createConnection({ host: "127.0.0.1", port });
    await expect(new Promise<void>((resolve, reject) => {
      sock.on("connect", () => { sock.destroy(); resolve(); });
      sock.on("error", reject);
    })).rejects.toThrow();
  });

  it("stop is idempotent", async () => {
    const bridge = await createBridge();
    await bridge.start();
    await bridge.stop();
    await bridge.stop(); // no throw
  });

  it("setUpstream → getCurrentUpstream returns the parsed upstream", async () => {
    const bridge = await createBridge();
    await bridge.start();
    bridge.setUpstream("socks5://alice:s3cret@proxy.example.com:1080");
    const cur = bridge.getCurrentUpstream();
    expect(cur).toEqual({ host: "proxy.example.com", port: 1080, user: "alice", pass: "s3cret" });
    await bridge.stop();
  });
});
