import { describe, it, expect } from "vitest";
import {
  withPoolRetry,
  withPoolRetryStream,
  isContentChunk,
  type RetryDeps,
  type StreamChunk,
} from "../../src/pool/retry";
import { PoolExhaustedError } from "../../src/pool/errors";
import type { RequestThrottle as RequestThrottleType } from "../../src/pool/throttle";
import {
  RateLimitError,
  AuthExpiredError,
  ClientError,
  EmptyCompletionError,
} from "../../src/upstream/errors";
import type { OpenAiChatChunk } from "../../src/upstream/client";
import type { Logger } from "../../src/server/logger";
import { SingleAccountPool } from "../../src/pool/single";

/** Fake multi-account PoolLike for retry.ts failover-cycle tests (guest mode has
 *  only SingleAccountPool; this exercises the generic markRateLimitedAndSwitch
 *  branches of retry.ts without a DB). S-M5-78 extends PoolLike + this fake. */
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
  async markRateLimitedAndSwitch(failedId: number, _cooldownMs: number) {
    this.disabled.add(failedId);
    const next = this.ids.find((i) => !this.disabled.has(i));
    if (next !== undefined) { this.activeIdx = this.ids.indexOf(next); }
    return { newActiveId: next !== undefined ? next : null, earliestReEnableAt: null };
  }
  async markEmptyAndSwitch(failedId: number, cooldownMs: number) {
    return this.markRateLimitedAndSwitch(failedId, cooldownMs);
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
    config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 600_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000 },
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

// ── withPoolRetry (unchanged logic) ─────────────────────────────────────────

