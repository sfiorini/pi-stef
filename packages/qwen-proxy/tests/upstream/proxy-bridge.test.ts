import { describe, it, expect, vi } from "vitest";
import * as net from "node:net";
import { ProxyBridge } from "../../src/upstream/proxy-bridge";
import { normalizeSocksUrl } from "../../src/pool/proxy-pool";

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

  it("round-trip: normalizeSocksUrl → parseSocksUrl preserves creds with special chars", async () => {
    const mod = await import("../../src/upstream/proxy-bridge");
    parseSocksUrl = mod.parseSocksUrl;
    // User provides creds with special chars (e.g. @ encoded as %40)
    const input = "socks5://us%40er:p%40ss@proxy:1080";
    const normalized = normalizeSocksUrl(input, undefined, undefined);
    expect(normalized).not.toBeNull();
    const parsed = parseSocksUrl(normalized!);
    expect(parsed.user).toBe("us@er");
    expect(parsed.pass).toBe("p@ss");
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

// ── S-M1-3: SOCKS5 handshake tests ────────────────────────────────────────

describe("ProxyBridge SOCKS5 handshake", () => {
  async function bridgeAndConnect() {
    const bridge = new ProxyBridge({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const port = await bridge.start();
    const sock = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((res, rej) => { sock.on("connect", res); sock.on("error", rej); });
    return { bridge, sock };
  }
  function readN(sock: net.Socket, n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let total = 0;
      const onData = (c: Buffer) => { chunks.push(c); total += c.length; if (total >= n) { sock.off("data", onData); resolve(Buffer.concat(chunks).subarray(0, n)); } };
      const onEnd = () => { sock.off("data", onData); reject(new Error("closed")); };
      sock.on("data", onData); sock.once("close", onEnd);
      setTimeout(() => { sock.off("data", onData); sock.off("close", onEnd); reject(new Error("timeout")); }, 2000);
    });
  }

  it("no-auth accept: 05 01 00 → reply 05 00", async () => {
    const { bridge, sock } = await bridgeAndConnect();
    try { sock.write(Buffer.from([0x05, 0x01, 0x00])); const r = await readN(sock, 2); expect(r[0]).toBe(0x05); expect(r[1]).toBe(0x00); }
    finally { sock.destroy(); await bridge.stop(); }
  });
  it("no-acceptable-auth: 05 01 02 → reply 05 FF", async () => {
    const { bridge, sock } = await bridgeAndConnect();
    try { sock.write(Buffer.from([0x05, 0x01, 0x02])); const r = await readN(sock, 2); expect(r[1]).toBe(0xFF); }
    finally { sock.destroy(); await bridge.stop(); }
  });
  it("CMD≠CONNECT → REP 0x07", async () => {
    const { bridge, sock } = await bridgeAndConnect();
    try { sock.write(Buffer.from([0x05, 0x01, 0x00])); await readN(sock, 2); sock.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0, 80])); const r = await readN(sock, 2); expect(r[1]).toBe(0x07); }
    finally { sock.destroy(); await bridge.stop(); }
  });
  it("unrecognized ATYP → REP 0x08", async () => {
    const { bridge, sock } = await bridgeAndConnect();
    try { sock.write(Buffer.from([0x05, 0x01, 0x00])); await readN(sock, 2); sock.write(Buffer.from([0x05, 0x01, 0x00, 0x09])); const r = await readN(sock, 2); expect(r[1]).toBe(0x08); }
    finally { sock.destroy(); await bridge.stop(); }
  });
});

// ── S-M1-4: ProxyBridge forwarding tests ───────────────────────────────────

