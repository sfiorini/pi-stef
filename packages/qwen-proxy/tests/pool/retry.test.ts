import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../src/store/repo";
import { AccountPool } from "../../src/pool/state";
import {
  withPoolRetry,
  withPoolRetryStream,
  isContentChunk,
  type RetryDeps,
  type StreamChunk,
} from "../../src/pool/retry";
import { PoolExhaustedError } from "../../src/pool/errors";
import {
  RateLimitError,
  AuthExpiredError,
  ClientError,
} from "../../src/upstream/errors";
import type { OpenAiChatChunk } from "../../src/upstream/client";
import type { Account } from "../../src/config/types";
import type { Logger } from "../../src/server/logger";

const ACCOUNTS: Account[] = [
  { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
  { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
  { id: 3, email: "c@test.com", password: "pw3", ord: 3 },
];

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function promote(db: Database.Database, id: number) {
  db.prepare(
    "UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=?",
  ).run(id);
}

function makeDeps(
  db: Database.Database,
  overrides?: Partial<RetryDeps>,
): RetryDeps {
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();
  const accts = db
    .prepare("SELECT id FROM accounts")
    .all() as { id: number }[];
  for (const a of accts) {
    upsertToken(db, a.id, `bearer-${a.id}`, 999999);
  }
  return {
    pool,
    scheduler: {
      refreshOnDemand: async () => ({
        bearer: "refreshed-bearer",
        expiresAt: 999999,
      }),
    },
    config: { rateLimitCooldownMs: 60_000 },
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
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

    const result = await withPoolRetry(deps, async (_id, _bearer) => "ok");
    expect(result).toBe("ok");
    db.close();
  });

  it("retries on RateLimitError → switch → success on next account", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);
    let callCount = 0;

    const result = await withPoolRetry(deps, async (id, _bearer) => {
      callCount++;
      if (id === 1) throw new RateLimitError("rate limited");
      return `account-${id}`;
    });

    expect(result).toBe("account-2");
    expect(callCount).toBe(2);
    db.close();
  });

  it("retries on AuthExpiredError → refreshOnDemand → retry same account", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    let refreshCalled = false;
    const deps = makeDeps(db, {
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
    db.close();
  });

  it("surfaces ClientError without retry", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

    await expect(
      withPoolRetry(deps, async () => {
        throw new ClientError("bad request", { status: 400 });
      }),
    ).rejects.toThrow(ClientError);
    db.close();
  });

  it("propagates PoolExhaustedError when all accounts tried", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
    ]);
    promote(db, 1);
    const deps = makeDeps(db);

    await expect(
      withPoolRetry(deps, async () => {
        throw new RateLimitError("rate limited");
      }),
    ).rejects.toThrow(PoolExhaustedError);
    db.close();
  });

  it("cycle guard: each account tried at most once per call", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);
    const triedIds: number[] = [];

    await expect(
      withPoolRetry(deps, async (id) => {
        triedIds.push(id);
        throw new RateLimitError("rate limited");
      }),
    ).rejects.toThrow(PoolExhaustedError);

    expect(triedIds).toEqual([1, 2, 3]);
    db.close();
  });
});

// ── withPoolRetryStream (OpenAiChatChunk + StreamChunk) ─────────────────────

describe("withPoolRetryStream", () => {
  async function collectChunks(
    iter: AsyncIterable<StreamChunk>,
  ): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = [];
    for await (const chunk of iter) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it("yields all OpenAiChatChunks on clean stream", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

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
    db.close();
  });

  it("pre-first-content RateLimitError → switch + re-invoke, buffer discarded", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);
    let callCount = 0;

    async function* op(
      id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      callCount++;
      if (id === 1) {
        // Control chunk (no content) then throw
        yield finishChunk("stop");
        throw new RateLimitError("rate limited");
      }
      yield contentChunk("recovered");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    // Control chunks from failed attempt discarded
    expect(chunks).toEqual([contentChunk("recovered"), finishChunk("stop")]);
    expect(callCount).toBe(2);
    db.close();
  });

  it("post-first-content RateLimitError → D14 sentinel + terminate", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      yield contentChunk("partial");
      throw new RateLimitError("rate limited");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks[0]).toEqual(contentChunk("partial"));

    // D14 sentinel: type-narrow with "done" in chunk (F5)
    const sentinel = chunks[1];
    if ("done" in sentinel) {
      expect(sentinel.done).toBe(true);
      expect(sentinel.extra?.rateLimited).toBe(true);
    } else {
      throw new Error("Expected sentinel with done=true");
    }
    expect(chunks).toHaveLength(2);
    db.close();
  });

  it("pre-first-content AuthExpiredError → refresh + retry same account", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    let refreshCalled = false;
    const deps = makeDeps(db, {
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
    db.close();
  });

  it("cycle guard: each account tried at most once", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);
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
    db.close();
  });

  it("flushes buffered control chunks on clean end", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      // Control chunks (no content)
      yield { choices: [{ delta: { role: "assistant" } }] };
      yield finishChunk("stop");
      // Then content
      yield contentChunk("answer here");
      yield finishChunk("stop");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toHaveLength(4);
    expect(chunks[2]).toEqual(contentChunk("answer here"));
    db.close();
  });

  it("reasoning_content counts as content for pre/post split", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<OpenAiChatChunk> {
      // reasoning_content should trigger content detection
      yield reasoningChunk("let me think...");
      throw new RateLimitError("rate limited");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    // reasoning_content counts as content → post-first-content path → sentinel
    expect(chunks[0]).toEqual(reasoningChunk("let me think..."));
    const sentinel = chunks[1];
    if ("done" in sentinel) {
      expect(sentinel.done).toBe(true);
      expect(sentinel.extra?.rateLimited).toBe(true);
    } else {
      throw new Error("Expected sentinel");
    }
    db.close();
  });
});
