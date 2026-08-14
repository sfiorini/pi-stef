/**
 * ProxyBridge — local SOCKS5-no-auth loopback server that injects upstream
 * NordVPN SOCKS5 credentials.  Per-proxy Baxia token affinity.
 */

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
