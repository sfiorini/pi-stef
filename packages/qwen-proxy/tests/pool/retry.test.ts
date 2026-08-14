import { describe, it, expect } from "vitest";
import {
  withPoolRetry,
  withPoolRetryStream,
  isContentChunk,
  isRotationTrigger,
  type RetryDeps,
  type StreamChunk,
  type ProxyPoolLike,
} from "../../src/pool/retry";
import type { RequestThrottle as RequestThrottleType } from "../../src/pool/throttle";
import {
  RateLimitError,
  AuthExpiredError,
  ClientError,
  ServerError,
  NetworkError,
  UnknownError,
  EmptyCompletionError,
  TokenMintError,
} from "../../src/upstream/errors";
import type { OpenAiChatChunk } from "../../src/upstream/client";
import type { Logger } from "../../src/server/logger";
import { SingleAccountPool } from "../../src/pool/single";

/** Fake multi-account PoolLike for retry.ts failover tests.
 *  Exercises the markEmptyAndSwitch branch of retry.ts without a DB. */
import type { PoolLike } from "../../src/pool/types";

class FakeMultiPool implements PoolLike {
  private ids: number[];
  private activeIdx = 0;
  private disabled = new Set<number>();
  constructor(ids: number[]) { this.ids = ids; }
  getActiveAccount() {
    const id = this.ids[this.activeIdx];
    return { id, bearer: `b-${id}`, expiresAt: null };
  }
  async markEmptyAndSwitch(failedId: number, _cooldownMs: number) {
    this.disabled.add(failedId);
    const next = this.ids.find((i) => !this.disabled.has(i));
    if (next !== undefined) { this.activeIdx = this.ids.indexOf(next); }
    return { newActiveId: next !== undefined ? next : null, earliestReEnableAt: null };
  }
  markSuccess(): void {}
  earliestReEnableAt() { return null; }
}

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeDeps(
  overrides?: Partial<RetryDeps>,
): RetryDeps {
  return {
    pool: new FakeMultiPool([1, 2, 3]),
    scheduler: {
      refreshOnDemand: async () => ({
        bearer: "refreshed-bearer",
        expiresAt: 999999,
      }),
    },
    config: { emptyCooldownMs: 600_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000 },
    log: noopLog,
    ...overrides,
  };
}

// ── OpenAiChatChunk test stubs ──────────────────────────────────────────────

function contentChunk(content: string): OpenAiChatChunk {
  return { choices: [{ delta: { content } }] };
}

function reasoningChunk(reasoning: string): OpenAiChatChunk {
  return { choices: [{ delta: { reasoning_content: reasoning } }] };
}

function finishChunk(finishReason: string): OpenAiChatChunk {
  return { choices: [{ delta: {}, finish_reason: finishReason }] };
}

// ── isContentChunk ──────────────────────────────────────────────────────────

describe("isContentChunk", () => {
  it("returns true for chunk with delta.content", () => {
    expect(isContentChunk(contentChunk("hello"))).toBe(true);
  });

  it("returns false for chunk with delta.reasoning_content (buffered, not live)", () => {
    // 2026-08-14 hotfix: reasoning is NOT visible payload — pre-visible
    // chunks buffer so a reasoning-only attempt is fully retractable on retry.
    expect(isContentChunk(reasoningChunk("thinking..."))).toBe(false);
  });

  it("returns false for chunk with no content or reasoning_content", () => {
    expect(isContentChunk({ choices: [{ delta: {} }] })).toBe(false);
  });

  it("returns false for chunk with empty content string", () => {
    expect(isContentChunk({ choices: [{ delta: { content: "" } }] })).toBe(false);
  });

  it("returns false for finish_reason-only chunk", () => {
    expect(isContentChunk(finishChunk("stop"))).toBe(false);
  });
});

// ── isRotationTrigger ──────────────────────────────────────────────────────

describe("isRotationTrigger", () => {
  // Rotatable errors — should return true
  it("EmptyCompletionError → true (rotatable)", () => {
    expect(isRotationTrigger(new EmptyCompletionError("empty"))).toBe(true);
  });

  it("NetworkError → true (rotatable)", () => {
    expect(isRotationTrigger(new NetworkError("timeout"))).toBe(true);
  });

  it("ServerError 5xx → true (rotatable)", () => {
    expect(isRotationTrigger(new ServerError("bad gateway", { status: 502 }))).toBe(true);
  });

  it("TypeError → true (rotatable)", () => {
    expect(isRotationTrigger(new TypeError("fetch failed"))).toBe(true);
  });

  it("AbortError (name-based) → true (rotatable)", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isRotationTrigger(err)).toBe(true);
  });

  it("generic Error (residual) → true (rotatable)", () => {
    expect(isRotationTrigger(new Error("SOCKS connect ECONNREFUSED"))).toBe(true);
  });

  // Terminal errors — should return false
  it("ClientError 4xx → false (terminal)", () => {
    expect(isRotationTrigger(new ClientError("bad request", { status: 400 }))).toBe(false);
  });

  it("ClientError data_inspection 400 → false (terminal)", () => {
    expect(isRotationTrigger(new ClientError("data_inspection_failed", { status: 400 }))).toBe(false);
  });

  it("RateLimitError → false (terminal)", () => {
    expect(isRotationTrigger(new RateLimitError("rate limited", { status: 429 }))).toBe(false);
  });

  it("UnknownError → false (terminal)", () => {
    expect(isRotationTrigger(new UnknownError("unknown"))).toBe(false);
  });

  // TokenMintError — rotatable (both causes)
  it("TokenMintError(egress) → true (rotatable)", () => {
    expect(isRotationTrigger(new TokenMintError("egress", "x"))).toBe(true);
  });

  it("TokenMintError(not-ready) → true (rotatable)", () => {
    expect(isRotationTrigger(new TokenMintError("not-ready", "x"))).toBe(true);
  });

  // Non-Error → false
  it("non-Error value → false", () => {
    expect(isRotationTrigger("string error")).toBe(false);
    expect(isRotationTrigger(null)).toBe(false);
    expect(isRotationTrigger(undefined)).toBe(false);
    expect(isRotationTrigger(42)).toBe(false);
  });
});

// ── withPoolRetry — rotation mode ──────────────────────────────────────────

/** Fake ProxyPoolLike for rotation-mode tests. */
class FakeProxyPool implements ProxyPoolLike {
  private readonly keys: string[];
  private head: number;
  rotateCalls = 0;

  constructor(keys: string[]) {
    this.keys = keys;
    this.head = 0;
  }

  get size() { return this.keys.length; }
  getActive() { return this.keys[this.head]; }
  rotate() {
    this.rotateCalls++;
    this.head = (this.head + 1) % this.keys.length;
    return this.keys[this.head];
  }
}

