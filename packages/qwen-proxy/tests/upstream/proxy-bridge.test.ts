import { describe, it, expect } from "vitest";

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
