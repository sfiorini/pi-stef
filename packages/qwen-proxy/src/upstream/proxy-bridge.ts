/**
 * ProxyBridge — local SOCKS5-no-auth loopback server that injects upstream
 * NordVPN SOCKS5 credentials.  Per-proxy Baxia token affinity.
 */

import * as net from "node:net";
import { SocksClient } from "socks";
import type { Logger } from "../server/logger";

// ── parseSocksUrl ───────────────────────────────────────────────────────────

export interface ParsedSocksUrl {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * Parse a `socks5://user:pass@host:port` or `socks5h://…` URL.
 * @throws on missing host, missing credentials, or unsupported protocol.
 */
export function parseSocksUrl(key: string): ParsedSocksUrl {
  const url = new URL(key);
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") {
    throw new Error(`parseSocksUrl: unsupported protocol "${url.protocol}" (expected socks5: or socks5h:)`);
  }
  if (!url.hostname) {
    throw new Error(`parseSocksUrl: missing host in "${key}"`);
  }
  if (!url.username || !url.password) {
    throw new Error(`parseSocksUrl: missing credentials (user:pass) in "${key}"`);
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 1080,
    user: decodeURIComponent(url.username),
    pass: decodeURIComponent(url.password),
  };
}

/** Log-safe form of a proxy key: host:port only (never credentials). */
export function redactProxyKey(key: string | undefined): string {
  if (key === undefined || key === "") return "(direct)";
  try {
    const u = new URL(key);
    if (!u.hostname) return "(unparsed)";
    return `${u.hostname}:${u.port || "1080"}`;
  } catch {
    return "(unparsed)";
  }
}

// ── ProxyBridge ─────────────────────────────────────────────────────────────

export interface ProxyBridgeConfig {
  log: Logger;
  socksClient?: typeof SocksClient;
}

/**
 * Local SOCKS5-no-auth loopback bridge.
 * Chromium connects to 127.0.0.1:<port>, the bridge reads the SOCKS5
 * CONNECT request, then forwards the connection through the upstream
 * SOCKS5 proxy with injected credentials.
 */
export class ProxyBridge {
  private server: net.Server | null = null;
  private port: number | null = null;
  private currentUpstream: ParsedSocksUrl | null = null;
  private readonly log: Logger;
  private readonly socksClient: typeof SocksClient;

  constructor(config: ProxyBridgeConfig) {
    this.log = config.log;
    this.socksClient = config.socksClient ?? SocksClient;
  }