describe("withPoolRetry — rotation mode", () => {
  it("empty → evict + inline re-mint → retry SAME proxy → success (Q1=B)", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const evicted: Array<string | undefined> = [];
    const refreshed: Array<string | undefined> = [];
    const deps = makeDeps({
      proxyPool,
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshed.push(proxy); },
        evictBaxiaToken: (proxy?: string) => { evicted.push(proxy); },
      },
    });
    const seen: string[] = [];
    let callCount = 0;

    const result = await withPoolRetry(deps, async (_id, _bearer, proxy?) => {
      callCount++;
      seen.push(proxy!);
      if (callCount === 1) throw new EmptyCompletionError("empty");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(seen).toEqual(["A", "A"]); // re-mint retry stays on the same proxy
    expect(evicted).toEqual(["A"]);
    expect(refreshed).toEqual(["A"]);
    expect(proxyPool.rotateCalls).toBe(0);
  });

  it("NetworkError → rotate → success", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const deps = makeDeps({ proxyPool });
    let callCount = 0;

    const result = await withPoolRetry(deps, async (_id, _bearer, proxy?) => {
      callCount++;
      if (callCount === 1) throw new NetworkError("timeout");
      return `ok-${proxy}`;
    });

    expect(result).toBe("ok-B");
    expect(proxyPool.rotateCalls).toBe(1);
  });

  it("ClientError → terminal (no rotate)", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const deps = makeDeps({ proxyPool });

    await expect(
      withPoolRetry(deps, async () => {
        throw new ClientError("bad request", { status: 400 });
      }),
    ).rejects.toThrow(ClientError);
    expect(proxyPool.rotateCalls).toBe(0);
  });

  it("budget=size (N=2): A→B exhausted → RateLimitError + cooldown", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const refreshProxies: Array<string | undefined> = [];
    const deps = makeDeps({
      proxyPool,
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshProxies.push(proxy); },
      },
    });

    await expect(
      withPoolRetry(deps, async () => {
        throw new EmptyCompletionError("empty");
      }),
    ).rejects.toThrow(RateLimitError);

    expect(proxyPool.rotateCalls).toBe(1); // rotated once (A→B), then all burned
    // Q1=B inline re-mint on A, then change #2 sentinel refresh of the active proxy (B)
    expect(refreshProxies).toEqual(["A", "B"]);
  });

  it("AuthExpired → refresh + retry SAME proxy (no rotate)", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    let refreshCalled = false;
    const deps = makeDeps({
      proxyPool,
      scheduler: {
        refreshOnDemand: async () => {
          refreshCalled = true;
          return { bearer: "new-bearer", expiresAt: 999999 };
        },
      },
    });
    let callCount = 0;
    const seen: string[] = [];

    const result = await withPoolRetry(deps, async (_id, _bearer, proxy?) => {
      callCount++;
      seen.push(proxy!);
      if (callCount === 1) throw new AuthExpiredError("expired");
      return `ok-${proxy}`;
    });

    expect(result).toBe("ok-A");
    expect(refreshCalled).toBe(true);
    expect(proxyPool.rotateCalls).toBe(0); // no rotate on AuthExpired
    expect(seen).toEqual(["A", "A"]); // same proxy
  });

  it("emptyRetryMax ignored in rotation mode (N=3, calls=3)", async () => {
    const proxyPool = new FakeProxyPool(["A", "B", "C"]);
    const deps = makeDeps({ proxyPool, config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 } });

    await expect(
      withPoolRetry(deps, async () => {
        throw new EmptyCompletionError("empty");
      }),
    ).rejects.toThrow(RateLimitError);

    // With N=3, should try all3 proxies then fail (not 1+99 retries)
    expect(proxyPool.rotateCalls).toBe(2); // rotated twice: A→B→C
  });

  it("no proxyPool → legacy (emptyRetryMax applies)", async () => {
    const deps = makeDeps({ config: { emptyCooldownMs: 10_000, emptyRetryMax: 2, emptyRetryGapMs: 0 } });
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        throw new EmptyCompletionError("empty");
      }),
    ).rejects.toThrow(RateLimitError);

    expect(callCount).toBe(3); // 1 initial +2 retries (emptyRetryMax=2)
  });
});

// ── mint-failure budget (non-stream) ────────────────────────────────────────

describe("mint-failure budget (non-stream)", () => {
  function mintDeps(overrides?: Partial<RetryDeps>) {
    const markEmptyAndSwitchCalls: Array<{ id: number; ms: number }> = [];
    const refreshCalls: string[] = [];
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 1, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshCalls.push(proxy ?? ""); },
      },
      ...overrides,
    });
    const markSpy = deps.pool.markEmptyAndSwitch.bind(deps.pool);
    deps.pool.markEmptyAndSwitch = async (id: number, ms: number) => {
      markEmptyAndSwitchCalls.push({ id, ms });
      return markSpy(id, ms);
    };
    return { pool, deps, markEmptyAndSwitchCalls, refreshCalls };
  }

  it("1st TokenMintError(egress) rotates → success", async () => {
    const { pool, deps, markEmptyAndSwitchCalls } = mintDeps();
    let callCount = 0;

    const result = await withPoolRetry(deps, async (_id, _bearer, proxy?) => {
      callCount++;
      if (callCount === 1) throw new TokenMintError("egress", "x");
      return `ok-${proxy}`;
    });

    expect(result).toBe("ok-B");
    expect(callCount).toBe(2);
    expect(pool.rotateCalls).toBe(1);
    expect(markEmptyAndSwitchCalls).toHaveLength(0);
  });

  it("1st TokenMintError(not-ready) rotates → success", async () => {
    const { pool, deps, markEmptyAndSwitchCalls } = mintDeps();
    let callCount = 0;

    const result = await withPoolRetry(deps, async (_id, _bearer, proxy?) => {
      callCount++;
      if (callCount === 1) throw new TokenMintError("not-ready", "x");
      return `ok-${proxy}`;
    });

    expect(result).toBe("ok-B");
    expect(callCount).toBe(2);
    expect(pool.rotateCalls).toBe(1);
    expect(markEmptyAndSwitchCalls).toHaveLength(0);
  });

  it("2 strikes → 429 + cooldown, NO bestEffortRefresh, exactly 2 attempts", async () => {
    const { deps, markEmptyAndSwitchCalls, refreshCalls } = mintDeps();
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        throw new TokenMintError("egress", "x");
      }),
    ).rejects.toThrow(RateLimitError);

    expect(callCount).toBe(2);
    expect(markEmptyAndSwitchCalls).toHaveLength(1);
    expect(refreshCalls).toHaveLength(0); // NO bestEffortRefresh on mint-exhaustion
  });

  it("counter is per-request", async () => {
    const { deps, markEmptyAndSwitchCalls } = mintDeps();
    let callCount = 0;
    let firstDone = false;

    // Call 1: strike then success → ok
    const result1 = await withPoolRetry(deps, async (_id, _bearer, proxy?) => {
      callCount++;
      if (!firstDone && callCount === 1) throw new TokenMintError("egress", "x");
      firstDone = true;
      return `ok-${proxy}`;
    });
    expect(result1).toMatch(/^ok-/);

    // Call 2: two strikes → 429 after exactly 2 more op calls
    let call2Count = 0;
    await expect(
      withPoolRetry(deps, async () => {
        call2Count++;
        throw new TokenMintError("egress", "x");
      }),
    ).rejects.toThrow(RateLimitError);
    expect(call2Count).toBe(2);
    expect(markEmptyAndSwitchCalls).toHaveLength(1);
  });

  it("legacy mode: TokenMintError surfaces unchanged", async () => {
    const deps = makeDeps({ config: { emptyCooldownMs: 1, emptyRetryMax: 99, emptyRetryGapMs: 0 } });
    // No proxyPool → legacy mode, no budget
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        throw new TokenMintError("egress", "mint boom");
      }),
    ).rejects.toBeInstanceOf(TokenMintError);

    expect(callCount).toBe(1);
  });

  it("EmptyCompletion → inline re-mint TokenMintError (strike 1) → op TokenMintError (strike 2) → 429", async () => {
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const markEmptyAndSwitchCalls: Array<{ id: number; ms: number }> = [];
    const refreshCalls: string[] = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 1, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => {
          refreshCalls.push(proxy ?? "");
          throw new TokenMintError("egress", "inline mint boom");
        },
        evictBaxiaToken: () => {},
      },
    });
    const markSpy = deps.pool.markEmptyAndSwitch.bind(deps.pool);
    deps.pool.markEmptyAndSwitch = async (id: number, ms: number) => {
      markEmptyAndSwitchCalls.push({ id, ms });
      return markSpy(id, ms);
    };
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        if (callCount === 1) throw new EmptyCompletionError("empty");
        throw new TokenMintError("egress", "mint boom");
      }),
    ).rejects.toThrow(RateLimitError);

    expect(callCount).toBe(2); // 2 op calls total
    expect(refreshCalls).toHaveLength(1); // one inline re-mint attempt
    expect(markEmptyAndSwitchCalls).toHaveLength(1); // exhaustion
  });

  it("non-mint inline re-mint failure → rotate, no strike", async () => {
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const markEmptyAndSwitchCalls: Array<{ id: number; ms: number }> = [];
    const refreshed: string[] = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 1, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => {
          refreshed.push(proxy ?? "");
          throw new Error("chrome spawn failed"); // non-mint failure
        },
        evictBaxiaToken: () => {},
      },
    });
    const markSpy = deps.pool.markEmptyAndSwitch.bind(deps.pool);
    deps.pool.markEmptyAndSwitch = async (id: number, ms: number) => {
      markEmptyAndSwitchCalls.push({ id, ms });
      return markSpy(id, ms);
    };
    let callCount = 0;
    const seen: string[] = [];

    const result = await withPoolRetry(deps, async (_id, _bearer, proxy?) => {
      callCount++;
      seen.push(proxy!);
      if (callCount <= 2) throw new EmptyCompletionError("empty"); // A empty → re-mint fail (non-mint) → rotate B → B empty → re-mint fail → rotate C
      return `ok-${proxy}`;
    });

    expect(result).toContain("ok-");
    expect(markEmptyAndSwitchCalls).toHaveLength(0); // no mint exhaustion
  });
});

