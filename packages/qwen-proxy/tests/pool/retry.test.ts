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

  it("returns true for chunk with delta.reasoning_content", () => {
    expect(isContentChunk(reasoningChunk("thinking..."))).toBe(true);
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
  it("empty → rotate → success (op sees proxy A then B)", async () => {
    const proxyPool = new FakeProxyPool(["A", "B"]);
    const deps = makeDeps({ proxyPool });
    const seen: string[] = [];
    let callCount = 0;

    const result = await withPoolRetry(deps, async (_id, _bearer, proxy?) => {
      callCount++;
      seen.push(proxy!);
      if (callCount === 1) throw new EmptyCompletionError("empty");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(seen).toEqual(["A", "B"]);
    expect(proxyPool.rotateCalls).toBe(1);
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
    let refreshBaxiaCalled = 0;
    const deps = makeDeps({
      proxyPool,
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
      scheduler: {
        refreshOnDemand: async () => ({ bearer: "", expiresAt: null }),
        refreshBaxiaToken: async () => { refreshBaxiaCalled++; },
      },
    });

    await expect(
      withPoolRetry(deps, async () => {
        throw new EmptyCompletionError("empty");
      }),
    ).rejects.toThrow(RateLimitError);

    expect(proxyPool.rotateCalls).toBe(1); // rotated once (A→B), then all burned
    expect(refreshBaxiaCalled).toBe(0); // NO refreshBaxiaToken in rotation mode
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
    expect(seen).toEqual(["A", "B"]);
    expect(proxyPool.rotateCalls).toBe(1);
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
    const deps = rotStreamDeps(proxyPool, {
      config: { emptyCooldownMs: 10, emptyRetryMax: 99, emptyRetryGapMs: 0 },
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
    // N=2: try A (empty), rotate to B (empty), all burned → sentinel
    expect(callCount).toBe(2);
    expect(proxyPool.rotateCalls).toBe(1);
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
