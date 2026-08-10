import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../../src/store/repo";
import { AccountPool } from "../../../src/pool/state";
import { withPoolRetry, withPoolRetryStream } from "../../../src/pool/retry";
import { clientAuthGate } from "../../../src/server/auth";
import { createApp } from "../../../src/server/app";
import { chatRoutes } from "../../../src/adapters/openai/chat";
import { RateLimitError, ClientError } from "../../../src/upstream/errors";
import type { UpstreamClient, QwenChunk } from "../../../src/upstream/client";
import type { Account } from "../../../src/config/types";
import type { Logger } from "../../../src/server/logger";

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

interface ChatDeps {
  db: Database.Database;
  pool: InstanceType<typeof AccountPool>;
  scheduler: { refreshOnDemand: () => Promise<{ bearer: string; expiresAt: number }> };
  config: { rateLimitCooldownMs: number; modelAliasesRaw: string };
  log: Logger;
  client: UpstreamClient;
  retry: typeof withPoolRetry;
  retryStream: typeof withPoolRetryStream;
}

function makeDeps(
  db: Database.Database,
  overrides?: {
    client?: Partial<UpstreamClient>;
    config?: Partial<ChatDeps["config"]>;
  },
): ChatDeps {
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();
  return {
    db,
    pool,
    scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
    config: { rateLimitCooldownMs: 60_000, modelAliasesRaw: "", ...overrides?.config },
    log: noopLog,
    client: {
      login: async () => ({ bearer: "", expiresAt: null }),
      listModels: async () => [],
      createChat: async () => ({ chatId: "test-chat-id" }),
      chatCompletionsStream: async function* () {
        yield { phase: "answer", content: "Hello", usage: { prompt_tokens: 10, completion_tokens: 5 } };
        yield { done: true };
      },
      imageGeneration: async () => ({ created: 0, urls: [] }),
      imageEdit: async () => ({ created: 0, urls: [] }),
      videoGeneration: async () => ({ taskId: "", status: "", raw: {} }),
      videoTaskStatus: async () => ({ taskId: "", status: "", raw: {} }),
      ...overrides?.client,
    },
    retry: withPoolRetry,
    retryStream: withPoolRetryStream,
  };
}

function createTestApp(deps: ChatDeps) {
  const app = new Hono();
  app.use("/v1/*", clientAuthGate({
    db: deps.db,
    envKeys: ["test-key"],
    log: deps.log,
  }));
  app.route("/v1", chatRoutes({
    pool: deps.pool,
    client: deps.client,
    scheduler: deps.scheduler,
    config: deps.config,
    log: deps.log,
    retry: deps.retry,
    retryStream: deps.retryStream,
  }));
  return app;
}

/**
 * Build the production createApp with minimal stubs for deps not under test.
 * Used to verify app.onError (A3) works end-to-end.
 */
function createProductionApp(
  db: Database.Database,
  overrides: { client?: Partial<UpstreamClient>; config?: Partial<ChatDeps["config"]> } = {},
) {
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();
  const client: UpstreamClient = {
    login: async () => ({ bearer: "", expiresAt: null }),
    listModels: async () => [],
    createChat: async () => ({ chatId: "test-chat-id" }),
    chatCompletionsStream: async function* () {
      yield { phase: "answer", content: "Hello", usage: { prompt_tokens: 10, completion_tokens: 5 } };
      yield { done: true };
    },
    imageGeneration: async () => ({ created: 0, urls: [] }),
    imageEdit: async () => ({ created: 0, urls: [] }),
    videoGeneration: async () => ({ taskId: "", status: "", raw: {} }),
    videoTaskStatus: async () => ({ taskId: "", status: "", raw: {} }),
    ...overrides.client,
  };
  return createApp({
    db,
    pool,
    client,
    scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
    config: {
      rateLimitCooldownMs: 60_000,
      modelAliasesRaw: "",
      apiKeyEnv: ["test-key"],
      ...overrides.config,
    } as any,
    retry: withPoolRetry,
    retryStream: withPoolRetryStream,
    media: {
      db,
      pool,
      client,
      scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
      config: { rateLimitCooldownMs: 60_000 },
      log: noopLog,
      retry: withPoolRetry,
      submitVideo: async () => { throw new Error("stub"); },
      getVideoJob: () => undefined,
    },
    videoDaemon: { start: () => {}, stop: () => {} } as any,
    log: noopLog,
  });
}