// ── withPoolRetryStream — rotation mode ─────────────────────────────────────

/** Helper to build rotation-mode stream deps, reusing FakeProxyPool. */
function rotStreamDeps(
  proxyPool: FakeProxyPool,
  overrides?: Partial<RetryDeps>,
): RetryDeps {
  return makeDeps({ proxyPool, ...overrides });
}

describe("withPoolRetryStream — rotation mode", () => {
  it("pre-first-content error → rotate → success (buffer discarded, no dup)", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const deps = rotStreamDeps(proxyPool);
    let callCount = 0;
    const seen: string[] = [];

    async function* op(
      _id: number,
      _bearer: string,
      proxy?: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      seen.push(proxy!);
      if (callCount === 1) throw new NetworkError("timeout");
      yield contentChunk("ok");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(seen).toEqual(["A", "B"]);
    expect(proxyPool.rotateCalls).toBe(1);
    // Buffer discarded (pre-content control chunks from the error attempt are gone)
    expect(chunks).toEqual([contentChunk("ok"), finishChunk("stop")]);
  });

  it("pre-first-content empty → rotate → success", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const deps = rotStreamDeps(proxyPool);
    let callCount = 0;
    const seen: string[] = [];

    async function* op(
      _id: number,
      _bearer: string,
      proxy?: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      seen.push(proxy!);
      if (callCount === 1) {
        yield finishChunk("stop"); // empty — no payload
        return;
      }
      yield contentChunk("recovered");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    // Q1=B: first empty evicts + inline re-mints, retrying the SAME proxy
    expect(seen).toEqual(["A", "A"]);
    expect(proxyPool.rotateCalls).toBe(0);
    expect(chunks).toEqual([contentChunk("recovered"), finishChunk("stop")]);
  });

  it("post-first-content error → NO rotate (surfaces as today)", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const deps = rotStreamDeps(proxyPool);

    async function* op(
      _id: number,
      _bearer: string,
      _proxy?: string,
    ): AsyncIterable<OpenAiChatChunk> {
      yield contentChunk("partial");
      throw new NetworkError("mid-stream disconnect");
    }

    // Post-first-content error surfaces (no rotation, no duplicate)
    await expect(collectChunks(withPoolRetryStream(deps, op))).rejects.toThrow(NetworkError);
    expect(proxyPool.rotateCalls).toBe(0); // no rotation after content seen
  });

  it("budget=size N=2: both-empty → sentinel (no legacy retry)", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const refreshedProxies: Array<string | undefined> = [];
    const deps = rotStreamDeps(proxyPool, {
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshedProxies.push(proxy); },
      },
    });
    let callCount = 0;

    async function* op(
      _id: number,
      _bearer: string,
      _proxy?: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      yield finishChunk("stop"); // always empty
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    // N=2, Q1=B: A empty → re-mint retry A → empty → rotate B → empty → all burned → sentinel
    expect(callCount).toBe(3);
    expect(proxyPool.rotateCalls).toBe(1);
    expect(chunks).toHaveLength(1);
    const sentinel = chunks[0];
    if ("done" in sentinel) {
      expect(sentinel.done).toBe(true);
      expect(sentinel.extra?.rateLimited).toBe(true);
    } else {
      throw new Error("Expected sentinel");
    }
    // change #2: all-burned sentinel refreshed the active proxy's token (B)
    // after the inline re-mint on A.
    expect(refreshedProxies).toEqual(["A", "B"]);
  });
});

// ── withPoolRetry (unchanged logic) ─────────────────────────────────────────

describe("withPoolRetry", () => {
  it("returns result on first success", async () => {
    const deps = makeDeps();
    const result = await withPoolRetry(deps, async (_id, _bearer) => "ok");
    expect(result).toBe("ok");
  });

  it("retries on AuthExpiredError → refreshOnDemand → retry same account", async () => {
    let refreshCalled = false;
    const deps = makeDeps({
      scheduler: {
        refreshOnDemand: async () => {
          refreshCalled = true;
          return { bearer: "new-bearer", expiresAt: 999999 };
        },
      },
    });
    let callCount = 0;

    const result = await withPoolRetry(deps, async (id, bearer) => {
      callCount++;
      if (callCount === 1) throw new AuthExpiredError("expired");
      return `ok-${id}-${bearer}`;
    });

    expect(refreshCalled).toBe(true);
    expect(callCount).toBe(2);
    expect(result).toContain("ok-1");
  });

  it("surfaces ClientError without retry", async () => {
    const deps = makeDeps();

    await expect(
      withPoolRetry(deps, async () => {
        throw new ClientError("bad request", { status: 400 });
      }),
    ).rejects.toThrow(ClientError);
  });

});

