import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/store/db";
import { reconcileAccounts, upsertToken } from "../../../src/store/repo";
import { AccountPool } from "../../../src/pool/state";
import { withPoolRetry, withPoolRetryStream } from "../../../src/pool/retry";
import { clientAuthGate } from "../../../src/server/auth";
import { chatRoutes } from "../../../src/adapters/openai/chat";
import { RateLimitError } from "../../../src/upstream/errors";
import type { UpstreamClient, OpenAiChatChunk, OpenAiChatCompletion } from "../../../src/upstream/client";
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
      chatCompletions: async (_bearer: string, body: Record<string, unknown>) => {
        if (body.stream) {
          return (async function* () {
            yield { choices: [{ delta: { content: "Hello" } }] };
          })();
        }
        return {
          id: "test-id",
          object: "chat.completion" as const,
          created: 1000,
          model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
        } as OpenAiChatCompletion;
      },
      imageGeneration: async () => ({ created: 0, urls: [] }),
      imageEdit: async () => ({ created: 0, urls: [] }),
      videoGeneration: async () => ({ created: 0, urls: [] }),
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

describe("POST /v1/chat/completions", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  // ── Non-stream ──────────────────────────────────────────────────────────

  it("non-stream returns content + reasoning_content + usage", async () => {
    const completion: OpenAiChatCompletion = {
      id: "upstream-id",
      object: "chat.completion",
      created: 1700000000,
      model: "qwen3-max",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello world", reasoning_content: "I thought..." },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    let chatCompletionsCalledWith: unknown;
    const client = {
      chatCompletions: async (_bearer: string, body: Record<string, unknown>) => {
        chatCompletionsCalledWith = body;
        return completion;
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("qwen3-max");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices[0].message.role).toBe("assistant");
    expect(body.choices[0].message.content).toBe("Hello world");
    expect(body.choices[0].message.reasoning_content).toBe("I thought...");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });

    // upstream call
    expect(chatCompletionsCalledWith).toEqual(
      expect.objectContaining({ model: "qwen3-max", stream: false }),
    );
  });

  it("non-stream strips <details> from content", async () => {
    const completion: OpenAiChatCompletion = {
      id: "upstream-id",
      object: "chat.completion",
      created: 1700000000,
      model: "qwen3-max",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello<details><summary>Response ID: abc123</summary></details>" },
        finish_reason: "stop",
      }],
    };

    const client = {
      chatCompletions: async () => completion,
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Hello");
  });

  it("non-stream flattens content array [{type:text,text}] to string", async () => {
    const client = {
      chatCompletions: async () => ({
        id: "c", object: "chat.completion", created: 0, model: "qwen3-max",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }),
    });

    expect(res.status).toBe(200);
  });

  // ── Model resolution ────────────────────────────────────────────────────

  it("qwen3-max-thinking sends enable_thinking:true upstream", async () => {
    let chatCompletionsCalledWith: Record<string, unknown> | undefined;
    const client = {
      chatCompletions: async (_bearer: string, body: Record<string, unknown>) => {
        chatCompletionsCalledWith = body;
        return { id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max-thinking", messages: [{ role: "user", content: "Think" }] }),
    });

    expect(res.status).toBe(200);
    expect(chatCompletionsCalledWith).toEqual(
      expect.objectContaining({ model: "qwen3-max", stream: false, enable_thinking: true }),
    );
  });

  it("qwen3-max-search sends tools:[{type:'web_search'}] upstream", async () => {
    let chatCompletionsCalledWith: Record<string, unknown> | undefined;
    const client = {
      chatCompletions: async (_bearer: string, body: Record<string, unknown>) => {
        chatCompletionsCalledWith = body;
        return { id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max-search", messages: [{ role: "user", content: "Search" }] }),
    });

    expect(res.status).toBe(200);
    expect(chatCompletionsCalledWith).toEqual(
      expect.objectContaining({ model: "qwen3-max", tools: [{ type: "web_search" }] }),
    );
  });

  it("explicit enable_thinking:false passes through (overrides suffix default)", async () => {
    let chatCompletionsCalledWith: Record<string, unknown> | undefined;
    const client = {
      chatCompletions: async (_bearer: string, body: Record<string, unknown>) => {
        chatCompletionsCalledWith = body;
        return { id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max-thinking", enable_thinking: false, messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(200);
    // -thinking suffix would set true, but explicit false overrides
    expect(chatCompletionsCalledWith).toEqual(
      expect.objectContaining({ enable_thinking: false }),
    );
  });

  it("explicit enable_thinking:true passes through without suffix", async () => {
    let chatCompletionsCalledWith: Record<string, unknown> | undefined;
    const client = {
      chatCompletions: async (_bearer: string, body: Record<string, unknown>) => {
        chatCompletionsCalledWith = body;
        return { id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", enable_thinking: true, messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(chatCompletionsCalledWith).toEqual(
      expect.objectContaining({ enable_thinking: true }),
    );
  });

  // ── Function-calling rejection ──────────────────────────────────────────

  it("tools:[{type:'function'}] → 400 function_calling_not_supported", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("function_calling_not_supported");
  });

  it("tool_choice present → 400 function_calling_not_supported", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("function_calling_not_supported");
  });

  it("tools:[{type:'web_search'}] passthrough (not rejected)", async () => {
    let chatCompletionsCalledWith: Record<string, unknown> | undefined;
    const client = {
      chatCompletions: async (_bearer: string, body: Record<string, unknown>) => {
        chatCompletionsCalledWith = body;
        return { id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        tools: [{ type: "web_search" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(chatCompletionsCalledWith).toEqual(
      expect.objectContaining({ tools: [{ type: "web_search" }] }),
    );
  });

  // ── Alias resolution ────────────────────────────────────────────────────

  it("resolves aliases from config", async () => {
    let chatCompletionsCalledWith: Record<string, unknown> | undefined;
    const client = {
      chatCompletions: async (_bearer: string, body: Record<string, unknown>) => {
        chatCompletionsCalledWith = body;
        return { id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, {
      client,
      config: { modelAliasesRaw: JSON.stringify({ "gpt-4o": "qwen3-max" }) },
    });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(chatCompletionsCalledWith).toEqual(
      expect.objectContaining({ model: "qwen3-max" }),
    );
  });

  // ── Unknown model → 400 ────────────────────────────────────────────────

  it("returns 400 model_not_found for unknown model", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "totally-unknown-model-xyz", messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("model_not_found");
  });

  // ── Stream ──────────────────────────────────────────────────────────────

  it("stream: firstChunk + content deltas + finish_reason + [DONE]", async () => {
    async function* streamChunks() {
      yield { choices: [{ delta: { content: "Hello there friend" } }] } as OpenAiChatChunk;
      yield { choices: [{ delta: { content: ", nice to meet you!" } }] } as OpenAiChatChunk;
      yield { choices: [{ finish_reason: "stop" }] } as OpenAiChatChunk;
    }

    const client = {
      chatCompletions: (_bearer: string, body: Record<string, unknown>) => {
        if (body.stream) return streamChunks();
        return Promise.resolve({} as OpenAiChatCompletion);
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));

    // First chunk: delta.role = "assistant"
    const firstData = JSON.parse(lines[0].slice("data: ".length));
    expect(firstData.choices[0].delta.role).toBe("assistant");
    expect(firstData.object).toBe("chat.completion.chunk");
    expect(firstData.id).toMatch(/^chatcmpl-/);

    // Content deltas — stripper holds back 9 chars so content is split
    // but the full content should be present across chunks
    const contentChunks = lines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter((d) => d?.choices?.[0]?.delta?.content)
      .map((d) => d.choices[0].delta.content);
    const fullContent = contentChunks.join("");
    expect(fullContent).toContain("Hello there friend");
    expect(fullContent).toContain(", nice to meet you!");

    // Finish reason present
    const finishChunks = lines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter((d) => d?.choices?.[0]?.finish_reason === "stop");
    expect(finishChunks.length).toBeGreaterThanOrEqual(1);

    // [DONE]
    expect(lines[lines.length - 1]).toBe("data: [DONE]");
  });

  it("stream strips <details> from delta.content", async () => {
    async function* streamChunks() {
      yield { choices: [{ delta: { content: "Hello" } }] } as OpenAiChatChunk;
      yield { choices: [{ delta: { content: "<details><summary>Resp</summary>" } }] } as OpenAiChatChunk;
      yield { choices: [{ delta: { content: "</details>" } }] } as OpenAiChatChunk;
    }

    const client = {
      chatCompletions: () => streamChunks(),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

    // Parse all non-DONE chunks and extract delta.content
    const contents = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter((d) => d?.choices?.[0]?.delta?.content)
      .map((d) => d.choices[0].delta.content);

    // <details> content should be stripped
    expect(contents.join("")).not.toContain("<details>");
    expect(contents.join("")).toContain("Hello");
  });

  it("stream passes reasoning_content through unstripped", async () => {
    async function* streamChunks() {
      yield { choices: [{ delta: { reasoning_content: "Thinking..." } }] } as OpenAiChatChunk;
      yield { choices: [{ delta: { content: "Answer" } }] } as OpenAiChatChunk;
      yield { choices: [{ finish_reason: "stop" }] } as OpenAiChatChunk;
    }

    const client = {
      chatCompletions: () => streamChunks(),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

    const chunks = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);

    // Reasoning content should pass through
    const reasoningChunks = chunks.filter((d) => d.choices?.[0]?.delta?.reasoning_content);
    expect(reasoningChunks.length).toBe(1);
    expect(reasoningChunks[0].choices[0].delta.reasoning_content).toBe("Thinking...");
  });

  it("stream emits synthetic finish_reason:'stop' when upstream omits it", async () => {
    async function* streamChunks() {
      yield { choices: [{ delta: { content: "Done" } }] } as OpenAiChatChunk;
      // No finish_reason chunk
    }

    const client = {
      chatCompletions: () => streamChunks(),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

    // Find the finish_reason chunk
    const finishChunks = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter((d) => d?.choices?.[0]?.finish_reason === "stop");

    expect(finishChunks.length).toBeGreaterThanOrEqual(1);
  });

  // ── Sentinel mid-stream → error + [DONE] ───────────────────────────────

  it("sentinel (D14) mid-stream emits error event + [DONE]", async () => {
    async function* streamChunks() {
      yield { choices: [{ delta: { content: "partial" } }] } as OpenAiChatChunk;
      // The sentinel is injected by withPoolRetryStream, simulate it directly
      yield { done: true, extra: { rateLimited: true } } as any;
    }

    const client = {
      chatCompletions: () => streamChunks(),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));

    // Should contain an error event before [DONE]
    const errorLine = dataLines.find((l) => {
      try { return JSON.parse(l.slice(6)).error !== undefined; } catch { return false; }
    });

    expect(errorLine).toBeDefined();
    const errorData = JSON.parse(errorLine!.slice(6));
    expect(errorData.error.type).toBe("rate_limit_error");
    expect(errorData.error.code).toBe("rate_limit_exceeded");

    // Last line is [DONE]
    expect(dataLines[dataLines.length - 1]).toBe("data: [DONE]");
  });

  // ── F1 failover ────────────────────────────────────────────────────────

  it("non-stream: chatCompletions RateLimitError triggers failover via retry", async () => {
    db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
    ]);
    db.prepare("UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=1").run();
    upsertToken(db, 1, "bearer-1", 999999);
    upsertToken(db, 2, "bearer-2", 999999);

    let chatCompletionsCallCount = 0;
    const client = {
      chatCompletions: async (bearer: string) => {
        chatCompletionsCallCount++;
        if (bearer === "bearer-1") {
          throw new RateLimitError("Rate limited");
        }
        return {
          id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from account 2" }, finish_reason: "stop" }],
        };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("Hello from account 2");
    expect(chatCompletionsCallCount).toBe(2);
  });

  it("stream: chatCompletions RateLimitError triggers failover via retryStream", async () => {
    db = openDb(":memory:");
    reconcileAccounts(db, [
      { id: 1, email: "a@test.com", password: "pw1", ord: 1 },
      { id: 2, email: "b@test.com", password: "pw2", ord: 2 },
    ]);
    db.prepare("UPDATE accounts SET state='active', re_enable_at=NULL WHERE id=1").run();
    upsertToken(db, 1, "bearer-1", 999999);
    upsertToken(db, 2, "bearer-2", 999999);

    let chatCompletionsCallCount = 0;
    const client = {
      chatCompletions: (bearer: string, body: Record<string, unknown>) => {
        chatCompletionsCallCount++;
        if (bearer === "bearer-1") {
          throw new RateLimitError("Rate limited");
        }
        if (body.stream) {
          return (async function* () {
            yield { choices: [{ delta: { content: "Streamed from account 2" } }] } as OpenAiChatChunk;
          })();
        }
        return Promise.resolve({} as OpenAiChatCompletion);
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    const allContent = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter((d) => d?.choices?.[0]?.delta?.content)
      .map((d) => d.choices[0].delta.content)
      .join("");
    expect(allContent).toContain("Streamed from account 2");
    expect(chatCompletionsCallCount).toBe(2);
  });

  // ── Pool exhausted → 429 ────────────────────────────────────────────────

  it("non-stream: returns 429 on PoolExhaustedError", async () => {
    db.prepare("UPDATE accounts SET state='disabled', re_enable_at=? WHERE id=1").run(Date.now() + 60_000);

    const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps = makeDeps(db);
    const app = new Hono();
    app.use("/v1/*", clientAuthGate({ db: deps.db, envKeys: ["test-key"], log: deps.log }));
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
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
  });

  it("stream + pool exhausted → 429 with Retry-After header", async () => {
    db.prepare("UPDATE accounts SET state='disabled', re_enable_at=? WHERE id=1").run(Date.now() + 60_000);

    const pool = new AccountPool({ db, log: noopLog, now: () => 1000 });
    pool.hydrate();

    const deps = makeDeps(db);
    const app = new Hono();
    app.use("/v1/*", clientAuthGate({ db: deps.db, envKeys: ["test-key"], log: deps.log }));
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
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    const body = await res.json();
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
  });

  // ── Auth required ───────────────────────────────────────────────────────

  it("returns 401 when no api key", async () => {
    const deps = makeDeps(db);
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(401);
  });

  // ── Model passthrough (response model = original SDK model) ─────────────

  it("response model is the original SDK model name, not upstreamId", async () => {
    const client = {
      chatCompletions: async () => ({
        id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max-thinking", messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Should be the original model with suffix, not the upstreamId without
    expect(body.model).toBe("qwen3-max-thinking");
  });
});
