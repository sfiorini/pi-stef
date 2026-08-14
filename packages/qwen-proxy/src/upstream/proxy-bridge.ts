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
  private handleConnection(socket: net.Socket): void {
    // Stub: destroy immediately until handshake logic is added in S-M1-3
    void this.socksClient; // will be used in S-M1-4 forwarding
    void this.log; // will be used in S-M1-3 handshake
    socket.destroy();
  }
}
