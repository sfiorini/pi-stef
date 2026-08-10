import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { QwenChunk, UpstreamClient } from "../../../src/upstream/client";
import type { Logger } from "../../../src/server/logger";
import type { Account } from "../../../src/config/types";
import { openDb } from "../../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../../src/store/repo";
import { AccountPool } from "../../../src/pool/state";
import { withPoolRetry, withPoolRetryStream } from "../../../src/pool/retry";
import { clientAuthGate } from "../../../src/server/auth";
import { anthropicRoutes, type AnthropicRouteDeps } from "../../../src/adapters/anthropic";

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
  overrides?: {
    client?: Partial<UpstreamClient>;
    config?: Partial<AnthropicRouteDeps["config"]>;
  },
): AnthropicRouteDeps {
  const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
  pool.hydrate();
  return {
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

function createTestApp(deps: AnthropicRouteDeps) {
  const app = new Hono();
  app.use(
    "/v1/*",
    clientAuthGate({ db: deps.pool.getActiveAccount().id ? deps.config : deps.config, envKeys: ["test-key"], log: deps.log } as any),
  );
  app.route("/v1", anthropicRoutes(deps));
  return app;
}

function authHeaders(extra?: Record<string, string>) {
  return {
    Authorization: "Bearer test-key",
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    ...extra,
  };
}

function makeBody(overrides?: Record<string, unknown>) {
  return {
    model: "qwen3-max",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hi" }],
    ...overrides,
  };
}

describe("POST /v1/messages", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  // ── Non-stream ──────────────────────────────────────────────────────────

  it("non-stream returns content[] always as array (text-only)", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { phase: "answer", content: "Hello world" };
        yield { finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5 } };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.model).toBe("qwen3-max");
    expect(body.id).toMatch(/^msg_/);
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.stop_sequence).toBeNull();
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("non-stream includes thinking block iff Qwen emitted phase:think", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { phase: "think", content: "Let me think" };
        yield { phase: "answer", content: "The answer" };
        yield { finishReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 8 } };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ model: "qwen3-max-thinking" })),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.content).toHaveLength(2);
    expect(body.content[0]).toEqual({
      type: "thinking",
      thinking: "Let me think",
      signature: "",
    });
    expect(body.content[1]).toEqual({
      type: "text",
      text: "The answer",
    });
  });

  it("non-stream content without think → only text block, no thinking", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { phase: "answer", content: "Direct" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toEqual([{ type: "text", text: "Direct" }]);
  });

  it("stop_reason: stop → end_turn", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { content: "ok" };
        yield { finishReason: "stop", usage: { prompt_tokens: 1, completion_tokens: 1 } };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect((await res.json()).stop_reason).toBe("end_turn");
  });

  it("stop_reason: length → max_tokens", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { content: "truncated" };
        yield { finishReason: "length", usage: { prompt_tokens: 1, completion_tokens: 1 } };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect((await res.json()).stop_reason).toBe("max_tokens");
  });

  it("stop_reason: stop_sequence → stop_sequence", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { content: "ok" };
        yield { finishReason: "stop_sequence", usage: { prompt_tokens: 1, completion_tokens: 1 } };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect((await res.json()).stop_reason).toBe("stop_sequence");
  });

  it("usage maps prompt_tokens→input_tokens, completion_tokens→output_tokens", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { content: "ok" };
        yield { usage: { prompt_tokens: 42, completion_tokens: 7 } };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    const body = await res.json();
    expect(body.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
  });

  // ── Model resolution ────────────────────────────────────────────────────

  it("Qwen model ID passes through", async () => {
    let chatModel: unknown;
    const client = {
      createChat: async (_bearer: string, body: any) => {
        chatModel = body.model;
        return { chatId: "c" };
      },
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { content: "ok" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ model: "qwen3-max" })),
    });

    expect(chatModel).toBe("qwen3-max");
  });

  it("claude-* → qwen3-max (flagship fallback)", async () => {
    let chatModel: unknown;
    const client = {
      createChat: async (_bearer: string, body: any) => {
        chatModel = body.model;
        return { chatId: "c" };
      },
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { content: "ok" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ model: "claude-sonnet-4-6" })),
    });

    expect(res.status).toBe(200);
    expect(chatModel).toBe("qwen3-max");
  });

  it("mapped alias resolves", async () => {
    let chatModel: unknown;
    const client = {
      createChat: async (_bearer: string, body: any) => {
        chatModel = body.model;
        return { chatId: "c" };
      },
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { content: "ok" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, {
      client,
      config: { modelAliasesRaw: JSON.stringify({ "claude-3-haiku": "qwen-turbo" }) },
    });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ model: "claude-3-haiku" })),
    });

    expect(res.status).toBe(200);
    expect(chatModel).toBe("qwen-turbo");
  });

  it("unknown model (neither Qwen ID nor alias nor claude-*) → 400", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ model: "gpt-5-turbo" })),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  // ── anthropic-version validation ─────────────────────────────────────────

  it("missing anthropic-version → 400", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("anthropic-version");
  });

  it("unknown anthropic-version → 400", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders({ "anthropic-version": "2024-01-01" }),
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  // ── System message mapping ──────────────────────────────────────────────

  it("system as string maps to leading system message", async () => {
    let messages: unknown;
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (_bearer: string, body: any): AsyncIterable<QwenChunk> {
        messages = body.messages;
        yield { content: "ok" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ system: "You are helpful" })),
    });

    expect(messages).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ]);
  });

  it("system as array of text blocks joins to string", async () => {
    let messages: unknown;
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (_bearer: string, body: any): AsyncIterable<QwenChunk> {
        messages = body.messages;
        yield { content: "ok" };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({
        system: [
          { type: "text", text: "Part 1. " },
          { type: "text", text: "Part 2." },
        ],
      })),
    });

    expect(messages).toEqual([
      { role: "system", content: "Part 1. Part 2." },
      { role: "user", content: "Hi" },
    ]);
  });

  // ── Stream ──────────────────────────────────────────────────────────────

  it("stream emits full Anthropic event sequence with think→answer", async () => {
    const chunks: QwenChunk[] = [
      { phase: "think", content: "thinking..." },
      { phase: "answer", content: "Hello" },
      { finishReason: "stop", usage: { prompt_tokens: 5, completion_tokens: 3 } },
      { done: true },
    ];

    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        for (const c of chunks) yield c;
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ stream: true })),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const blocks = text.split("\n\n").filter(Boolean);
    const events = blocks.map((b) => {
      const lines = b.split("\n");
      let event = "";
      let data = "";
      for (const l of lines) {
        if (l.startsWith("event: ")) event = l.slice("event: ".length);
        if (l.startsWith("data: ")) data = l.slice("data: ".length);
      }
      return { event, data: JSON.parse(data) };
    });

    // message_start
    expect(events[0].event).toBe("message_start");
    expect(events[0].data.message.id).toMatch(/^msg_/);

    // think content_block_start index 0
    expect(events[1]).toEqual({
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    });

    // thinking_delta
    expect(events[2]).toEqual({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thinking..." } },
    });

    // signature_delta (D7 empty)
    expect(events[3]).toEqual({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "" } },
    });

    // stop thinking block
    expect(events[4]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    });

    // start text block index 1
    expect(events[5]).toEqual({
      event: "content_block_start",
      data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    });

    // text_delta
    expect(events[6]).toEqual({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
    });

    // stop text block
    expect(events[7]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 1 },
    });

    // message_delta
    expect(events[8].event).toBe("message_delta");
    expect(events[8].data.delta.stop_reason).toBe("end_turn");

    // message_stop
    expect(events[9].event).toBe("message_stop");
  });

  it("stream no-think → text block at index 0", async () => {
    const chunks: QwenChunk[] = [
      { phase: "answer", content: "Direct" },
      { finishReason: "stop", usage: { prompt_tokens: 5, completion_tokens: 2 } },
      { done: true },
    ];

    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        for (const c of chunks) yield c;
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ stream: true })),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const blocks = text.split("\n\n").filter(Boolean);
    const events = blocks.map((b) => {
      const lines = b.split("\n");
      let event = "";
      let data = "";
      for (const l of lines) {
        if (l.startsWith("event: ")) event = l.slice("event: ".length);
        if (l.startsWith("data: ")) data = l.slice("data: ".length);
      }
      return { event, data: JSON.parse(data) };
    });

    // message_start → content_block_start index 0 text → delta → stop → message_delta → message_stop
    expect(events[0].event).toBe("message_start");
    expect(events[1]).toEqual({
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    });
    expect(events[2]).toEqual({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Direct" } },
    });
    expect(events[3]).toEqual({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: 0 },
    });
  });

  it("stream sentinel → error event", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { phase: "answer", content: "partial" };
        yield { done: true, extra: { rateLimited: true } };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ stream: true })),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const blocks = text.split("\n\n").filter(Boolean);
    const events = blocks.map((b) => {
      const lines = b.split("\n");
      let event = "";
      let data = "";
      for (const l of lines) {
        if (l.startsWith("event: ")) event = l.slice("event: ".length);
        if (l.startsWith("data: ")) data = l.slice("data: ".length);
      }
      return { event, data: JSON.parse(data) };
    });

    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.data).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "rate limit exceeded" },
    });
  });

  // ── content[] always array in non-stream ─────────────────────────────────

  it("content is always an array even when empty", async () => {
    const client = {
      createChat: async () => ({ chatId: "c" }),
      chatCompletionsStream: async function* (): AsyncIterable<QwenChunk> {
        yield { usage: { prompt_tokens: 1, completion_tokens: 0 } };
        yield { done: true };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.content)).toBe(true);
    // Even if no real content, should still be an array (with text block)
    expect(body.content).toEqual([{ type: "text", text: "" }]);
  });

  // ── Pool exhausted → 429 ────────────────────────────────────────────────

  it("pool exhausted → 429 Anthropic error", async () => {
    db.prepare("UPDATE accounts SET state='disabled', re_enable_at=? WHERE id=1").run(Date.now() + 60_000);

    const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps = makeDeps(db);
    const app = new Hono();
    app.use("/v1/*", clientAuthGate({ db, envKeys: ["test-key"], log: noopLog }));
    app.route(
      "/v1",
      anthropicRoutes({ ...deps, pool }),
    );

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("rate_limit_error");
  });

  // ── Auth required ───────────────────────────────────────────────────────

  it("returns 401 Anthropic envelope when no api key", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });
});
