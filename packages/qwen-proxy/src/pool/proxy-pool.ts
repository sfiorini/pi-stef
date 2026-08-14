import * as tls from "node:tls";
import { Agent } from "undici";
import { SocksClient } from "socks";
import { parseSocksUrl } from "../upstream/proxy-bridge";

/** Build a REAL undici Dispatcher for a SOCKS5 upstream (with creds + TLS).
 *  socks-proxy-agent's SocksProxyAgent extends agent-base's http.Agent — it
 *  works with node-fetch/https but NOT with undici's fetch({dispatcher})
 *  ("TypeError: agent.dispatch is not a function"). This connector does the
 *  SOCKS5 handshake via SocksClient, then wraps https in tls.connect so
 *  undici gets a proper TLS socket. */
function makeSocksDispatcher(proxyKey: string): Agent {
  const upstream = parseSocksUrl(proxyKey);
  return new Agent({
    connect: ((opts: any, cb: (err: Error | null, socket?: any) => void) => {
      const port = Number(opts.port) || (String(opts.protocol ?? "https:") === "https:" ? 443 : 80);
      SocksClient.createConnection({
        command: "connect",
        proxy: { host: upstream.host, port: upstream.port, type: 5, userId: upstream.user, password: upstream.pass },
        destination: { host: opts.hostname, port },
        timeout: 10_000,
      }).then(({ socket }: { socket: any }) => {
        if (String(opts.protocol ?? "https:") === "https:") {
          const tlsSock = tls.connect({ socket, servername: opts.hostname, ALPNProtocols: ["http/1.1"] });
          tlsSock.once("secureConnect", () => cb(null, tlsSock));
          tlsSock.once("error", (e: Error) => cb(e));
        } else {
          cb(null, socket);
        }
      }).catch((e: Error) => cb(e));
    }) as any,
  });
}

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

  // Determine creds: URL creds take priority, fall back to global.
  // url.username/password are already percent-encoded by WHATWG URL;
  // globalUser/globalPass are plain strings that need encoding.
  const userFromUrl = !!url.username;
  const passFromUrl = !!url.password;
  const user = url.username || globalUser;
  const pass = url.password || globalPass;

  // Need BOTH user and pass (SOCKS5 auth requires both)
  if (!user || !pass) return null;

  // Rebuild with creds and port
  const encUser = userFromUrl ? user : encodeURIComponent(user);
  const encPass = passFromUrl ? pass : encodeURIComponent(pass);
  return `${url.protocol}//${encUser}:${encPass}@${url.hostname}:${url.port}`;
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
  /** Per-proxy serialization ledger: key → held slot (0 = free). Q2=C — assignment
   *  returns the first FREE slot (sticky-first from head), so concurrency spreads
   *  and sequential load sticks with no config special-case. */
  private readonly busy = new Map<string, number>();
  private readonly slotWaiters: Array<() => void> = [];

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

  private slotFree(key: string): boolean {
    return (this.busy.get(key) ?? 0) === 0;
  }

  /** First key with a free slot, STICKY-FIRST from the current head (head's own
   *  slot first, then wrap-around scan). Sets head to the acquired key so the
   *  next sequential request reuses it. Blocks FIFO while every slot is busy —
   *  progress is guaranteed because slots are only held by in-flight or
   *  queued requests, both of which always complete. pick() and busy.set() run
   *  in one synchronous stretch after every await, so two woken acquirers can
   *  never take the same key. */
  async acquire(): Promise<string> {
    const pick = (): string | undefined => {
      for (let i = 0; i < this.keys.length; i++) {
        const idx = (this.head + i) % this.keys.length;
        const k = this.keys[idx];
        if (this.slotFree(k)) {
          this.head = idx; // stickiness: head follows the acquisition
          return k;
        }
      }
      return undefined;
    };
    let k = pick();
    while (k === undefined) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
      k = pick();
    }
    this.busy.set(k, 1);
    return k;
  }

  /** Free the request's slot. Head unchanged — the next sequential request
   *  sticks to the last-used proxy. Wakes exactly one FIFO waiter. */
  release(key: string): void {
    this.busy.set(key, 0);
    const next = this.slotWaiters.shift();
    if (next) next();
  }
}

// ── ProxyDispatcherCache ─────────────────────────────────────────────────────

export interface DispatcherLike {
  // Minimal interface for an undici Dispatcher
  // which implements undici.Dispatcher. We type it loosely to avoid importing undici types.
  [key: string]: unknown;
}

export class ProxyDispatcherCache {
  private readonly cache = new Map<string, DispatcherLike>();
  private readonly agentFactory: (key: string) => DispatcherLike;

  constructor(opts?: { agentFactory?: (key: string) => DispatcherLike }) {
    this.agentFactory = opts?.agentFactory ?? ((key: string) => makeSocksDispatcher(key) as unknown as DispatcherLike);
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
