/**
 * ProxyBridge — local SOCKS5-no-auth loopback server that injects upstream
 * NordVPN SOCKS5 credentials.  Per-proxy Baxia token affinity.
 */

import * as net from "node:net";
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

// ── ProxyBridge ─────────────────────────────────────────────────────────────

export interface ProxyBridgeConfig {
  log: Logger;
  socksClient?: typeof import("socks").SocksClient;
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
  private readonly socksClient: typeof import("socks").SocksClient;

  constructor(config: ProxyBridgeConfig) {
    this.log = config.log;
    this.socksClient = (config.socksClient ?? (require("socks") as typeof import("socks")).SocksClient) as typeof import("socks").SocksClient;
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
   * (Stub — will be implemented in S-M1-3/S-M1-4.)
   */
  private async handleConnection(socket: net.Socket): Promise<void> {
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
      void host; void port; void this.socksClient; void this.log;
      socket.destroy();
    } catch {
      socket.destroy();
    }
  }
}