describe("ProxyBridge forwarding", () => {
  const PROXY_A = "socks5://alice:passA@proxy-a:1080";
  const PROXY_B = "socks5://bob:passB@proxy-b:2080";

  function readN(sock: net.Socket, n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []; let total = 0;
      const onData = (c: Buffer) => { chunks.push(c); total += c.length; if (total >= n) { sock.off("data", onData); resolve(Buffer.concat(chunks).subarray(0, n)); } };
      const onEnd = () => { sock.off("data", onData); reject(new Error("closed")); };
      sock.on("data", onData); sock.once("close", onEnd);
      setTimeout(() => { sock.off("data", onData); sock.off("close", onEnd); reject(new Error("timeout")); }, 3000);
    });
  }

  /** Complete the SOCKS5 handshake + CONNECT on a client socket */
  async function socks5Connect(sock: net.Socket, destHost: string, destPort: number) {
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
    await readN(sock, 2); // 05 00
    const hostBuf = Buffer.from(destHost, "utf-8");
    const connectReq = Buffer.alloc(7 + hostBuf.length);
    connectReq[0] = 0x05;
    connectReq[1] = 0x01;
    connectReq[2] = 0x00;
    connectReq[3] = 0x03; // ATYP domain
    connectReq[4] = hostBuf.length;
    hostBuf.copy(connectReq, 5);
    connectReq.writeUInt16BE(destPort, 5 + hostBuf.length);
    sock.write(connectReq);
  }

  function makeFakeSocksClient(rejectWith?: Error) {
    const calls: any[] = [];
    return {
      createConnection: vi.fn(async (opts: any) => {
        calls.push(opts);
        if (rejectWith) throw rejectWith;
        // Return {socket} to match socks library return shape
        const echoServer = net.createServer((s) => s.pipe(s));
        await new Promise<void>((res) => echoServer.listen(0, "127.0.0.1", res));
        const echoPort = (echoServer.address() as net.AddressInfo).port;
        const remote = net.createConnection({ host: "127.0.0.1", port: echoPort });
        await new Promise<void>((res, rej) => { remote.on("connect", res); remote.on("error", rej); });
        remote.once("close", () => echoServer.close());
        return { socket: remote };
      }),
      calls,
    };
  }

  it("CONNECT uses currentUpstream creds + destination domain", async () => {
    const fake = makeFakeSocksClient();
    const bridge = new ProxyBridge({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, socksClient: fake as any });
    await bridge.start();
    bridge.setUpstream(PROXY_A);

    const sock = net.createConnection({ host: "127.0.0.1", port: bridge.getPort() });
    await new Promise<void>((res, rej) => { sock.on("connect", res); sock.on("error", rej); });
    await socks5Connect(sock, "chat.qwen.ai", 443);
    const reply = await readN(sock, 10);
    expect(reply[0]).toBe(0x05);
    expect(reply[1]).toBe(0x00); // success

    expect(fake.createConnection).toHaveBeenCalledTimes(1);
    const opts = fake.calls[0];
    expect(opts.command).toBe("connect");
    expect(opts.destination).toEqual({ host: "chat.qwen.ai", port: 443 });
    expect(opts.proxy.host).toBe("proxy-a");
    expect(opts.proxy.port).toBe(1080);
    expect(opts.proxy.userId).toBe("alice");
    expect(opts.proxy.password).toBe("passA");
    expect(opts.proxy.type).toBe(5);

    sock.destroy();
    await bridge.stop();
  });

  it("setUpstream swap — sequential CONNECTs use different creds", async () => {
    const fake = makeFakeSocksClient();
    const bridge = new ProxyBridge({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, socksClient: fake as any });
    await bridge.start();

    bridge.setUpstream(PROXY_A);
    const sock1 = net.createConnection({ host: "127.0.0.1", port: bridge.getPort() });
    await new Promise<void>((res, rej) => { sock1.on("connect", res); sock1.on("error", rej); });
    await socks5Connect(sock1, "host1.com", 443);
    await readN(sock1, 10);
    expect(fake.calls[0].proxy.userId).toBe("alice");
    sock1.destroy();

    bridge.setUpstream(PROXY_B);
    const sock2 = net.createConnection({ host: "127.0.0.1", port: bridge.getPort() });
    await new Promise<void>((res, rej) => { sock2.on("connect", res); sock2.on("error", rej); });
    await socks5Connect(sock2, "host2.com", 443);
    await readN(sock2, 10);
    expect(fake.calls[1].proxy.userId).toBe("bob");
    expect(fake.calls[1].proxy.host).toBe("proxy-b");
    sock2.destroy();

    await bridge.stop();
  });

  it("bidirectional pipe — data flows both directions", async () => {
    const fake = makeFakeSocksClient();
    const bridge = new ProxyBridge({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, socksClient: fake as any });
    await bridge.start();
    bridge.setUpstream(PROXY_A);

    const client = net.createConnection({ host: "127.0.0.1", port: bridge.getPort() });
    await new Promise<void>((res, rej) => { client.on("connect", res); client.on("error", rej); });
    await socks5Connect(client, "echo.local", 7);
    await readN(client, 10);

    const testMsg = "hello-bridge";
    client.write(testMsg);
    const echoed = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const onData = (c: Buffer) => { chunks.push(c); if (Buffer.concat(chunks).length >= testMsg.length) { client.off("data", onData); resolve(Buffer.concat(chunks)); } };
      client.on("data", onData);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });
    expect(echoed.toString()).toBe(testMsg);

    client.destroy();
    await bridge.stop();
  });

  it("upstream error → REP 0x01", async () => {
    const fake = makeFakeSocksClient(new Error("connection refused"));
    const bridge = new ProxyBridge({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, socksClient: fake as any });
    await bridge.start();
    bridge.setUpstream(PROXY_A);

    const sock = net.createConnection({ host: "127.0.0.1", port: bridge.getPort() });
    await new Promise<void>((res, rej) => { sock.on("connect", res); sock.on("error", rej); });
    await socks5Connect(sock, "unreachable.com", 443);
    const reply = await readN(sock, 10);
    expect(reply[0]).toBe(0x05);
    expect(reply[1]).toBe(0x01); // general failure

    sock.destroy();
    await bridge.stop();
  });

  it("no upstream set → REP 0x01", async () => {
    const fake = makeFakeSocksClient();
    const bridge = new ProxyBridge({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, socksClient: fake as any });
    await bridge.start();
    // No setUpstream call

    const sock = net.createConnection({ host: "127.0.0.1", port: bridge.getPort() });
    await new Promise<void>((res, rej) => { sock.on("connect", res); sock.on("error", rej); });
    await socks5Connect(sock, "chat.qwen.ai", 443);
    const reply = await readN(sock, 10);
    expect(reply[0]).toBe(0x05);
    expect(reply[1]).toBe(0x01); // general failure

    sock.destroy();
    await bridge.stop();
  });

  // P3: pipeBoth should destroy peer on 'close' (not just 'error')
  it("client close → destroys remote socket (no FD leak)", async () => {
    let remoteSocket: net.Socket | undefined;
    const fake = {
      createConnection: vi.fn(async () => {
        const echoServer = net.createServer((s) => s.pipe(s));
        await new Promise<void>((res) => echoServer.listen(0, "127.0.0.1", res));
        const echoPort = (echoServer.address() as net.AddressInfo).port;
        const remote = net.createConnection({ host: "127.0.0.1", port: echoPort });
        await new Promise<void>((res, rej) => { remote.on("connect", res); remote.on("error", rej); });
        remote.once("close", () => echoServer.close());
        remoteSocket = remote;
        return { socket: remote };
      }),
    };
    const bridge = new ProxyBridge({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, socksClient: fake as any });
    await bridge.start();
    bridge.setUpstream(PROXY_A);

    const client = net.createConnection({ host: "127.0.0.1", port: bridge.getPort() });
    await new Promise<void>((res, rej) => { client.on("connect", res); client.on("error", rej); });
    await socks5Connect(client, "echo.local", 7);
    await readN(client, 10);
    // Bidirectional pipe is now active.

    // Simulate Chromium SIGKILL: destroy the client socket (emits 'close', not 'error')
    const remoteClosed = new Promise<void>((resolve) => {
      remoteSocket!.once("close", () => resolve());
    });
    client.destroy(); // emits 'close' on client

    // Remote should be destroyed within a short timeout
    await expect(remoteClosed).resolves.toBeUndefined();
    expect(remoteSocket!.destroyed).toBe(true);

    await bridge.stop();
  });

  it("remote close → destroys client socket (reverse direction)", async () => {
    let remoteSocket: net.Socket | undefined;
    const fake = {
      createConnection: vi.fn(async () => {
        const echoServer = net.createServer((s) => s.pipe(s));
        await new Promise<void>((res) => echoServer.listen(0, "127.0.0.1", res));
        const echoPort = (echoServer.address() as net.AddressInfo).port;
        const remote = net.createConnection({ host: "127.0.0.1", port: echoPort });
        await new Promise<void>((res, rej) => { remote.on("connect", res); remote.on("error", rej); });
        remote.once("close", () => echoServer.close());
        remoteSocket = remote;
        return { socket: remote };
      }),
    };
    const bridge = new ProxyBridge({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, socksClient: fake as any });
    await bridge.start();
    bridge.setUpstream(PROXY_A);

    const client = net.createConnection({ host: "127.0.0.1", port: bridge.getPort() });
    await new Promise<void>((res, rej) => { client.on("connect", res); client.on("error", rej); });
    await socks5Connect(client, "echo.local", 7);
    await readN(client, 10);

    // Simulate upstream disconnect: destroy remote socket
    const clientClosed = new Promise<void>((resolve) => {
      client.once("close", () => resolve());
    });
    remoteSocket!.destroy();

    await expect(clientClosed).resolves.toBeUndefined();
    expect(client.destroyed).toBe(true);

    await bridge.stop();
  });
});