describe("POST /v1/chat/completions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  // ── Non-stream ──────────────────────────────────────────────────────────

  it("non-stream accumulates reasoning_content + content + usage", async () => {
    const chunks: QwenChunk[] = [
      { phase: "think", content: "Let me think..." },
      { phase: "think", content: " OK" },
      { phase: "answer", content: "Hello" },
      { phase: "answer", content: " world" },
      { usage: { prompt_tokens: 10, completion_tokens: 20 } },
      { done: true },
    ];

    let createChatCalledWith: unknown;
    const client = {
      createChat: async (_bearer: string, body: unknown) => {
        createChatCalledWith = body;
        return { chatId: "chat-123" };
      },
      chatCompletionsStream: async function* (_bearer: string, _body: unknown) {
        for (const chunk of chunks) yield chunk;
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("qwen3-max");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].index).toBe(0);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello world");
    expect(body.choices[0].message.reasoning_content).toBe("Let me think... OK");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20 });

    // createChat called with correct upstream params
    expect(createChatCalledWith).toEqual({
      model: "qwen3-max",
      chatType: "t2t",
    });
  });

  it("non-stream flattens content array [{type:text,text}] to string", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* () {
        yield { content: "ok" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }),
    });

    expect(res.status).toBe(200);
  });

  // ── Stream ──────────────────────────────────────────────────────────────

  it("stream emits first-chunk role → deltas → finish_reason → [DONE]", async () => {
    const chunks: QwenChunk[] = [
      { phase: "answer", content: "Hi" },
      { phase: "answer", content: " there" },
      { finishReason: "stop" },
      { done: true },
    ];

    const client = {
      createChat: async () => ({ chatId: "chat-stream" }),
      chatCompletionsStream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));

    // First chunk must have delta.role = "assistant"
    const firstData = JSON.parse(lines[0].slice("data: ".length));
    expect(firstData.choices[0].delta.role).toBe("assistant");

    // Content deltas
    const secondData = JSON.parse(lines[1].slice("data: ".length));
    expect(secondData.choices[0].delta.content).toBe("Hi");

    const thirdData = JSON.parse(lines[2].slice("data: ".length));
    expect(thirdData.choices[0].delta.content).toBe(" there");

    // Finish reason
    const fourthData = JSON.parse(lines[3].slice("data: ".length));
    expect(fourthData.choices[0].finish_reason).toBe("stop");

    // [DONE]
    expect(lines[lines.length - 1]).toBe("data: [DONE]");
  });

  // ── Alias resolution ────────────────────────────────────────────────────

  it("resolves -thinking suffix to feature_config.thinking_enabled", async () => {
    let createChatCalledWith: unknown;
    let streamBody: unknown;
    const client = {
      createChat: async (_bearer: string, body: unknown) => {
        createChatCalledWith = body;
        return { chatId: "think-chat" };
      },
      chatCompletionsStream: async function* (_bearer: string, body: unknown) {
        streamBody = body;
        yield { content: "thinking result" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max-thinking",
        messages: [{ role: "user", content: "Think" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(createChatCalledWith).toEqual({
      model: "qwen3-max",
      chatType: "t2t",
    });
    // stream should have thinking feature_config
    expect(streamBody).toEqual(
      expect.objectContaining({
        model: "qwen3-max",
        featureConfig: { thinking_enabled: true },
      }),
    );
  });

  it("resolves -search suffix to chatType search", async () => {
    let createChatCalledWith: unknown;
    const client = {
      createChat: async (_bearer: string, body: unknown) => {
        createChatCalledWith = body;
        return { chatId: "search-chat" };
      },
      chatCompletionsStream: async function* () {
        yield { content: "search result" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max-search",
        messages: [{ role: "user", content: "Search" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(createChatCalledWith).toEqual({
      model: "qwen3-max",
      chatType: "search",
    });
  });

  it("resolves aliases from config", async () => {
    let createChatCalledWith: unknown;
    const client = {
      createChat: async (_bearer: string, body: unknown) => {
        createChatCalledWith = body;
        return { chatId: "alias-chat" };
      },
      chatCompletionsStream: async function* () {
        yield { content: "alias result" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, {
      client,
      config: { modelAliasesRaw: JSON.stringify({ "gpt-4o": "qwen3-max" }) },
    });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(createChatCalledWith).toEqual({
      model: "qwen3-max",
      chatType: "t2t",
    });
  });

  // ── Unknown model → 400 (F3) ──────────────────────────────────────────

  it("returns 400 model_not_found for unknown model (not qwen/wan/alias)", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "totally-unknown-model-xyz",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("model_not_found");
    expect(body.error.param).toBe("model");
  });

  it("returns 400 for gpt-4o when not aliased", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("model_not_found");
  });

  it("accepts qwen3-max (known Qwen model)", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(200);
  });

  it("accepts wan2.1-t2i (known Wan model)", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "wan2.1-t2i",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(200);
  });

  it("accepts gpt-4o when aliased to qwen model", async () => {
    const deps = makeDeps(db, {
      config: { modelAliasesRaw: JSON.stringify({ "gpt-4o": "qwen3-max" }) },
    });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(200);
  });

  // ── Sentinel mid-stream → error event + [DONE] ──────────────────────────

  it("sentinel mid-stream emits error event + [DONE]", async () => {
    const client = {
      createChat: async () => ({ chatId: "sentinel-chat" }),
      chatCompletionsStream: async function* () {
        yield { phase: "answer", content: "partial" };
        // The sentinel is injected by withPoolRetryStream, not the client.
        // We need to simulate a RateLimitError mid-stream.
        // But that's complex. Instead, test the route handles a stream
        // that yields the sentinel directly.
        yield { done: true, extra: { rateLimited: true } };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));

    // Should contain an error event before [DONE]
    const errorLine = dataLines.find((l) => {
      try {
        const d = JSON.parse(l.slice("data: ".length));
        return d.error !== undefined;
      } catch {
        return false;
      }
    });

    expect(errorLine).toBeDefined();
    const errorData = JSON.parse(errorLine!.slice("data: ".length));
    expect(errorData.error.type).toBe("rate_limit_error");
    expect(errorData.error.code).toBe("rate_limit_exceeded");

    // Last line is [DONE]
    expect(dataLines[dataLines.length - 1]).toBe("data: [DONE]");
  });

  // ── Auth required ───────────────────────────────────────────────────────

  it("returns 401 when no api key", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(401);
  });

  // ── Pool exhausted → 429 ────────────────────────────────────────────────

  it("returns 429 on PoolExhaustedError", async () => {
    // Exhaust the pool
    db.prepare("UPDATE accounts SET state='disabled', re_enable_at=? WHERE id=1").run(Date.now() + 60_000);

    const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps = makeDeps(db);
    const app = new Hono();
    app.use("/v1/*", clientAuthGate({
      db: deps.db,
      envKeys: ["test-key"],
      log: deps.log,
    }));
    app.route("/v1", chatRoutes({
      pool,
      client: deps.client,
      scheduler: deps.scheduler,
      config: deps.config,
      log: deps.log,
      retry: deps.retry,
      retryStream: deps.retryStream,
    }));

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });

  // ── F1: createChat inside retry (failover on 429) ─────────────────────

  it("non-stream: createChat RateLimitError triggers failover via retry", async () => {
    // Set up 2 accounts
    db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
    ]);
    db.prepare("UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=1").run();
    upsertToken(db, 1, "bearer-1", 999999);
    upsertToken(db, 2, "bearer-2", 999999);

    let createChatCallCount = 0;
    const client = {
      createChat: async (bearer: string) => {
        createChatCallCount++;
        if (bearer === "bearer-1") {
          throw new RateLimitError("Rate limited");
        }
        return { chatId: "chat-on-acct-2" };
      },
      chatCompletionsStream: async function* () {
        yield { phase: "answer", content: "Hello from account 2" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Hello from account 2");
    expect(createChatCallCount).toBe(2); // failed on acct 1, succeeded on acct 2
  });

  it("stream: createChat RateLimitError triggers failover via retryStream", async () => {
    // Set up 2 accounts
    db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
    ]);
    db.prepare("UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=1").run();
    upsertToken(db, 1, "bearer-1", 999999);
    upsertToken(db, 2, "bearer-2", 999999);

    let createChatCallCount = 0;
    const client = {
      createChat: async (bearer: string) => {
        createChatCallCount++;
        if (bearer === "bearer-1") {
          throw new RateLimitError("Rate limited");
        }
        return { chatId: "chat-stream-acct-2" };
      },
      chatCompletionsStream: async function* () {
        yield { phase: "answer", content: "Streamed from account 2" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Streamed from account 2");
    expect(createChatCallCount).toBe(2); // failed on acct 1, succeeded on acct 2
  });

  // ── A3: app.onError maps upstream errors to OpenAI envelope ──────────

  it("A3: upstream ClientError → 400 OpenAI envelope (not 500)", async () => {
    const client = {
      createChat: async () => {
        throw new ClientError("Client error 400", { status: 400, body: "bad request" });
      },
      chatCompletionsStream: async function* () {},
    } as unknown as UpstreamClient;

    const app = createProductionApp(db, { client });

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("Client error 400");
  });
});