  /**
   * Start the loopback SOCKS5 server on 127.0.0.1.
   * @returns the assigned port
   */
  async start(): Promise<number> {
    if (this.server) return this.port!;
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.on("connection", (socket) => this.handleConnection(socket));
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        this.port = (server.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  /**
   * Stop the server.  Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.port = null;
    return new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  /**
   * Get the port.  Throws if not started.
   */
  getPort(): number {
    if (this.port === null) throw new Error("ProxyBridge: not started");
    return this.port;
  }

  /**
   * Whether the server is listening.
   */
  isStarted(): boolean {
    return this.server !== null;
  }

  /**
   * Set the current upstream proxy (parsed from socks5 URL).
   */
  setUpstream(key: string): void {
    this.currentUpstream = parseSocksUrl(key);
  }

  /**
   * Get the current upstream proxy (null if not set).
   */
  getCurrentUpstream(): ParsedSocksUrl | null {
    return this.currentUpstream;
  }

  /**
   * Handle a new connection from Chromium.
   * (SOCKS5 handshake + forwarding — implemented in S-M1-3/S-M1-4.)
   */
  private async handleConnection(socket: net.Socket): Promise<void> {
    // Lifetime error handler — installed BEFORE any await so a mid-lifecycle
    // ECONNRESET (Chromium resetting a connection) can never become an unhandled
    // 'error' event (which would crash the process). Destroying is the correct
    // response; any pending readN rejects via its own close/error handling.
    socket.on("error", () => socket.destroy());
    const VER = 0x05, AUTH_NONE = 0x00, AUTH_NO_ACCEPTABLE = 0xFF;
    const CMD_CONNECT = 0x01, REP_CMD_NOT_SUPPORTED = 0x07, REP_ATYP_NOT_SUPPORTED = 0x08;
    const ATYP_IPV4 = 0x01, ATYP_DOMAIN = 0x03, ATYP_IPV6 = 0x04;

    let excess = Buffer.alloc(0);
    const readN = async (n: number): Promise<Buffer> => {
      if (excess.length >= n) { const r = excess.subarray(0, n); excess = excess.subarray(n); return r; }
      return new Promise((resolve, reject) => {
        let buf = excess; excess = Buffer.alloc(0);
        const onData = (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length >= n) { off(); excess = buf.subarray(n); resolve(buf.subarray(0, n)); }
        };
        const off = () => { socket.off("data", onData); socket.off("close", onEnd); socket.off("error", onEnd); };
        const onEnd = (e?: Error) => { off(); reject(e ?? new Error("socket closed during readN")); };
        socket.on("data", onData); socket.once("close", onEnd); socket.once("error", onEnd);
      });
    };

    const rep = (code: number) => socket.write(Buffer.from([VER, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));

    try {
      // Phase 1: Method negotiation
      const head = await readN(2);
      if (head[0] !== VER) { socket.destroy(); return; }
      const methods = await readN(head[1]);
      if (!methods.includes(AUTH_NONE)) { rep(AUTH_NO_ACCEPTABLE); socket.end(); return; }
      socket.write(Buffer.from([VER, AUTH_NONE]));

      // Phase 2: CONNECT request
      const req = await readN(4);
      if (req[0] !== VER) { socket.destroy(); return; }
      if (req[1] !== CMD_CONNECT) { rep(REP_CMD_NOT_SUPPORTED); socket.end(); return; }
      let host: string;
      const atyp = req[3];
      if (atyp === ATYP_IPV4) {
        host = Array.from(await readN(4)).join(".");
      } else if (atyp === ATYP_DOMAIN) {
        const len = await readN(1);
        host = (await readN(len[0])).toString("utf-8");
      } else if (atyp === ATYP_IPV6) {
        const b = await readN(16);
        host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(":");
      } else {
        rep(REP_ATYP_NOT_SUPPORTED); socket.end(); return;
      }
      const port = (await readN(2)).readUInt16BE(0);

      // Phase 3: Forward via upstream (S-M1-4)
      await this.handleConnect(socket, host, port);
    } catch {
      socket.destroy();
    }
  }

  private async handleConnect(client: net.Socket, host: string, port: number): Promise<void> {
    const VER = 0x05, REP_GENERAL_FAILURE = 0x01;
    const rep = (code: number) => client.write(Buffer.from([VER, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));

    // Read upstream at CONNECT time (swap-safe)
    const upstream = this.currentUpstream;
    if (!upstream) {
      this.log.warn("ProxyBridge: no upstream set, rejecting CONNECT");
      rep(REP_GENERAL_FAILURE);
      client.end();
      return;
    }

    try {
      const { socket: remote } = await this.socksClient.createConnection({
        command: "connect",
        destination: { host, port },
        proxy: {
          host: upstream.host,
          port: upstream.port,
          type: 5,
          userId: upstream.user,
          password: upstream.pass,
        },
        timeout: 10_000,
      });

      // Lifetime error handler on the remote socket too — before piping, so an
      // upstream reset can never become an unhandled 'error' event (crash).
      remote.on("error", () => remote.destroy());
      // Success reply: BND.ADDR = 127.0.0.1:0 (placeholder)
      client.write(Buffer.from([VER, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
      this.pipeBoth(client, remote);
    } catch (err) {
      this.log.warn("ProxyBridge: upstream connect failed", { error: String(err), host, port });
      rep(REP_GENERAL_FAILURE);
      client.end();
    }
  }

  private pipeBoth(a: net.Socket, b: net.Socket): void {
    a.pipe(b);
    b.pipe(a);
    let done = false;
    const onDone = () => {
      if (done) return;
      done = true;
      a.destroy();
      b.destroy();
    };
    a.on("error", onDone);
    b.on("error", onDone);
    // Also handle 'close' — e.g. Chromium SIGKILL emits 'close' not 'error'.
    // Without this, the upstream 'remote' socket lingers until SOCKS5 keep-alive timeout.
    a.once("close", () => b.destroy());
    b.once("close", () => a.destroy());
  }
}
