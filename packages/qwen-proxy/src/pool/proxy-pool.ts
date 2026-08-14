import { SocksProxyAgent } from "socks-proxy-agent";

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