describe("withPoolRetry empty-completion (non-stream)", () => {
  it("empty then success on inline retry (non-stream)", async () => {
    let callCount = 0;
    let markEmptyCalled = 0;

    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markEmptyAndSwitch: async () => { markEmptyCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;

    const depsWithSpy = makeDeps({ pool, config: { emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 0 } });

    const result = await withPoolRetry(depsWithSpy, async (_id, _bearer) => {
      callCount++;
      if (callCount === 1) throw new EmptyCompletionError("empty");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(callCount).toBe(2);
    expect(markEmptyCalled).toBe(0); // no exhaustion
  });

  it("exhausted empty → RateLimitError(429)", async () => {
    let markEmptyCalled = 0;

    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markEmptyAndSwitch: async () => { markEmptyCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;

    let refreshBaxiaCalled = 0;
    const deps = makeDeps({
      pool,
      config: { emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async () => { refreshBaxiaCalled++; },
      },
    });
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        throw new EmptyCompletionError("empty");
      }),
    ).rejects.toThrow(RateLimitError);

    expect(callCount).toBe(4); // 1 initial + 3 retries
    expect(markEmptyCalled).toBe(1); // exhaustion
    expect(refreshBaxiaCalled).toBe(1); // Baxia token rotated on exhaustion
  });

  it("empty-exhaustion rotates the Baxia token even if refresh rejects (best-effort)", async () => {
    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markEmptyAndSwitch: async () => ({ newActiveId: null, earliestReEnableAt: null }),
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;
    const deps = makeDeps({
      pool,
      config: { emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async () => { throw new Error("spawn failed"); },
      },
    });
    // A rejecting refresh must NOT prevent the exhaustion 429 (best-effort catch):
    await expect(
      withPoolRetry(deps, async () => { throw new EmptyCompletionError("empty"); }),
    ).rejects.toThrow(RateLimitError);
  });

  it("emptyRetryMax=0 → immediate 429 (non-stream)", async () => {
    let markEmptyCalled = 0;

    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markEmptyAndSwitch: async () => { markEmptyCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;

    const deps = makeDeps({ pool, config: { emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 } });
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        throw new EmptyCompletionError("empty");
      }),
    ).rejects.toThrow(RateLimitError);

    expect(callCount).toBe(1); // no retries
    expect(markEmptyCalled).toBe(1); // immediate exhaustion
  });
});

// ── withPoolRetryStream (OpenAiChatChunk + StreamChunk) ─────────────────────

// ── reasoning-only = empty (2026-08-14 live-debug) ──────────────────────────

describe("withPoolRetryStream — reasoning-only completions are empty", () => {
  it("reasoning-only stream end → empty path fires (retry machinery)", async () => {
    // Regression (live on mini): qwen suppressed answers to ~47 thinking
    // tokens with zero content deltas; counting reasoning as payload
    // classified those as clean successes, bypassing empty-retry entirely.
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const deps = rotStreamDeps(proxyPool, {
      config: { emptyCooldownMs: 600_000, emptyRetryMax: 3, emptyRetryGapMs: 1 },
    });
    let opCalls = 0;
    async function* op(): AsyncIterable<OpenAiChatChunk> {
      opCalls++;
      if (opCalls === 1) {
        // reasoning-only "success": role + reasoning + clean finish
        yield { choices: [{ delta: { role: "assistant" } }] } as OpenAiChatChunk;
        yield reasoningChunk("thinking about the answer...");
        yield finishChunk("stop");
      } else {
        yield contentChunk("the answer");
        yield finishChunk("stop");
      }
    }
    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    // attempt 1 (role+reasoning+finish) is fully buffered and DISCARDED on
    // retry — the client sees only attempt 2, single terminal chunk.
    expect(chunks).toEqual([contentChunk("the answer"), finishChunk("stop")]);
    expect(opCalls).toBe(2); // first attempt classified EMPTY → retried
  });

  it("reasoning + content stream end → clean success (no retry)", async () => {
    const proxyPool = new FakeProxyPool(["A"]);
    const deps = rotStreamDeps(proxyPool);
    let opCalls = 0;
    async function* op(): AsyncIterable<OpenAiChatChunk> {
      opCalls++;
      yield reasoningChunk("thinking...");
      yield contentChunk("visible answer");
      yield finishChunk("stop");
    }
    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    // reasoning is buffered pre-visible-content and flushed WITH the first
    // content token (not streamed live) — still one op call, single finish.
    expect(chunks).toEqual([
      reasoningChunk("thinking..."),
      contentChunk("visible answer"),
      finishChunk("stop"),
    ]);
    expect(opCalls).toBe(1);
  });
});

async function collectChunks(
  iter: AsyncIterable<StreamChunk>,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iter) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("withPoolRetryStream", () => {

  it("yields all OpenAiChatChunks on clean stream", async () => {
    const deps = makeDeps();

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      yield contentChunk("hello");
      yield contentChunk(" world");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toEqual([
      contentChunk("hello"),
      contentChunk(" world"),
      finishChunk("stop"),
    ]);
  });

  it("pre-first-content AuthExpiredError → refresh + retry same account", async () => {
    let refreshCalled = false;
    const deps = makeDeps({
      scheduler: {
        refreshOnDemand: async () => {
          refreshCalled = true;
          return { bearer: "new-bearer", expiresAt: 999999 };
        },
      },
    });
    let callCount = 0;

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      if (callCount === 1) throw new AuthExpiredError("expired");
      yield contentChunk("ok");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(refreshCalled).toBe(true);
    expect(callCount).toBe(2);
    expect(chunks[0]).toEqual(contentChunk("ok"));
  });

  it("flushes buffered control chunks on clean end", async () => {
    const deps = makeDeps();

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      yield { choices: [{ delta: { role: "assistant" } }] };
      yield finishChunk("stop");
      yield contentChunk("answer here");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toHaveLength(4);
    expect(chunks[2]).toEqual(contentChunk("answer here"));
  });

  it("empty then success on inline retry", async () => {
    const deps = makeDeps({ config: { emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 0 } });
    let callCount = 0;

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      if (callCount === 1) {
        yield finishChunk("stop"); // empty — no payload
        return;
      }
      yield contentChunk("recovered");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toEqual([contentChunk("recovered"), finishChunk("stop")]);
    expect(callCount).toBe(2);
  });

  it("empty → exhausted → sentinel (no throw)", async () => {
    let markEmptyCalled = 0;
    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markEmptyAndSwitch: async () => { markEmptyCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;
    let refreshBaxiaCalled = 0;
    const deps = makeDeps({
      pool,
      config: { emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async () => { refreshBaxiaCalled++; },
      },
    });
    let callCount = 0;

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      yield finishChunk("stop"); // always empty
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(callCount).toBe(4); // 1 initial + 3 retries
    expect(markEmptyCalled).toBe(1);
    expect(refreshBaxiaCalled).toBe(1); // Baxia token rotated on exhaustion
    // Sentinel, not throw
    expect(chunks).toHaveLength(1);
    const sentinel = chunks[0];
    if ("done" in sentinel) {
      expect(sentinel.done).toBe(true);
      expect(sentinel.extra?.rateLimited).toBe(true);
    } else {
      throw new Error("Expected sentinel");
    }
  });

  it("stream empty-exhaustion still yields sentinel if refresh rejects (best-effort)", async () => {
    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markEmptyAndSwitch: async () => ({ newActiveId: null, earliestReEnableAt: null }),
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;
    const deps = makeDeps({
      pool,
      config: { emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async () => { throw new Error("spawn failed"); },
      },
    });
    async function* op(): AsyncIterable<OpenAiChatChunk> {
      yield finishChunk("stop"); // empty
    }
    // A rejecting refresh must NOT prevent the exhaustion sentinel (best-effort):
    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toHaveLength(1);
    expect("done" in chunks[0] && chunks[0].done).toBe(true);
  });

  it("emptyRetryMax=0 → immediate sentinel", async () => {
    const deps = makeDeps({ config: { emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 } });
    let callCount = 0;

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(callCount).toBe(1); // no retries
    expect(chunks).toHaveLength(1);
    const sentinel = chunks[0];
    if ("done" in sentinel) {
      expect(sentinel.done).toBe(true);
      expect(sentinel.extra?.rateLimited).toBe(true);
    } else {
      throw new Error("Expected sentinel");
    }
  });

  it("invokes the throttle before dispatching to an account", async () => {
    const throttled: number[] = [];
    const deps = makeDeps({
      throttle: {
        waitFor: async (id: number) => {
          throttled.push(id);
        },
      } as unknown as RequestThrottleType,
    });

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      yield contentChunk("hi");
      yield finishChunk("stop");
    }

    await collectChunks(withPoolRetryStream(deps, op));
    expect(throttled).toEqual([1]);
  });

  it("finish_reason regression: content + no finish_reason → success (no retry)", async () => {
    let callCount = 0;
    let markSuccessCalled = 0;
    let markEmptyCalled = 0;

    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markEmptyAndSwitch: async () => { markEmptyCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
      markSuccess: () => { markSuccessCalled++; },
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;

    const depsWithSpy = makeDeps({ pool });

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      yield contentChunk("real answer");
      // NO finishChunk — no finish_reason
    }

    const chunks = await collectChunks(withPoolRetryStream(depsWithSpy, op));
    expect(chunks).toEqual([contentChunk("real answer")]);
    expect(callCount).toBe(1); // no retry
    expect(markSuccessCalled).toBe(1); // success
    expect(markEmptyCalled).toBe(0); // no empty handling
  });
});

