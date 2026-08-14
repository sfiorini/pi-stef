import { SocksProxyAgent } from "socks-proxy-agent";

// ── normalizeSocksUrl ───────────────────────────────────────────────────────

export function normalizeSocksUrl(
  raw: string,
  globalUser: string | undefined,
  globalPass: string | undefined,
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // Protocol must be socks5 or socks5h
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") return null;
  if (!url.hostname) return null;

  // Default port to 1080
  if (!url.port) url.port = "1080";

  // Determine creds: URL creds take priority, fall back to global
  const user = url.username || globalUser;
  const pass = url.password || globalPass;

  // Need BOTH user and pass (SOCKS5 auth requires both)
  if (!user || !pass) return null;

  // Rebuild with creds and port
  return `${url.protocol}//${user}:${pass}@${url.hostname}:${url.port}`;
}

// ── parseProxyUrls ──────────────────────────────────────────────────────────

export function parseProxyUrls(
  raw: string,
  globalUser: string | undefined,
  globalPass: string | undefined,
): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => normalizeSocksUrl(s, globalUser, globalPass))
    .filter((s): s is string => s !== null);
}

// ── ProxyPool ────────────────────────────────────────────────────────────────

export class ProxyPool {
  private readonly keys: string[];
  private head: number;

  constructor(keys: string[]) {
    this.keys = keys;
    this.head = 0;
  }

  get size(): number {
    return this.keys.length;
  }

  getActive(): string | undefined {
    return this.keys[this.head];
  }

  rotate(): string | undefined {
    if (this.keys.length <= 1) return this.keys[this.head];
    this.head = (this.head + 1) % this.keys.length;
    return this.keys[this.head];
  }

  getKeys(): string[] {
    return [...this.keys];
  }
}

// ── ProxyDispatcherCache ─────────────────────────────────────────────────────

export interface DispatcherLike {
  // Minimal interface for undici Dispatcher — socks-proxy-agent returns SocksProxyAgent
  // which implements undici.Dispatcher. We type it loosely to avoid importing undici types.
  [key: string]: unknown;
}

export class ProxyDispatcherCache {
  private readonly cache = new Map<string, DispatcherLike>();
  private readonly agentFactory: (key: string) => DispatcherLike;

  constructor(opts?: { agentFactory?: (key: string) => DispatcherLike }) {
    this.agentFactory = opts?.agentFactory ?? ((key: string) => new SocksProxyAgent(key) as unknown as DispatcherLike);
  }

  get(key: string): DispatcherLike {
    let agent = this.cache.get(key);
    if (!agent) {
      agent = this.agentFactory(key);
      this.cache.set(key, agent);
    }
    return agent;
  }

  recreate(key: string): DispatcherLike {
    this.cache.delete(key);
    const agent = this.agentFactory(key);
    this.cache.set(key, agent);
    return agent;
  }
}

// ── fetchWithProxy ───────────────────────────────────────────────────────────

export async function fetchWithProxy(
  fetcher: (url: string, init: any) => Promise<Response>,
  url: string,
  init: any,
  dispatcher?: DispatcherLike,
): Promise<Response> {
  if (dispatcher) {
    return fetcher(url, { ...init, dispatcher });
  }
  return fetcher(url, init);
}

// ── createProxyPool ──────────────────────────────────────────────────────────

export interface CreateProxyPoolOpts {
  proxyUrlsRaw: string;
  proxyCount: number;
  proxyUser?: string;
  proxyPass?: string;
  proxyCountriesRaw?: string;
  log?: { warn: (msg: string, ...args: unknown[]) => void };
}

export async function createProxyPool(opts: CreateProxyPoolOpts): Promise<ProxyPool> {
  const { proxyUrlsRaw, proxyUser, proxyPass } = opts;

  // Explicit URLs win over discovery
  if (proxyUrlsRaw.trim()) {
    const keys = parseProxyUrls(proxyUrlsRaw, proxyUser, proxyPass);
    return new ProxyPool(keys);
  }

  // Discovery stub (filled S-M1-4) — returns empty pool
  return new ProxyPool([]);
}
