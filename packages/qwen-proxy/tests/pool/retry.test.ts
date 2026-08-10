import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../src/store/repo";
import { AccountPool } from "../../src/pool/state";
import {
  withPoolRetry,
  withPoolRetryStream,
  type RetryDeps,
} from "../../src/pool/retry";
import { PoolExhaustedError } from "../../src/pool/errors";
import {
  RateLimitError,
  AuthExpiredError,
  ClientError,
} from "../../src/upstream/errors";
import type { Account } from "../../src/config/types";
import type { Logger } from "../../src/server/logger";
import type { QwenChunk } from "../../src/upstream/client";

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

/** Build RetryDeps with a stub scheduler. */
function makeDeps(
  db: Database.Database,
  overrides?: Partial<RetryDeps>,
): RetryDeps {
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();
  // Give every existing account a bearer
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

describe("withPoolRetry", () => {
  it("returns result on first success", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

    const result = await withPoolRetry(deps, async (_id, _bearer) => {
      return "ok";
    });
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

    // Should have tried 3 accounts exactly once each
    expect(triedIds).toEqual([1, 2, 3]);
    db.close();
  });
});

describe("withPoolRetryStream", () => {
  async function collectChunks(
    iter: AsyncIterable<QwenChunk>,
  ): Promise<QwenChunk[]> {
    const chunks: QwenChunk[] = [];
    for await (const chunk of iter) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it("yields all chunks on clean stream", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<QwenChunk> {
      yield { phase: "answer", content: "hello" };
      yield { phase: "answer", content: " world" };
      yield { done: true };
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(chunks).toEqual([
      { phase: "answer", content: "hello" },
      { phase: "answer", content: " world" },
      { done: true },
    ]);
    db.close();
  });

  it("pre-first-token RateLimitError → switch + re-invoke, no output lost", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);
    let callCount = 0;

    async function* op(
      id: number,
      _bearer: string,
    ): AsyncIterable<QwenChunk> {
      callCount++;
      if (id === 1) {
        // Yield a control chunk then throw (before any content token)
        yield { extra: { thinking: true } };
        throw new RateLimitError("rate limited");
      }
      // Second call on new account — produce real content
      yield { phase: "answer", content: "recovered" };
      yield { done: true };
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    // Control chunks from the failed attempt should be discarded
    expect(chunks).toEqual([
      { phase: "answer", content: "recovered" },
      { done: true },
    ]);
    expect(callCount).toBe(2);
    db.close();
  });

  it("post-first-token RateLimitError → sentinel + terminate", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<QwenChunk> {
      // First content token (enters post-first-content-token phase)
      yield { phase: "answer", content: "partial" };
      // Then rate limited
      throw new RateLimitError("rate limited");
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    // Should have: the content chunk, then the D14 sentinel
    expect(chunks[0]).toEqual({ phase: "answer", content: "partial" });
    expect(chunks[1]).toEqual({ done: true, extra: { rateLimited: true } });
    // Should not have any more chunks after sentinel
    expect(chunks).toHaveLength(2);
    db.close();
  });

  it("pre-first-token AuthExpiredError → refresh + retry same account", async () => {
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
    ): AsyncIterable<QwenChunk> {
      callCount++;
      if (callCount === 1) throw new AuthExpiredError("expired");
      yield { phase: "answer", content: "ok" };
      yield { done: true };
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    expect(refreshCalled).toBe(true);
    expect(callCount).toBe(2);
    expect(chunks[0]).toEqual({ phase: "answer", content: "ok" });
    db.close();
  });

  it("cycle guard in stream: each account tried at most once", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);
    const triedIds: number[] = [];

    async function* op(
      id: number,
      _bearer: string,
    ): AsyncIterable<QwenChunk> {
      triedIds.push(id);
      throw new RateLimitError("rate limited");
    }

    // All accounts failed before content → PoolExhaustedError propagates
    await expect(
      collectChunks(withPoolRetryStream(deps, op)),
    ).rejects.toThrow(PoolExhaustedError);
    expect(triedIds).toEqual([1, 2, 3]);
    db.close();
  });

  it("flushes buffered control chunks on clean end (think before answer)", async () => {
    const db = openDb(":memory:");
    reconcileAccounts(db, ACCOUNTS);
    promote(db, 1);
    const deps = makeDeps(db);

    async function* op(
      _id: number,
      _bearer: string,
    ): AsyncIterable<QwenChunk> {
      // Control phase chunks (no content, no phase:answer)
      yield { extra: { thinking: true } };
      yield { phase: "think", content: "hmm" };
      // Then answer content
      yield { phase: "answer", content: "answer here" };
      yield { done: true };
    }

    const chunks = await collectChunks(withPoolRetryStream(deps, op));
    // All chunks should be yielded (buffer flushed + answer content)
    expect(chunks).toHaveLength(4);
    expect(chunks[2]).toEqual({ phase: "answer", content: "answer here" });
    db.close();
  });
});