// ── withPoolRetry against SingleAccountPool ───────────────────────────────

describe("withPoolRetry against SingleAccountPool", () => {
  it("returns result on first success", async () => {
    const pool = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    const deps: RetryDeps = {
      pool,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000 },
      log: noopLog,
    };

    const result = await withPoolRetry(deps, async (_id, _bearer) => "ok");
    expect(result).toBe("ok");
  });

  it("empty-completion on sole account → sentinel (no throw)", async () => {
    const pool = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    const deps: RetryDeps = {
      pool,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 },
      log: noopLog,
    };

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toHaveLength(1);
    const sentinel = chunks[0];
    if ("done" in sentinel) {
      expect(sentinel.done).toBe(true);
      expect(sentinel.extra?.rateLimited).toBe(true);
    } else {
      throw new Error("Expected sentinel");
    }
  });
});

// ── Branch spy tests (S-M5-78) ─────────────────────────────────────────────

describe("retry.ts branch dispatch (S-M5-78)", () => {
  /** Track which PoolLike method was called. */
  function spyPool(pool: PoolLike): { pool: PoolLike; calls: string[] } {
    const calls: string[] = [];
    const p = new Proxy(pool, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof val !== "function") return val;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (val as Function).apply(target, args);
        };
      },
    });
    return { pool: p, calls };
  }

  it("empty completion → markEmptyAndSwitch (sentinel, not throw)", async () => {
    const base = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    const { pool, calls } = spyPool(base);
    const deps: RetryDeps = {
      pool,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 },
      log: noopLog,
    };

    async function* op(_id: number, _bearer: string): AsyncIterable<OpenAiChatChunk> {
      yield finishChunk("stop"); // empty — no payload
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toHaveLength(1);
    const sentinel = chunks[0];
    if ("done" in sentinel) {
      expect(sentinel.done).toBe(true);
    } else {
      throw new Error("Expected sentinel");
    }
    expect(calls).toContain("markEmptyAndSwitch");
  });

  it("clean stream → markSuccess", async () => {
    const base = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    const { pool, calls } = spyPool(base);
    const deps: RetryDeps = {
      pool,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000 },
      log: noopLog,
    };

    async function* op(_id: number, _bearer: string): AsyncIterable<OpenAiChatChunk> {
      yield contentChunk("hello");
      yield finishChunk("stop");
    }

    await collectChunks(withPoolRetryStream(deps, op));
    expect(calls).toContain("markSuccess");
  });
});

// ── retry contracts (S-M3-2): scheduler hooks + optional pool slots ─────────

describe("RetryScheduler burn-recovery hooks (compile surface)", () => {
  it("a scheduler with refreshBaxiaToken(proxy?)/evictBaxiaToken/baxiaTokenAgeMs satisfies the contract", async () => {
    const calls: string[] = [];
    const scheduler = {
      refreshOnDemand: async () => ({ bearer: "b", expiresAt: null }),
      refreshBaxiaToken: async (proxy?: string) => { calls.push("refresh:" + (proxy ?? "active")); },
      evictBaxiaToken: (proxy?: string) => { calls.push("evict:" + (proxy ?? "active")); },
      baxiaTokenAgeMs: (proxy?: string) => (proxy ? 1234 : null),
    };
    // Type-level check executed at runtime through the optional hooks.
    await scheduler.refreshBaxiaToken?.("socks5://u:p@h:1080");
    scheduler.evictBaxiaToken?.("socks5://u:p@h:1080");
    expect(scheduler.baxiaTokenAgeMs?.("socks5://u:p@h:1080")).toBe(1234);
    expect(calls).toEqual(["refresh:socks5://u:p@h:1080", "evict:socks5://u:p@h:1080"]);
  });
});

// ── burn recovery: slots + inline re-mint + walk logging (S-M3-3) ───────────

/** Fake slot-aware pool mirroring ProxyPool sticky-first semantics, with recording. */
class FakeSlotPool implements ProxyPoolLike {
  readonly keys: string[];
  private head = 0;
  private busy = new Set<string>();
  readonly acquiredKeys: string[] = [];
  readonly releasedKeys: string[] = [];
  rotateCalls = 0;
  constructor(keys: string[]) { this.keys = keys; }
  get size(): number { return this.keys.length; }
  getActive(): string | undefined { return this.keys[this.head]; }
  rotate(): string | undefined {
    this.rotateCalls++;
    this.head = (this.head + 1) % this.keys.length;
    return this.keys[this.head];
  }
  async acquire(): Promise<string> {
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.head + i) % this.keys.length];
      if (!this.busy.has(k)) {
        this.head = (this.head + i) % this.keys.length;
        this.busy.add(k);
        this.acquiredKeys.push(k);
        return k;
      }
    }
    // all busy — wait for the next release (test pools never hit this)
    await new Promise<void>(() => {});
    return this.keys[this.head];
  }
  release(key: string): void {
    this.busy.delete(key);
    this.releasedKeys.push(key);
  }
}

