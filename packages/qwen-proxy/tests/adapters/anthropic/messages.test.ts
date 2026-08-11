import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { UpstreamClient, OpenAiChatChunk, OpenAiChatCompletion } from "../../../src/upstream/client";
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

/** Build a minimal OpenAiChatCompletion for non-stream stubs */
function makeCompletion(opts: {
  content?: string;
  reasoning_content?: string;
  finish_reason?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
}): OpenAiChatCompletion {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: Date.now(),
    model: "qwen3-max",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: opts.content ?? "",
          ...(opts.reasoning_content ? { reasoning_content: opts.reasoning_content } : {}),
        },
        finish_reason: opts.finish_reason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: opts.prompt_tokens ?? 10,
      completion_tokens: opts.completion_tokens ?? 5,
      total_tokens: (opts.prompt_tokens ?? 10) + (opts.completion_tokens ?? 5),
    },
  };
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
    config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 600_000, modelAliasesRaw: "", ...overrides?.config },
    log: noopLog,
    client: {
      chatCompletions: async () => makeCompletion({ content: "Hello" }),
      ...overrides?.client,
    } as Pick<UpstreamClient, "chatCompletions">,
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

  // ── Non-stream (text-only) ─────────────────────────────────────────────

  it("non-stream returns text content (no thinking when no reasoning_content)", async () => {
    let capturedBody: any;
    const client = {
      chatCompletions: async (_bearer: string, body: any) => {
        capturedBody = body;
        return makeCompletion({ content: "Hello world" });
      },
    } as Pick<UpstreamClient, "chatCompletions">;

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

    // No enable_thinking when thinking not requested
    expect(capturedBody.enable_thinking).toBeUndefined();
  });

  it("non-stream: finish_reason omitted (undefined) → stop_reason:end_turn", async () => {
    const client = {
      chatCompletions: async () => ({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: Date.now(),
        model: "qwen3-max",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            // finish_reason intentionally OMITTED (not null, not undefined — absent)
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    } as Pick<UpstreamClient, "chatCompletions">;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stop_reason).toBe("end_turn");
  });

  // ── Non-stream with thinking ───────────────────────────────────────────

  it("non-stream includes thinking block when reasoning_content present (D7 empty sig)", async () => {
    const client = {
      chatCompletions: async () => makeCompletion({
        content: "The answer",
        reasoning_content: "Let me think about this",
      }),
    } as Pick<UpstreamClient, "chatCompletions">;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ thinking: { type: "enabled" } })),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.content).toHaveLength(2);
    expect(body.content[0]).toEqual({
      type: "thinking",
      thinking: "Let me think about this",
      signature: "", // D7 opt-in: empty sig only when thinking emitted
    });
    expect(body.content[1]).toEqual({
      type: "text",
      text: "The answer",
    });
  });

  // ── thinking:{type:"enabled"} → enable_thinking:true ───────────────────

  it("thinking:{type:'enabled'} sends enable_thinking:true to upstream", async () => {
    let capturedBody: any;
    const client = {
      chatCompletions: async (_bearer: string, body: any) => {
        capturedBody = body;
        return makeCompletion({ content: "ok", reasoning_content: "thinking" });
      },
    } as Pick<UpstreamClient, "chatCompletions">;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ thinking: { type: "enabled" } })),
    });

    expect(capturedBody.enable_thinking).toBe(true);
  });

  // ── No thinking → no enable_thinking ───────────────────────────────────

  it("no thinking param → no enable_thinking in upstream body", async () => {
    let capturedBody: any;
    const client = {
      chatCompletions: async (_bearer: string, body: any) => {
        capturedBody = body;
        return makeCompletion({ content: "ok" });
      },
    } as Pick<UpstreamClient, "chatCompletions">;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect(capturedBody.enable_thinking).toBeUndefined();
  });

  // ── tools rejection ────────────────────────────────────────────────────

  it("tools present → 400 'tools (function calling) not supported'", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({
        tools: [{ name: "get_weather", input_schema: { type: "object", properties: {} } }],
      })),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("tools");
    expect(body.error.message).toContain("not supported");
  });

  it("empty tools array → allowed (not rejected)", async () => {
    const client = {
      chatCompletions: async () => makeCompletion({ content: "ok" }),
    } as Pick<UpstreamClient, "chatCompletions">;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ tools: [] })),
    });

    expect(res.status).toBe(200);
  });

  // ── <details> stripped in non-stream ────────────────────────────────────

  it("non-stream strips <details> from content", async () => {
    const client = {
      chatCompletions: async () => makeCompletion({
        content: "Here is the answer.<details>Response ID: abc\nRequest ID: xyz</details>",
      }),
    } as Pick<UpstreamClient, "chatCompletions">;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content[0].text).toBe("Here is the answer.");
    expect(body.content[0].text).not.toContain("<details>");
  });

  // ── Model resolution ───────────────────────────────────────────────────

  it("claude-sonnet-4-6 → qwen3-max", async () => {
    let capturedBody: any;
    const client = {
      chatCompletions: async (_bearer: string, body: any) => {
        capturedBody = body;
        return makeCompletion({ content: "ok" });
      },
    } as Pick<UpstreamClient, "chatCompletions">;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ model: "claude-sonnet-4-6" })),
    });

    expect(res.status).toBe(200);
    expect(capturedBody.model).toBe("qwen3-max");
    // Original model name preserved in response
    const body = await res.json();
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  // ── Pool exhausted → 429 ───────────────────────────────────────────────

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

  // ── anthropic-version validation ────────────────────────────────────────

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

  // ── Stream delegates to streamAnthropicEvents ──────────────────────────

  it("stream emits full Anthropic event sequence (delegates to streamAnthropicEvents)", async () => {
    // The stream path yields raw OpenAiChatChunks via retryStream
    const streamChunks: OpenAiChatChunk[] = [
      { choices: [{ delta: { reasoning_content: "thinking..." } }] },
      { choices: [{ delta: { content: "Hello world from stream" } }] },
      { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ];

    const client = {
      chatCompletions: async function* (_bearer: string, _body: any): AsyncIterable<OpenAiChatChunk> {
        for (const c of streamChunks) yield c;
      },
    } as unknown as Pick<UpstreamClient, "chatCompletions">;

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

    // Verify it's a valid Anthropic SSE stream
    expect(text).toContain("event: message_start");
    expect(text).toContain("content_block_start");
    expect(text).toContain("thinking_delta");
    expect(text).toContain("signature_delta");
    expect(text).toContain("text_delta");
    expect(text).toContain("message_delta");
    expect(text).toContain("message_stop");
  });

  // ── System message mapping ──────────────────────────────────────────────

  it("system as string maps to leading system message", async () => {
    let capturedBody: any;
    const client = {
      chatCompletions: async (_bearer: string, body: any) => {
        capturedBody = body;
        return makeCompletion({ content: "ok" });
      },
    } as Pick<UpstreamClient, "chatCompletions">;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(makeBody({ system: "You are helpful" })),
    });

    expect(capturedBody.messages).toEqual([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" },
    ]);
  });

  // ── Auth required ──────────────────────────────────────────────────────

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
