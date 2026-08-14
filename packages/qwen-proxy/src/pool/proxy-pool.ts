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
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${url.hostname}:${url.port}`;
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
    .filter((s): s is string => s !== null)
    .filter((s, i, arr) => arr.indexOf(s) === i); // dedupe (normalize canonicalized)
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

  /** Drop + rebuild the cached agent for a key. Currently test-only / reserved —
   *  not yet wired into the rotation path (rotation requeues without recreating).
   *  Intended for future use: recreate a proxy's agent on persistent connect-fail. */
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

export interface NordServer {
  hostname: string;
  load: number;
  locations: Array<{ country: { code: string } }>;
}

export async function discoverNordSocks(opts: {
  count: number;
  countriesRaw: string;
  fetcher: (url: string, init: any) => Promise<Response>;
  log?: { warn: (msg: string, ...args: unknown[]) => void };
}): Promise<string[]> {
  const { count, countriesRaw, fetcher, log } = opts;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000); // bound startup — never hang on a stalled NordVPN API
    let res: Response;
    try {
      res = await fetcher("https://api.nordvpn.com/v1/servers?filters[servers_technologies][identifier]=socks&limit=0", { method: "GET", signal: controller.signal });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    clearTimeout(timer);
    if (!res.ok) {
      log?.warn("NordVPN API returned non-OK status", { status: res.status });
      return [];
    }

    const servers: NordServer[] = await res.json();

    // Filter by country BEFORE sort
    let filtered = servers;
    if (countriesRaw.trim()) {
      const allowed = new Set(
        countriesRaw.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean)
      );
      filtered = servers.filter(s =>
        s.locations?.some(loc => allowed.has(loc.country?.code?.toLowerCase()))
      );
    }

    // Sort by load ascending (missing load → bottom)
    filtered.sort((a, b) => {
      const la = a.load ?? Infinity;
      const lb = b.load ?? Infinity;
      return la - lb;
    });

    // Take N
    const taken = filtered.slice(0, count);

    // Map to hostnames
    return taken.map(s => s.hostname);
  } catch (err) {
    log?.warn("NordVPN discovery failed", { error: err });
    return [];
  }
}

export interface CreateProxyPoolOpts {
  proxyUrlsRaw: string;
  proxyCount: number;
  proxyUser?: string;
  proxyPass?: string;
  proxyCountriesRaw?: string;
  log?: { warn: (msg: string, ...args: unknown[]) => void };
  fetcher?: (url: string, init: any) => Promise<Response>;
}

export async function createProxyPool(opts: CreateProxyPoolOpts): Promise<ProxyPool> {
  const { proxyUrlsRaw, proxyUser, proxyPass, proxyCountriesRaw = "", proxyCount, log, fetcher } = opts;

  // Explicit URLs win over discovery
  if (proxyUrlsRaw.trim()) {
    const keys = parseProxyUrls(proxyUrlsRaw, proxyUser, proxyPass);
    return new ProxyPool(keys);
  }

  // Discovery requires creds + fetcher
  if (!proxyUser || !proxyPass) {
    log?.warn("Proxy discovery requires SF_QWEN_PROXY_USER and SF_QWEN_PROXY_PASS");
    return new ProxyPool([]);
  }

  if (!fetcher) {
    log?.warn("Proxy discovery requires a fetcher");
    return new ProxyPool([]);
  }

  // Discover NordVPN SOCKS5 servers
  const hostnames = await discoverNordSocks({
    count: proxyCount,
    countriesRaw: proxyCountriesRaw,
    fetcher,
    log,
  });

  if (hostnames.length === 0) {
    log?.warn("No usable SOCKS5 proxies discovered");
    return new ProxyPool([]);
  }

  if (hostnames.length < proxyCount) {
    log?.warn("Discovered fewer proxies than requested", { discovered: hostnames.length, requested: proxyCount });
  }

  // Build keys with creds
  const keys = hostnames.map(h => `socks5://${encodeURIComponent(opts.proxyUser!)}:${encodeURIComponent(opts.proxyPass!)}@${h}:1080`);
  return new ProxyPool(keys);
}