describe("withPoolRetry — burn recovery (S-M3-3)", () => {
  const PA = "socks5://u:p@hA:1080";
  const PB = "socks5://u:p@hB:1080";

  function burnDeps(pool: ProxyPoolLike, opts?: { cooldownMs?: number }) {
    const evicted: Array<string | undefined> = [];
    const refreshed: Array<string | undefined> = [];
    const warns: Array<{ msg: string; ctx: any }> = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: opts?.cooldownMs ?? 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshed.push(proxy); },
        evictBaxiaToken: (proxy?: string) => { evicted.push(proxy); },
        baxiaTokenAgeMs: () => 4321,
      },
      log: {
        info: () => {},
        warn: (msg: string, ctx?: unknown) => warns.push({ msg, ctx }),
        error: () => {},
      },
    });
    return { deps, evicted, refreshed, warns };
  }

  it("slot lifecycle: acquire once per request, op sees the key, release exactly once on success", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps } = burnDeps(pool);
    const seen: string[] = [];
    const result = await withPoolRetry(deps, async (_id, _b, proxy?) => { seen.push(proxy!); return "ok"; });
    expect(result).toBe("ok");
    expect(pool.acquiredKeys.length).toBe(1);
    expect(seen).toEqual([pool.acquiredKeys[0]]);
    expect(pool.releasedKeys).toEqual([pool.acquiredKeys[0]]);
  });

  it("second empty on P → rotate away (inline re-mint bounded to one per request)", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps, evicted, refreshed } = burnDeps(pool);
    const seen: string[] = [];
    const result = await withPoolRetry(deps, async (_id, _b, proxy?) => {
      seen.push(proxy!);
      if (seen.length <= 2) throw new EmptyCompletionError("empty"); // A, re-minted A
      return "ok-" + (proxy === PA ? "A" : "B");
    });
    expect(result).toBe("ok-B");
    expect(seen).toEqual([PA, PA, PB]);
    expect(evicted).toEqual([PA, PA]);
    expect(refreshed).toEqual([PA]);
    expect(pool.rotateCalls).toBe(1);
  });

  it("all burned (N=2, always empty): RateLimitError + evictions + sentinel refresh of the ACTIVE proxy", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps, evicted, refreshed } = burnDeps(pool, { cooldownMs: 5 });
    await expect(
      withPoolRetry(deps, async () => { throw new EmptyCompletionError("empty"); }),
    ).rejects.toThrow(RateLimitError);
    expect(evicted).toEqual([PA, PA, PB]);
    // re-mint on A, then the all-burned sentinel refreshes the last active proxy (B)
    expect(refreshed).toEqual([PA, PB]);
  });

  it("empty-walk logging: per-attempt warn with redacted proxy, tried/size, tokenAgeMs; no creds", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps, warns } = burnDeps(pool, { cooldownMs: 5 });
    await expect(
      withPoolRetry(deps, async () => { throw new EmptyCompletionError("empty"); }),
    ).rejects.toThrow(RateLimitError);
    const walks = warns.filter((w) => w.msg.includes("empty completion — walking"));
    expect(walks.length).toBe(3); // A, re-minted A, B
    for (const w of walks) {
      expect(w.ctx.proxy).toMatch(/^h[AB]:1080$/); // redacted host:port
      expect(w.ctx.size).toBe(2);
      expect(w.ctx.tokenAgeMs).toBe(4321);
    }
    expect(JSON.stringify(warns)).not.toContain("u:p@");
  });

  it("slot release on throw (all-burned path frees the slot)", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps } = burnDeps(pool, { cooldownMs: 5 });
    await expect(
      withPoolRetry(deps, async () => { throw new EmptyCompletionError("empty"); }),
    ).rejects.toThrow(RateLimitError);
    expect(pool.releasedKeys.length).toBeGreaterThanOrEqual(1);
  });

  it("non-empty error path all-burned also refreshes the active proxy's token (change #2)", async () => {
    const pool = new FakeProxyPool(["A", "B"]);
    const refreshed: Array<string | undefined> = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 5, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshed.push(proxy); },
      },
    });
    await expect(
      withPoolRetry(deps, async () => { throw new NetworkError("timeout"); }),
    ).rejects.toThrow(RateLimitError);
    expect(refreshed.length).toBe(1); // after cooldown, before the 429
  });
});

// ── stream burn recovery: slots + re-mint + walk logging (S-M3-4) ───────────

describe("withPoolRetryStream — burn recovery (S-M3-4)", () => {
  const PA = "socks5://u:p@hA:1080";
  const PB = "socks5://u:p@hB:1080";

  function burnStreamDeps(pool: ProxyPoolLike) {
    const evicted: Array<string | undefined> = [];
    const refreshed: Array<string | undefined> = [];
    const order: string[] = [];
    const warns: Array<{ msg: string; ctx: any }> = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshed.push(proxy); order.push("refresh"); },
        evictBaxiaToken: (proxy?: string) => { evicted.push(proxy); order.push("evict"); },
        baxiaTokenAgeMs: () => 4321,
      },
      log: {
        info: () => {},
        warn: (msg: string, ctx?: unknown) => warns.push({ msg, ctx }),
        error: () => {},
      },
    });
    return { deps, evicted, refreshed, order, warns };
  }

  it("slot lifecycle on stream: acquire once, release once on clean end", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps } = burnStreamDeps(pool);
    async function* op(): AsyncIterable<OpenAiChatChunk> {
      yield contentChunk("hi");
      yield finishChunk("stop");
    }
    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks.length).toBe(2);
    expect(pool.acquiredKeys.length).toBe(1);
    expect(pool.releasedKeys).toEqual([pool.acquiredKeys[0]]);
  });

  it("second empty on P → rotate away (one inline re-mint per request)", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps, evicted, refreshed } = burnStreamDeps(pool);
    const seen: string[] = [];
    async function* op(_id: number, _b: string, proxy?: string): AsyncIterable<OpenAiChatChunk> {
      seen.push(proxy!);
      if (seen.length <= 2) {
        yield finishChunk("stop"); // empty — no payload
        return;
      }
      yield contentChunk("recovered");
      yield finishChunk("stop");
    }
    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(seen).toEqual([PA, PA, PB]);
    expect(evicted).toEqual([PA, PA]); // evict on empty only — PB served content
    expect(refreshed).toEqual([PA]);
    expect(pool.rotateCalls).toBe(1);
    expect(chunks[0]).toEqual(contentChunk("recovered"));
  });

  it("all-burned error path: sentinel + refresh of the active proxy (new)", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps, refreshed, order } = burnStreamDeps(pool);
    async function* op(): AsyncIterable<OpenAiChatChunk> {
      throw new NetworkError("connect fail");
    }
    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as any).done).toBe(true);
    expect((chunks[0] as any).extra?.rateLimited).toBe(true);
    expect(refreshed.length).toBe(1); // change #2 on the error path too
    expect(order[order.length - 1]).toBe("refresh"); // refresh completed before the sentinel
  });

  it("empty-walk logging: per-attempt warn with redacted proxy; no creds", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps, warns } = burnStreamDeps(pool);
    async function* op(): AsyncIterable<OpenAiChatChunk> {
      yield finishChunk("stop"); // always empty
    }
    await collectChunks(withPoolRetryStream(deps, op));
    const walks = warns.filter((w) => w.msg.includes("empty completion — walking"));
    expect(walks.length).toBe(3); // A, re-minted A, B
    expect(JSON.stringify(warns)).not.toContain("u:p@");
  });

  it("consumer break post-content: slot released (generator finally)", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const { deps } = burnStreamDeps(pool);
    let stalled: (() => void) | undefined;
    async function* op(): AsyncIterable<OpenAiChatChunk> {
      yield contentChunk("partial");
      await new Promise<void>((r) => { stalled = r; }); // never completes
      yield contentChunk("never");
    }
    const iter = withPoolRetryStream(deps, op);
    for await (const _ of iter) break; // abandon after first chunk
    expect(pool.releasedKeys).toEqual([pool.acquiredKeys[0]]);
    stalled?.();
  });
});