describe("withPoolRetry", () => {
  it("returns result on first success", async () => {
    const deps = makeDeps();
    const result = await withPoolRetry(deps, async (_id, _bearer) => "ok");
    expect(result).toBe("ok");
  });

  it("retries on RateLimitError → switch → success on next account", async () => {
    const deps = makeDeps();
    let callCount = 0;

    const result = await withPoolRetry(deps, async (id, _bearer) => {
      callCount++;
      if (id === 1) throw new RateLimitError("rate limited");
      return `account-${id}`;
    });

    expect(result).toBe("account-2");
    expect(callCount).toBe(2);
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

  it("propagates PoolExhaustedError when all accounts tried", async () => {
    const deps = makeDeps({
      pool: new FakeMultiPool([1]),
    });

    await expect(
      withPoolRetry(deps, async () => {
        throw new RateLimitError("rate limited");
      }),
    ).rejects.toThrow(PoolExhaustedError);
  });

  it("cycle guard: each account tried at most once per call", async () => {
    const deps = makeDeps();
    const triedIds: number[] = [];

    await expect(
      withPoolRetry(deps, async (id) => {
        triedIds.push(id);
        throw new RateLimitError("rate limited");
      }),
    ).rejects.toThrow(PoolExhaustedError);

    expect(triedIds).toEqual([1, 2, 3]);
  });
});

describe("withPoolRetry empty-completion (non-stream)", () => {
  it("empty then success on inline retry (non-stream)", async () => {
    let callCount = 0;
    let markEmptyCalled = 0;

    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markRateLimitedAndSwitch: async () => ({ newActiveId: null, earliestReEnableAt: null }),
      markEmptyAndSwitch: async () => { markEmptyCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;

    const depsWithSpy = makeDeps({ pool, config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 0 } });

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
      markRateLimitedAndSwitch: async () => ({ newActiveId: null, earliestReEnableAt: null }),
      markEmptyAndSwitch: async () => { markEmptyCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;

    const deps = makeDeps({ pool, config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 0 } });
    let callCount = 0;

    await expect(
      withPoolRetry(deps, async () => {
        callCount++;
        throw new EmptyCompletionError("empty");
      }),
    ).rejects.toThrow(RateLimitError);

    expect(callCount).toBe(4); // 1 initial + 3 retries
    expect(markEmptyCalled).toBe(1); // exhaustion
  });

  it("emptyRetryMax=0 → immediate 429 (non-stream)", async () => {
    let markEmptyCalled = 0;

    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markRateLimitedAndSwitch: async () => ({ newActiveId: null, earliestReEnableAt: null }),
      markEmptyAndSwitch: async () => { markEmptyCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;

    const deps = makeDeps({ pool, config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 } });
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

  it("pre-first-content RateLimitError → switch + re-invoke, buffer discarded", async () => {
    const deps = makeDeps();
    let callCount = 0;

    async function* op(
      id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      if (id === 1) {
        yield finishChunk("stop");
        throw new RateLimitError("rate limited");
      }
      yield contentChunk("recovered");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toEqual([contentChunk("recovered"), finishChunk("stop")]);
    expect(callCount).toBe(2);
  });

  it("post-first-content RateLimitError → D14 sentinel + terminate", async () => {
    const deps = makeDeps();

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      yield contentChunk("partial");
      throw new RateLimitError("rate limited");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks[0]).toEqual(contentChunk("partial"));

    const sentinel = chunks[1];
    if ("done" in sentinel) {
      expect(sentinel.done).toBe(true);
      expect(sentinel.extra?.rateLimited).toBe(true);
    } else {
      throw new Error("Expected sentinel with done=true");
    }
    expect(chunks).toHaveLength(2);
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

  it("cycle guard: each account tried at most once", async () => {
    const deps = makeDeps();
    const triedIds: number[] = [];

    async function* op(
      id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      triedIds.push(id);
      throw new RateLimitError("rate limited");
    }

    await expect(
      collectChunks(withPoolRetryStream(deps, op)),
    ).rejects.toThrow(PoolExhaustedError);
    expect(triedIds).toEqual([1, 2, 3]);
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
    const deps = makeDeps({ config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 0 } });
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
      markRateLimitedAndSwitch: async () => ({ newActiveId: null, earliestReEnableAt: null }),
      markEmptyAndSwitch: async () => { markEmptyCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
      markSuccess: () => {},
      earliestReEnableAt: () => null,
    } as unknown as PoolLike;
    const deps = makeDeps({ pool, config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 0 } });
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

  it("emptyRetryMax=0 → immediate sentinel", async () => {
    const deps = makeDeps({ config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 } });
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

  it("reasoning_content counts as content for pre/post split", async () => {
    const deps = makeDeps();

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      yield reasoningChunk("let me think...");
      throw new RateLimitError("rate limited");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks[0]).toEqual(reasoningChunk("let me think..."));
    const sentinel = chunks[1];
    if ("done" in sentinel) {
      expect(sentinel.done).toBe(true);
      expect(sentinel.extra?.rateLimited).toBe(true);
    } else {
      throw new Error("Expected sentinel");
    }
  });

  it("finish_reason regression: content + no finish_reason → success (no retry)", async () => {
    let callCount = 0;
    let markSuccessCalled = 0;
    let markEmptyCalled = 0;
    let markRateLimitCalled = 0;

    const pool: PoolLike = {
      id: 0, bearer: "guest", expiresAt: null,
      getActiveAccount: () => ({ id: 0, bearer: "guest", expiresAt: null }),
      markRateLimitedAndSwitch: async () => { markRateLimitCalled++; return { newActiveId: null, earliestReEnableAt: null }; },
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
    expect(markRateLimitCalled).toBe(0); // no rate limit
  });
});

// ── withPoolRetry against SingleAccountPool ───────────────────────────────

describe("withPoolRetry against SingleAccountPool", () => {
  it("returns result on first success", async () => {
    const pool = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    const deps: RetryDeps = {
      pool,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000 },
      log: noopLog,
    };

    const result = await withPoolRetry(deps, async (_id, _bearer) => "ok");
    expect(result).toBe("ok");
  });

  it("RateLimitError → PoolExhaustedError (no failover target)", async () => {
    const pool = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    const deps: RetryDeps = {
      pool,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000 },
      log: noopLog,
    };

    await expect(
      withPoolRetry(deps, async () => {
        throw new RateLimitError("rate limited");
      }),
    ).rejects.toThrow(PoolExhaustedError);
  });

  it("empty-completion on sole account → sentinel (no throw)", async () => {
    const pool = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    const deps: RetryDeps = {
      pool,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 },
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
      config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 0, emptyRetryGapMs: 0 },
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
    expect(calls).not.toContain("markRateLimitedAndSwitch");
  });

  it("real RateLimitError → markRateLimitedAndSwitch (NOT empty)", async () => {
    const { pool, calls } = spyPool(new FakeMultiPool([1, 2]));
    const deps: RetryDeps = {
      pool,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000 },
      log: noopLog,
    };

    async function* op(id: number, _bearer: string): AsyncIterable<OpenAiChatChunk> {
      if (id === 1) throw new RateLimitError("rate limited");
      yield contentChunk("ok");
      yield finishChunk("stop");
    }

    await collectChunks(withPoolRetryStream(deps, op));
    expect(calls).toContain("markRateLimitedAndSwitch");
    expect(calls).not.toContain("markEmptyAndSwitch");
  });

  it("clean stream → markSuccess", async () => {
    const base = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    const { pool, calls } = spyPool(base);
    const deps: RetryDeps = {
      pool,
      scheduler: { refreshOnDemand: async () => ({ bearer: "", expiresAt: null }) },
      config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 10_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000 },
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
