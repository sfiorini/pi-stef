import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../src/store/repo";
import { AccountPool } from "../../src/pool/state";
import { withPoolRetry } from "../../src/pool/retry";
import { generateVideo } from "../../src/media/videos";
import type { MediaVideoDeps } from "../../src/media/videos";
import type { UpstreamClient } from "../../src/upstream/client";
import type { Account } from "../../src/config/types";
import type { Logger } from "../../src/server/logger";

const ACCOUNTS: Account[] = [
  { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
];

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function setupDb(): Database.Database {
  const db = openDb(":memory:");
  reconcileAccounts(db, ACCOUNTS);
  db.prepare("UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=1").run();
  upsertToken(db, 1, "test-bearer", 999999);
  return db;
}

function makeDeps(
  db: Database.Database,
  clientOverrides?: Partial<UpstreamClient>,
): MediaVideoDeps {
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();
  return {
    pool,
    scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
    config: { rateLimitCooldownMs: 60_000 },
    log: noopLog,
    client: {
      login: async () => ({ bearer: "", expiresAt: null }),
      listModels: async () => [],
      chatCompletions: async () => ({ id: "", object: "chat.completion" as const, created: 0, model: "", choices: [], usage: null }),
      imageGeneration: async () => ({ created: 0, urls: [] }),
      imageEdit: async () => ({ created: 0, urls: [] }),
      videoGeneration: async () => ({
        created: 1700000000,
        urls: ["https://example.com/video.mp4"],
      }),
      ...clientOverrides,
    },
    retry: withPoolRetry,
  };
}

describe("generateVideo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  it("returns {created, urls} from upstream videoGeneration", async () => {
    const deps = makeDeps(db);
    const result = await generateVideo(deps, { prompt: "a dancing cat" });
    expect(result.created).toBe(1700000000);
    expect(result.urls).toEqual(["https://example.com/video.mp4"]);
  });

  it("passes prompt and size to videoGeneration", async () => {
    let calledWith: unknown;
    const deps = makeDeps(db, {
      videoGeneration: async (_bearer, body) => {
        calledWith = body;
        return { created: 1, urls: ["https://example.com/v.mp4"] };
      },
    });
    await generateVideo(deps, { prompt: "a dog", size: "16:9" });
    expect(calledWith).toEqual({ prompt: "a dog", size: "16:9" });
  });

  it("omits size when not provided", async () => {
    let calledWith: unknown;
    const deps = makeDeps(db, {
      videoGeneration: async (_bearer, body) => {
        calledWith = body;
        return { created: 1, urls: ["https://example.com/v.mp4"] };
      },
    });
    await generateVideo(deps, { prompt: "a cat" });
    expect(calledWith).toEqual({ prompt: "a cat" });
  });

  it("propagates errors from upstream (pool exhaustion)", async () => {
    const { PoolExhaustedError } = await import("../../src/pool/errors");
    const deps = makeDeps(db, {
      videoGeneration: async () => {
        throw new PoolExhaustedError(Date.now() + 60_000);
      },
    });
    await expect(generateVideo(deps, { prompt: "test" })).rejects.toThrow(
      PoolExhaustedError,
    );
  });
});