// ── impl-review fixes: stream stall eviction + re-mint bound ────────────────

describe("impl-review fixes", () => {
  const PA = "socks5://u:p@hA:1080";
  const PB = "socks5://u:p@hB:1080";

  it("F1: stream EmptyCompletionError THROWN pre-content (stall guard) gets eviction + inline re-mint, not plain rotation", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const evicted: Array<string | undefined> = [];
    const refreshed: Array<string | undefined> = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshed.push(proxy); },
        evictBaxiaToken: (proxy?: string) => { evicted.push(proxy); },
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const seen: string[] = [];
    async function* op(_id: number, _b: string, proxy?: string): AsyncIterable<OpenAiChatChunk> {
      seen.push(proxy!);
      if (seen.length === 1) throw new EmptyCompletionError("first payload timeout"); // stall-guard shape
      yield contentChunk("recovered");
      yield finishChunk("stop");
    }
    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(seen).toEqual([PA, PA]); // retried the SAME proxy after re-mint
    expect(evicted).toEqual([PA]);
    expect(refreshed).toEqual([PA]);
    expect(pool.rotateCalls).toBe(0);
    expect(chunks[0]).toEqual(contentChunk("recovered"));
  });

  it("F2: failed inline re-mint consumes the one-per-request allowance (no second mint on later proxies)", async () => {
    const pool = new FakeSlotPool([PA, PB]);
    const refreshed: Array<string | undefined> = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshed.push(proxy); throw new Error("chrome spawn failed"); },
        evictBaxiaToken: () => {},
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const seen: string[] = [];
    async function* op(_id: number, _b: string, proxy?: string): AsyncIterable<OpenAiChatChunk> {
      seen.push(proxy!);
      yield finishChunk("stop"); // always empty
    }
    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(seen).toEqual([PA, PB]); // remint attempt failed on A → rotate to B directly
    // Bound held: exactly ONE inline mint attempt on A (no re-attempt after rotation);
    // the second refresh below is the all-burned SENTINEL refresh of B (change #2), not a re-mint.
    expect(refreshed).toEqual([PA, PB]);
    expect(refreshed.filter((p) => p === PA).length).toBe(1);
    expect((chunks[0] as any).done).toBe(true); // all burned → sentinel
  });
});

// ── mint-failure budget (stream) ────────────────────────────────────────────

describe("mint-failure budget (stream)", () => {
  function mintStreamDeps(overrides?: Partial<RetryDeps>) {
    const markEmptyAndSwitchCalls: Array<{ id: number; ms: number }> = [];
    const refreshCalls: string[] = [];
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 1, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshCalls.push(proxy ?? ""); },
      },
      ...overrides,
    });
    const markSpy = deps.pool.markEmptyAndSwitch.bind(deps.pool);
    deps.pool.markEmptyAndSwitch = async (id: number, ms: number) => {
      markEmptyAndSwitchCalls.push({ id, ms });
      return markSpy(id, ms);
    };
    return { pool, deps, markEmptyAndSwitchCalls, refreshCalls };
  }

  it("1st TokenMintError rotates → success", async () => {
    const { pool, deps, markEmptyAndSwitchCalls } = mintStreamDeps();
    let callCount = 0;

    async function* op(
      _id: number,
      _bearer: string,
      _proxy?: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      if (callCount === 1) throw new TokenMintError("egress", "x");
      yield contentChunk("ok");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toEqual([contentChunk("ok"), finishChunk("stop")]);
    expect(callCount).toBe(2);
    expect(pool.rotateCalls).toBe(1);
    expect(markEmptyAndSwitchCalls).toHaveLength(0);
  });

  it("2 strikes → rateLimited sentinel, NO bestEffortRefresh, exactly 2 attempts", async () => {
    const { pool, deps, markEmptyAndSwitchCalls, refreshCalls } = mintStreamDeps();
    let callCount = 0;

    async function* op(
      _id: number,
      _bearer: string,
      _proxy?: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      throw new TokenMintError("egress", "x");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(callCount).toBe(2);
    // Last chunk is the rateLimited sentinel, and it's the ONLY chunk
    expect(chunks).toHaveLength(1);
    const sentinel = chunks[0];
    expect("done" in sentinel && sentinel.done).toBe(true);
    expect("done" in sentinel && (sentinel as any).extra?.rateLimited).toBe(true);
    expect(markEmptyAndSwitchCalls).toHaveLength(1);
    expect(refreshCalls).toHaveLength(0); // NO bestEffortRefresh on mint-exhaustion
    // First strike rotates (A→B), second strike exhausts
    expect(pool.rotateCalls).toBe(1);
  });

  it("EmptyCompletion → inline re-mint TokenMintError (strike 1) → op TokenMintError (strike 2) → sentinel (stream)", async () => {
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const markCalls: Array<{ id: number; ms: number }> = [];
    const refreshCalls: string[] = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 1, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => {
          refreshCalls.push(proxy ?? "");
          throw new TokenMintError("egress", "inline mint boom");
        },
        evictBaxiaToken: () => {},
      },
    });
    const markSpy = deps.pool.markEmptyAndSwitch.bind(deps.pool);
    deps.pool.markEmptyAndSwitch = async (id: number, ms: number) => {
      markCalls.push({ id, ms });
      return markSpy(id, ms);
    };
    let callCount = 0;

    async function* op(
      _id: number,
      _bearer: string,
      _proxy?: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      if (callCount === 1) throw new EmptyCompletionError("empty");
      throw new TokenMintError("egress", "mint boom");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(callCount).toBe(2);
    expect(chunks).toHaveLength(1);
    expect("done" in chunks[0] && (chunks[0] as any).done).toBe(true);
    expect("done" in chunks[0] && (chunks[0] as any).extra?.rateLimited).toBe(true);
    expect(refreshCalls).toHaveLength(1); // one inline re-mint attempt
    expect(markCalls).toHaveLength(1); // exhaustion
  });
});

// ── [F1] rotateWithSlot deadlock (audit fix) ───────────────────────────────

/** A slot-aware pool that BLOCKS on acquire when every key is busy,
 *  mirroring real ProxyPool semaphore semantics (F1 deadlock repro). */
class FakeBlockingSlotPool implements ProxyPoolLike {
  readonly keys: string[];
  private head = 0;
  private readonly busy = new Map<string, number>();
  private readonly waiters: Array<() => void> = [];
  readonly acquired: string[] = [];
  readonly released: string[] = [];
  rotateCalls = 0;

  constructor(keys: string[]) {
    this.keys = keys;
    for (const k of keys) this.busy.set(k, 0);
  }

  get size() { return this.keys.length; }
  getActive() { return this.keys[this.head]; }
  rotate() {
    this.rotateCalls++;
    this.head = (this.head + 1) % this.keys.length;
    return this.keys[this.head];
  }