// ── P0 regression: mid-lifecycle socket errors must never crash the process ─
describe("ProxyBridge socket error resilience (ECONNRESET regression)", () => {
  it("client socket destroyed mid-handshake → no unhandled error, bridge survives", async () => {
    const { ProxyBridge: PB } = await import("../../src/upstream/proxy-bridge");
    const bridge = new PB({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const port = await bridge.start();
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((res, rej) => { sock.on("connect", res); sock.on("error", rej); });
      // Send a partial greeting then abruptly destroy (RST-like) — the bridge's
      // readN is pending when the socket dies; without the lifetime error
      // handler this becomes an unhandled 'error' event and crashes the process.
      sock.write(Buffer.from([0x05, 0x01]));
      sock.destroy();
      await new Promise((r) => setTimeout(r, 100));
      // Bridge still accepts new connections (did not crash):
      const sock2 = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((res, rej) => { sock2.on("connect", res); sock2.on("error", rej); });
      sock2.write(Buffer.from([0x05, 0x01, 0x00]));
      const reply = await new Promise<Buffer>((res, rej) => {
        sock2.once("data", (d: Buffer) => res(d));
        setTimeout(() => rej(new Error("no reply")), 2000);
      });
      expect(reply[0]).toBe(0x05); // handshake still works
      sock2.destroy();
    } finally {
      await bridge.stop();
    }
  });

  it("error emitted on client socket post-accept → destroyed, no unhandled throw", async () => {
    const { ProxyBridge: PB } = await import("../../src/upstream/proxy-bridge");
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bridge = new PB({ log });
    const port = await bridge.start();
    // Capture the SERVER-side socket (the bridge's end) via a connection spy
    const serverSockets: net.Socket[] = [];
    (bridge as any)["server"]?.on?.("connection", (s: net.Socket) => serverSockets.push(s));
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((res, rej) => { sock.on("connect", res); sock.on("error", rej); });
      await new Promise((r) => setTimeout(r, 50)); // let the server accept + attach the lifetime handler
      const serverSide = serverSockets[serverSockets.length - 1];
      expect(serverSide).toBeDefined();
      // Simulate an ECONNRESET-shaped error on the SERVER-side socket (the one
      // the bridge owns). Without the lifetime handler this is an unhandled
      // 'error' event → process crash. Vitest fails on unhandled throws, so
      // reaching the assertion below proves the handler swallowed it.
      (serverSide as any).emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(serverSide.destroyed).toBe(true);
    } finally {
      await bridge.stop();
    }
  });
});
