import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/store/db";
import { SingleAccountPool } from "../../../src/pool/single";
import { withPoolRetry, withPoolRetryStream, type ProxyPoolLike } from "../../../src/pool/retry";
import { EmptyCompletionError } from "../../../src/upstream/errors";
import { clientAuthGate } from "../../../src/server/auth";
import { chatRoutes } from "../../../src/adapters/openai/chat";

import type { UpstreamClient, OpenAiChatChunk, OpenAiChatCompletion } from "../../../src/upstream/client";
import type { Logger } from "../../../src/server/logger";

const noopLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function setupDb(): Database.Database {
  const db = openDb(":memory:");
  return db;
}

interface ChatDeps {
  db: Database.Database;
  pool: SingleAccountPool;
  scheduler: { refreshOnDemand: () => Promise<{ bearer: string; expiresAt: number }> };
  config: { emptyCooldownMs: number; emptyRetryMax: number; emptyRetryGapMs: number; modelAliasesRaw: string };
  log: Logger;
  client: UpstreamClient;
  retry: typeof withPoolRetry;
  retryStream: typeof withPoolRetryStream;
  proxyPool?: ProxyPoolLike;
}

function makeDeps(
  db: Database.Database,
  overrides?: {
    client?: Partial<UpstreamClient>;
    config?: Partial<ChatDeps["config"]>;
  },
): ChatDeps {
  const pool = new SingleAccountPool({ log: noopLog });
  return {
    db,
    pool,
    scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
    config: { emptyCooldownMs: 600_000, emptyRetryMax: 3, emptyRetryGapMs: 1_000, modelAliasesRaw: "", ...overrides?.config },
    log: noopLog,
    client: {
      listModels: async () => [],
      chatCompletions: (async (_bearer: string, body: Record<string, unknown>) => {
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
      }) as unknown as UpstreamClient["chatCompletions"],
      deleteChats: async () => {},
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
    ...(deps.proxyPool ? { proxyPool: deps.proxyPool } : {}),
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
      expect.objectContaining({ model: "qwen3.8-max", stream: false }),
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
      expect.objectContaining({ model: "qwen3.8-max", stream: false, enable_thinking: true }),
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
      expect.objectContaining({ model: "qwen3.8-max", tools: [{ type: "web_search" }] }),
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

  it("function tools stripped from upstream + prompt injected", async () => {
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
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [{ type: "function", function: { name: "get_weather", description: "Get weather" } }],
      }),
    });

    expect(res.status).toBe(200);
    // function tools should be STRIPPED from upstream body
    expect(chatCompletionsCalledWith).not.toHaveProperty("tools");
    expect(chatCompletionsCalledWith).not.toHaveProperty("tool_choice");
    // messages[0] should be system with tool descriptions + <tool_calls>
    const msgs = (chatCompletionsCalledWith as any).messages;
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("get_weather");
    expect(msgs[0].content).toContain("<tool_calls>");
  });

  it("continuation turn (history has tool_calls) → NO tool-prompt injection", async () => {
    // Live-debugged on mini 2026-08-14: qwen suppresses the answer server-side
    // (zero content/reasoning deltas) when the injected "# Available Tools"
    // system block is present on a continuation turn. Skipping the injection
    // there fixes silent-empty stops after tool results.
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
        messages: [
          { role: "user", content: "Search the weather" },
          { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: "NWS: sunny, 101F" },
        ],
        tools: [{ type: "function", function: { name: "web_search", description: "Search" } }],
      }),
    });

    expect(res.status).toBe(200);
    expect(chatCompletionsCalledWith).not.toHaveProperty("tools");
    const msgs = (chatCompletionsCalledWith as any).messages;
    // tool result hoisted as system "Tool ... returned:"; assistant tool_calls
    // folded into the flattened user turn as <tool_calls> text (guest-mode flattening)
    expect(msgs.some((m: any) => m.role === "system" && m.content.includes("Tool `web_search` returned:"))).toBe(true);
    expect(JSON.stringify(msgs)).toContain("<tool_calls>");
    // NO "# Available Tools" in the SYSTEM position (suppression trigger) —
    // the tool list is appended to the LAST message instead (tool discovery preserved)
    expect(msgs.some((m: any) => m.role === "system" && m.content.includes("# Available Tools"))).toBe(false);
    const lastMsg = msgs[msgs.length - 1];
    expect(String(lastMsg.content)).toContain("# Available Tools");
    expect(String(lastMsg.content)).toContain("web_search");
  });

  it("non-function tools (web_search) still passthrough", async () => {
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
        tool_choice: "auto",
      }),
    });

    expect(res.status).toBe(200);
    // non-function tools should still passthrough
    expect(chatCompletionsCalledWith).toHaveProperty("tools", [{ type: "web_search" }]);
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

  it("function-calling tools + tool_choice stripped, system prompt injected", async () => {
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
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object" } } }],
        tool_choice: "auto",
      }),
    });

    expect(res.status).toBe(200);
    // NO tools/tool_choice in upstream body
    expect(chatCompletionsCalledWith).not.toHaveProperty("tools");
    expect(chatCompletionsCalledWith).not.toHaveProperty("tool_choice");
    // messages[0] system contains tool descriptions
    const msgs = (chatCompletionsCalledWith as any).messages;
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("get_weather");
    expect(msgs[0].content).toContain("Get weather");
  });

  it("non-stream: parseToolCalls from response content → tool_calls + finish_reason", async () => {
    const client = {
      chatCompletions: async () => ({
        id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
        choices: [{ index: 0, message: {
          role: "assistant",
          content: '<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}}]</tool_calls>',
        }, finish_reason: "stop" }],
      }),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.tool_calls).toBeDefined();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].finish_reason).toBe("tool_calls");
  });

  it("non-stream: malformed <tool_calls> → tag stripped, no tool_calls, finish_reason:stop", async () => {
    const client = {
      chatCompletions: async () => ({
        id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
        choices: [{ index: 0, message: {
          role: "assistant",
          content: '<tool_calls>[garbage not json]</tool_calls>',
        }, finish_reason: "stop" }],
      }),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // Content should NOT contain raw <tool_calls> tags — tag span stripped
    const msgContent = body.choices[0].message.content;
    expect(msgContent === null || (typeof msgContent === "string" && !msgContent.includes("<tool_calls>"))).toBe(true);
    // No valid tool calls extracted
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].finish_reason).toBe("stop");
  });

  it("tool_choice:'none' → no injection, tools forwarded as-is", async () => {
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
        tools: [{ type: "function", function: { name: "get_weather" } }],
        tool_choice: "none",
      }),
    });

    expect(res.status).toBe(200);
    // tool_choice:"none" → no injection, tools forwarded
    expect(chatCompletionsCalledWith).toHaveProperty("tools");
    expect(chatCompletionsCalledWith).toHaveProperty("tool_choice", "none");
    // no system prompt injection (messages[0] should be user, not system)
    const msgs = (chatCompletionsCalledWith as any).messages;
    expect(msgs[0].role).toBe("user");
  });

  it("deleteChats fire-and-forget after non-stream response", async () => {
    const deleteChats = vi.fn().mockResolvedValue(undefined);
    const client = {
      chatCompletions: async () => ({
        id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
      deleteChats,
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(200);
    // Wait a tick for fire-and-forget to execute
    await new Promise((r) => setTimeout(r, 10));
    expect(deleteChats).toHaveBeenCalled();
  });

  it("role:'tool' message rewritten + assistant tool_calls round-trip", async () => {
    let chatCompletionsCalledWith: Record<string, unknown> | undefined;
    const client = {
      chatCompletions: async (_bearer: string, body: Record<string, unknown>) => {
        chatCompletionsCalledWith = body;
        return { id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "The weather is 25°C" }, finish_reason: "stop" }] };
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [
          { role: "user", content: "What's the weather in Tokyo?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"location":"Tokyo"}' } }],
          },
          { role: "tool", tool_call_id: "call_1", content: '{"temp":25}' },
        ],
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    });

    expect(res.status).toBe(200);
    const msgs = (chatCompletionsCalledWith as any).messages;
    // After flattenForUpstream: system(combined) has tool prompt + result; user(combined) has conversation
    const systemMsg = msgs.find((m: any) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain("get_weather");
    expect(systemMsg.content).toContain("temp");
    const userMsg = msgs.find((m: any) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toContain("<tool_calls>");
    expect(userMsg.content).toContain("Assistant:");
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

    // M4-72: The synthetic finish_reason MUST be the last data: frame before [DONE].
    const parsedChunks = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);
    const lastData = parsedChunks[parsedChunks.length - 1];
    expect(lastData?.choices?.[0]?.finish_reason).toBe("stop");
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

  it("chunk with done+choices is NOT treated as sentinel (audit F2)", async () => {
    async function* streamChunks() {
      yield { choices: [{ delta: { content: "hello" } }] } as OpenAiChatChunk;
      // A hypothetical upstream chunk that has both "done" and "choices" fields
      // should NOT trigger the sentinel path
      yield { done: true, choices: [{ delta: { content: " world" }, finish_reason: "stop" }] } as any;
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

    // Should NOT contain an error event — this is a normal chunk, not a sentinel
    const errorLine = dataLines.find((l) => {
      try { return JSON.parse(l.slice(6)).error !== undefined; } catch { return false; }
    });
    expect(errorLine).toBeUndefined();

    // Both content chunks should be present in the output (details stripper may
    // buffer/merge them, so just check all content chars are there)
    const contentChunks = dataLines
      .filter((l) => { try { const d = JSON.parse(l.slice(6)); return d.choices?.[0]?.delta?.content; } catch { return false; } })
      .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content);
    const allContent = contentChunks.join("");
    expect(allContent).toContain("llo");
    expect(allContent).toContain(" world");

    // Last line is [DONE]
    expect(dataLines[dataLines.length - 1]).toBe("data: [DONE]");
  });

  // ── Co-carried content in reasoning/finish branches (audit F3) ─────────

  it("reasoning_content chunk with co-carried content strips content (audit F3)", async () => {
    async function* streamChunks() {
      // Chunk that co-carries both reasoning_content and content
      yield {
        choices: [{ delta: { reasoning_content: "thinking...", content: "<details>leaked</details>answer" } }],
      } as OpenAiChatChunk;
      // Normal content chunk
      yield { choices: [{ delta: { content: "real answer" } }] } as OpenAiChatChunk;
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

    // The reasoning chunk should have reasoning_content but NO content
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    const parsedChunks = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);

    const reasoningChunks = parsedChunks.filter((c) => c.choices?.[0]?.delta?.reasoning_content);
    expect(reasoningChunks.length).toBeGreaterThanOrEqual(1);

    // The reasoning chunk must NOT have a content field in its delta
    for (const rc of reasoningChunks) {
      expect(rc.choices[0].delta.content).toBeUndefined();
    }

    // Raw <details> content must NOT appear in any chunk
    expect(text).not.toContain("<details>leaked</details>");
  });

  it("finish_reason chunk with co-carried <details> content strips content (audit F3)", async () => {
    async function* streamChunks() {
      // Only one chunk: co-carries finish_reason AND content with <details>
      yield {
        choices: [{ delta: { content: "<details>leaked</details>answer" }, finish_reason: "stop" }],
      } as OpenAiChatChunk;
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

    // Raw <details> content must NOT appear in any output
    expect(text).not.toContain("<details>leaked</details>");

    // The finish_reason chunk should have finish_reason but content stripped
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    const parsedChunks = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);

    const finishChunks = parsedChunks.filter((c) => c.choices?.[0]?.finish_reason === "stop");
    expect(finishChunks.length).toBeGreaterThanOrEqual(1);

    // The finish_reason chunk must NOT carry the raw <details> content
    // (F3 strips co-carried delta.content from finish branches)
    for (const fc of finishChunks) {
      const c = fc.choices[0].delta.content;
      expect(c === undefined || (typeof c === "string" && !c.includes("<details>"))).toBe(true);
    }
  });

  // ── Pool exhausted → 429 ────────────────────────────────────────────────
  // Multi-account failover is tested in tests/pool/retry.test.ts (FakeMultiPool).
  // Here we test the adapter's 429 surface when SingleAccountPool is exhausted.

  it("non-stream: returns 429 on PoolExhaustedError", async () => {
    const pool = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    await pool.markEmptyAndSwitch(0, 60_000);

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
    const pool = new SingleAccountPool({ log: noopLog, now: () => 1000 });
    await pool.markEmptyAndSwitch(0, 60_000);

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

  // ── S-6: Stream tool-calling integration ─────────────────────────────────

  it("stream: <tool_calls> tag → delta.tool_calls + finish_reason:tool_calls", async () => {
    const toolCallsTag = '<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}}]</tool_calls>';
    async function* streamChunks() {
      // Split the tag across multiple chunks to test the detector
      yield { choices: [{ delta: { content: toolCallsTag } }] } as OpenAiChatChunk;
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
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "What's the weather?" }],
        stream: true,
        tools: [{ type: "function", function: { name: "get_weather", description: "Get weather" } }],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    const chunks = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);

    // Should have delta.tool_calls with the parsed tool call
    const toolCallChunks = chunks.filter((d) => d.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks.length).toBeGreaterThanOrEqual(1);
    const toolCalls = toolCallChunks[0].choices[0].delta.tool_calls;
    expect(toolCalls[0].function.name).toBe("get_weather");
    expect(toolCalls[0].type).toBe("function");
    expect(toolCalls[0].id).toMatch(/^call_/);

    // finish_reason should be "tool_calls"
    const finishChunks = chunks.filter((d) => d.choices?.[0]?.finish_reason);
    expect(finishChunks.some((d) => d.choices[0].finish_reason === "tool_calls")).toBe(true);

    // M4-72: The synthetic finish_reason:tool_calls MUST be the last data: frame before [DONE].
    const lastData = chunks[chunks.length - 1];
    expect(lastData?.choices?.[0]?.finish_reason).toBe("tool_calls");

    // Raw <tool_calls> text must NOT appear in content deltas
    const contentChunks = chunks.filter((d) => d.choices?.[0]?.delta?.content);
    const allContent = contentChunks.map((d) => d.choices[0].delta.content).join("");
    expect(allContent).not.toContain("<tool_calls>");
  });

  it("stream: no <tool_calls> → normal content + finish_reason:stop", async () => {
    async function* streamChunks() {
      yield { choices: [{ delta: { content: "Hello world" } }] } as OpenAiChatChunk;
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
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    const chunks = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);

    // Content should be present
    const contentChunks = chunks.filter((d) => d.choices?.[0]?.delta?.content);
    const allContent = contentChunks.map((d) => d.choices[0].delta.content).join("");
    expect(allContent).toContain("Hello world");

    // No tool_calls
    const toolCallChunks = chunks.filter((d) => d.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks.length).toBe(0);

    // finish_reason should be "stop"
    const finishChunks = chunks.filter((d) => d.choices?.[0]?.finish_reason);
    expect(finishChunks.some((d) => d.choices[0].finish_reason === "stop")).toBe(true);
  });

  it("stream: mid-tag end → discard + stop (Q4=a)", async () => {
    async function* streamChunks() {
      // Start a <tool_calls> tag but stream ends before closing
      yield { choices: [{ delta: { content: "<tool_calls>[{\"name\":\"x\"" } }] } as OpenAiChatChunk;
      // Stream ends — no finish_reason from upstream
    }

    const client = {
      chatCompletions: () => streamChunks(),
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    const chunks = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);

    // No tool_calls emitted (mid-tag discarded)
    const toolCallChunks = chunks.filter((d) => d.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks.length).toBe(0);

    // finish_reason should be "stop" (synthetic, since no tool calls)
    const finishChunks = chunks.filter((d) => d.choices?.[0]?.finish_reason);
    expect(finishChunks.some((d) => d.choices[0].finish_reason === "stop")).toBe(true);
  });

  it("stream: content after </tool_calls> suppressed (Q5=a)", async () => {
    const toolCallsTag = '<tool_calls>[{"name":"get_weather","arguments":{"location":"Tokyo"}}]</tool_calls>';
    async function* streamChunks() {
      yield { choices: [{ delta: { content: toolCallsTag + "trailing text" } }] } as OpenAiChatChunk;
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
      body: JSON.stringify({
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
        tools: [{ type: "function", function: { name: "get_weather" } }],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    const chunks = dataLines
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
      .filter(Boolean);

    // "trailing text" must NOT appear in any content delta
    const contentChunks = chunks.filter((d) => d.choices?.[0]?.delta?.content);
    const allContent = contentChunks.map((d) => d.choices[0].delta.content).join("");
    expect(allContent).not.toContain("trailing");

    // Tool calls should still be emitted
    const toolCallChunks = chunks.filter((d) => d.choices?.[0]?.delta?.tool_calls);
    expect(toolCallChunks.length).toBeGreaterThanOrEqual(1);
  });

  it("stream: deleteChats fire-and-forget after stream closes", async () => {
    const deleteChats = vi.fn().mockResolvedValue(undefined);

    async function* streamChunks() {
      yield { choices: [{ delta: { content: "Hello" } }] } as OpenAiChatChunk;
      yield { choices: [{ finish_reason: "stop" }] } as OpenAiChatChunk;
    }

    const client = {
      chatCompletions: () => streamChunks(),
      deleteChats,
    } as unknown as UpstreamClient;

    const deps = makeDeps(db, { client });
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });

    expect(res.status).toBe(200);
    // Consume the stream to completion
    await res.text();
    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 50));
    expect(deleteChats).toHaveBeenCalled();
  });

  // ── S-M2-4: Proxy rotation e2e ───────────────────────────────────────────

  it("non-stream: FakeProxyPool rotation — EmptyCompletion on A, success on B → 200", async () => {
    class FakeProxyPool implements ProxyPoolLike {
      private readonly keys: string[];
      private head = 0;
      rotateCalls = 0;
      constructor(keys: string[]) { this.keys = keys; }
      get size() { return this.keys.length; }
      getActive() { return this.keys[this.head]; }
      rotate() { this.rotateCalls++; this.head = (this.head + 1) % this.keys.length; return this.keys[this.head]; }
    }

    const pool = new FakeProxyPool(["socks5://u:p@a:1080", "socks5://u:p@b:1080"]);
    let callCount = 0;
    const seen: string[] = [];

    const client = {
      chatCompletions: async (_bearer: string, _body: Record<string, unknown>, proxy?: string) => {
        callCount++;
        seen.push(proxy!);
        if (callCount === 1) throw new EmptyCompletionError("empty");
        return {
          id: "c", object: "chat.completion" as const, created: 0, model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        };
      },
    } as unknown as UpstreamClient;

    const db = setupDb();
    const deps = makeDeps(db, { client });
    // Inject proxyPool into deps (simulates bin wiring)
    deps.proxyPool = pool;
    const app = createTestApp(deps);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-max", messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(res.status).toBe(200);
    // Q1=B: first empty evicts + inline re-mints and retries the SAME proxy
    expect(seen).toEqual([
      "socks5://u:p@a:1080",
      "socks5://u:p@a:1080",
    ]);
    expect(pool.rotateCalls).toBe(0);
  });
});