  private freeKey(): string | undefined {
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[(this.head + i) % this.keys.length];
      if (this.busy.get(k) === 0) return k;
    }
    return undefined;
  }

  acquire(): Promise<string> {
    let k = this.freeKey();
    if (k !== undefined) {
      this.busy.set(k, 1);
      this.acquired.push(k);
      return Promise.resolve(k);
    }
    return new Promise<string>((resolve) => {
      this.waiters.push(() => {
        const kk = this.freeKey()!;
        this.busy.set(kk, 1);
        this.acquired.push(kk);
        resolve(kk);
      });
    });
  }

  release(key: string): void {
    this.busy.set(key, 0);
    this.released.push(key);
    const w = this.waiters.shift();
    if (w) w();
  }
}

describe("[F1] rotateWithSlot deadlock fix", () => {
  it("rotateWithSlot does not deadlock when all slots busy (pool=[A,B] conc=2, release-before-acquire)", async () => {
    const pool = new FakeBlockingSlotPool(["A", "B"]);
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 1, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
      },
    });

    let call1 = 0;
    let call2 = 0;
    const op1 = async (_id: number, _bearer: string, proxy?: string) => {
      call1++;
      if (call1 === 1) throw new TokenMintError("egress", "x");
      return `ok1-${proxy}`;
    };
    const op2 = async (_id: number, _bearer: string, proxy?: string) => {
      call2++;
      if (call2 === 1) throw new TokenMintError("egress", "x");
      return `ok2-${proxy}`;
    };

    // Both requests start concurrently — previously this deadlocked because
    // rotateWithSlot acquired the next slot before releasing the current one.
    const [r1, r2] = await Promise.all([
      withPoolRetry(deps, op1),
      withPoolRetry(deps, op2),
    ]);

    expect(r1).toContain("ok1-");
    expect(r2).toContain("ok2-");
    // Each rotated once (A→B or B→A) after the first TokenMintError
    expect(pool.rotateCalls).toBe(2);
    // 4 releases: 2 from rotateWithSlot (old key released before acquire)
    // + 2 from the finally block (final key released on exit)
    expect(pool.released.length).toBe(4);
  }, 5000);
});

// ── [F2] mixed-error walk exhaustion (audit fix) ──────────────────────────

describe("[F2] mixed-error walk exhausts with mint strikes → mint-exhaustion cooldown", () => {
  it("non-stream: walk-exhausted with 1 mint strike → cooldown + 429, no bestEffortRefresh", async () => {
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const markCalls: Array<{ id: number; ms: number }> = [];
    const refreshCalls: string[] = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshCalls.push(proxy ?? ""); },
      },
    });
    const markSpy = deps.pool.markEmptyAndSwitch.bind(deps.pool);
    deps.pool.markEmptyAndSwitch = async (id: number, ms: number) => {
      markCalls.push({ id, ms });
      return markSpy(id, ms);
    };
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        if (callCount <= 2) throw new NetworkError("timeout");
        throw new TokenMintError("egress", "x"); // 3rd proxy → mint strike, walk exhausted
      }),
    ).rejects.toThrow(RateLimitError);

    expect(callCount).toBe(3); // tried all 3 proxies
    expect(markCalls).toHaveLength(1); // markEmptyAndSwitch called on mint exhaustion
    expect(refreshCalls).toHaveLength(0); // NO bestEffortRefresh on mint exhaustion
  });

  it("stream: walk-exhausted with 1 mint strike → cooldown + sentinel, no bestEffortRefresh", async () => {
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const markCalls: Array<{ id: number; ms: number }> = [];
    const refreshCalls: string[] = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async (proxy?: string) => { refreshCalls.push(proxy ?? ""); },
      },
    });
    const markSpy = deps.pool.markEmptyAndSwitch.bind(deps.pool);
    deps.pool.markEmptyAndSwitch = async (id: number, ms: number) => {
      markCalls.push({ id, ms });
      return markSpy(id, ms);
    };
    let callCount = 0;

    async function* op(): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      if (callCount <= 2) throw new NetworkError("timeout");
      throw new TokenMintError("egress", "x");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(callCount).toBe(3);
    expect(chunks).toHaveLength(1);
    expect("done" in chunks[0] && (chunks[0] as any).done).toBe(true);
    expect("done" in chunks[0] && (chunks[0] as any).extra?.rateLimited).toBe(true);
    expect(markCalls).toHaveLength(1);
    expect(refreshCalls).toHaveLength(0);
  });
});

// ── [F4] injectable cooldown sleep (audit fix) ───────────────────────────

describe("[F4] cooldownSleep injected via RetryDeps", () => {
  it("non-stream: 2-strike mint exhaustion calls cooldownSleep once with emptyCooldownMs", async () => {
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const sleepCalls: number[] = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 42, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      cooldownSleep: async (ms: number) => { sleepCalls.push(ms); },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
      },
    });
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        throw new TokenMintError("egress", "x");
      }),
    ).rejects.toThrow(RateLimitError);

    expect(callCount).toBe(2); // 2nd TokenMintError hits MINT_STRIKE_MAX=2
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(42); // emptyCooldownMs
  });

  it("stream: 2-strike mint exhaustion calls cooldownSleep once with emptyCooldownMs", async () => {
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const sleepCalls: number[] = [];
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 42, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      cooldownSleep: async (ms: number) => { sleepCalls.push(ms); },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
      },
    });
    let callCount = 0;

    async function* op(): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      throw new TokenMintError("egress", "x");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(callCount).toBe(2); // 2nd TokenMintError hits MINT_STRIKE_MAX=2
    expect(chunks).toHaveLength(1);
    expect("done" in chunks[0] && (chunks[0] as any).done).toBe(true);
    expect("done" in chunks[0] && (chunks[0] as any).extra?.rateLimited).toBe(true);
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(42); // emptyCooldownMs
  });
});

// ── [F5] mint strikes reset on successful inline re-mint (audit fix) ─────

describe("[F5] mintStrikes resets on successful inline re-mint", () => {
  it("non-stream: EmptyCompletionError → remint succeeds → 2 TokenMintErrors → 429 (3 calls, not 2)", async () => {
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async () => {}, // succeeds — triggers reset
      },
    });
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        if (callCount === 1) throw new EmptyCompletionError("empty");
        throw new TokenMintError("egress", "x");
      }),
    ).rejects.toThrow(RateLimitError);

    // With reset: EmptyCompletion→remint(reset), TME(strikes=1), TME(strikes=2→429) = 3 calls.
    // Without reset: TME(strikes=1), TME(strikes=2→429) = 2 calls.
    expect(callCount).toBe(3);
  });

  it("stream: EmptyCompletionError → remint succeeds → 2 TokenMintErrors → 429/sentinel (3 calls, not 2)", async () => {
    const pool = new FakeProxyPool(["A", "B", "C"]);
    const deps = makeDeps({
      proxyPool: pool,
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async () => {}, // succeeds — triggers reset
      },
    });
    let callCount = 0;

    async function* op(): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      if (callCount === 1) throw new EmptyCompletionError("empty");
      throw new TokenMintError("egress", "x");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(callCount).toBe(3);
    expect(chunks).toHaveLength(1);
    expect("done" in chunks[0] && (chunks[0] as any).done).toBe(true);
    expect("done" in chunks[0] && (chunks[0] as any).extra?.rateLimited).toBe(true);
  });
});
