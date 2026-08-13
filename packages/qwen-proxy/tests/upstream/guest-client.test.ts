import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { GuestUpstreamClient } from "../../src/upstream/guest-client";
import { ClientError, EmptyCompletionError } from "../../src/upstream/errors";
import type { BaxiaTokenManager, BaxiaTokens } from "../../src/upstream/baxia-token";
import type { UpstreamClient } from "../../src/upstream/client";
import type { OpenAiChatCompletion } from "../../src/upstream/types";
import type { Logger } from "../../src/server/logger";

// ── Helpers ──────────────────────────────────────────────────────────────

const FAKE_TOKENS: BaxiaTokens = {
  bxUa: "231!T2gAfake",
  bxUmidToken: "T2gA" + "a".repeat(24),
  bxV: "2.5.37",
  cookies: "c1=v1; c2=v2",
};

function makeBaxia(overrides?: Partial<BaxiaTokenManager>): BaxiaTokenManager {
  return {
    ensureToken: vi.fn().mockResolvedValue(FAKE_TOKENS),
    startRefreshLoop: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(),
    ...overrides,
  } as unknown as BaxiaTokenManager;
}

const noopLog: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function loadFixtureStream(name: string): ReadableStream<Uint8Array> {
  const filePath = path.join(__dirname, "fixtures", name);
  const content = fs.readFileSync(filePath, "utf-8");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function makeSseResponse(fixtureName: string): Response {
  return {
    ok: true,
    body: loadFixtureStream(fixtureName),
  } as unknown as Response;
}

// ── createChatSession ────────────────────────────────────────────────────

describe("createChatSession", () => {
  it("POSTs to /api/v2/chats/new with correct headers and body, returns data.data.id", async () => {
    const sessionId = "chat-session-abc";
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: sessionId } }),
    });

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    const result = await client.createChatSession("qwen3-max", "t2t");

    expect(result).toBe(sessionId);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://chat.qwen.ai/api/v2/chats/new");

    const headers = init.headers as Record<string, string>;
    expect(headers["bx-ua"]).toBe(FAKE_TOKENS.bxUa);
    expect(headers["bx-umidtoken"]).toBe(FAKE_TOKENS.bxUmidToken);
    expect(headers["bx-v"]).toBe(FAKE_TOKENS.bxV);
    expect(headers["Cookie"]).toBe(FAKE_TOKENS.cookies);
    expect(headers["source"]).toBe("web");
    expect(headers["version"]).toBe("0.2.83");
    expect(headers["User-Agent"]).toContain("Chrome");
    // Anti-bot headers chat.qwen.ai expects on session creation too
    expect(headers["Origin"]).toBe("https://chat.qwen.ai");
    expect(headers["Referer"]).toBe("https://chat.qwen.ai/c/guest");

    const body = JSON.parse(init.body);
    expect(body.chat_mode).toBe("guest");
    expect(body.chat_type).toBe("t2t");
    expect(body.models).toEqual(["qwen3-max"]);
    expect(body.title).toBe("新建对话");
    expect(body.project_id).toBe("");
  });

  it("retries on rgv587 response (baxia forceRefresh + retry)", async () => {
    const baxia = makeBaxia();
    const fetcher = vi
      .fn()
      // 1st call: rgv587
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rgv587: true, message: "captcha" }),
      })
      // 2nd call: success
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "session-retry" } }),
      });

    const client = new GuestUpstreamClient({
      baxia,
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
      sleep: async () => {}, // no delay in tests
    });

    const result = await client.createChatSession("qwen3-max", "t2t");

    expect(result).toBe("session-retry");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(baxia.ensureToken).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it("P1: rgv587 retry uses FRESH (not stale) bx-* headers after forceRefresh", async () => {
    const STALE_TOKENS: BaxiaTokens = {
      bxUa: "231!STALE-ua",
      bxUmidToken: "STALE-umid" + "x".repeat(20),
      bxV: "2.5.37",
      cookies: "stale=c1",
    };
    const FRESH_TOKENS: BaxiaTokens = {
      bxUa: "231!FRESH-ua",
      bxUmidToken: "FRESH-umid" + "x".repeat(20),
      bxV: "2.5.37",
      cookies: "fresh=c1",
    };

    const ensureTokenMock = vi.fn()
      // 1st call (no forceRefresh) → STALE
      .mockResolvedValueOnce(STALE_TOKENS)
      // 2nd call (forceRefresh:true) → FRESH
      .mockResolvedValueOnce(FRESH_TOKENS);

    const baxia = {
      ensureToken: ensureTokenMock,
      startRefreshLoop: vi.fn(),
      stop: vi.fn(),
      status: vi.fn(),
    } as unknown as BaxiaTokenManager;

    const fetcher = vi.fn()
      // 1st POST: rgv587 rejection (triggers forceRefresh retry)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rgv587: true, message: "captcha" }),
      })
      // 2nd POST: success
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "session-fresh" } }),
      });

    const client = new GuestUpstreamClient({
      baxia,
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
      sleep: async () => {},
    });

    const result = await client.createChatSession("qwen3-max", "t2t");

    expect(result).toBe("session-fresh");
    expect(fetcher).toHaveBeenCalledTimes(2);

    // (a) ensureToken was called with forceRefresh after the rgv587
    expect(ensureTokenMock).toHaveBeenCalledTimes(2);
    expect(ensureTokenMock).toHaveBeenNthCalledWith(1, undefined);
    expect(ensureTokenMock).toHaveBeenNthCalledWith(2, { forceRefresh: true });

    // (b) The 2nd POST must carry FRESH headers, not STALE
    const [, retryInit] = fetcher.mock.calls[1];
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders["bx-ua"]).toBe(FRESH_TOKENS.bxUa);
    expect(retryHeaders["bx-umidtoken"]).toBe(FRESH_TOKENS.bxUmidToken);
    expect(retryHeaders["Cookie"]).toBe(FRESH_TOKENS.cookies);
  });
});

// ── normalizeMessages ────────────────────────────────────────────────────

describe("normalizeMessages", () => {
  it("produces correct Qwen message envelope shape", () => {
    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      log: noopLog,
    });

    const result = client.normalizeMessages(
      [{ role: "user", content: "Hello" }],
      "qwen3-max",
      "t2t",
      true,  // enableThinking
      false, // autoSearch
    );

    // Shape assertions
    expect(result.fid).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(result.childrenIds).toHaveLength(1);
    expect(result.childrenIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.role).toBe("user");
    expect(result.content).toBe("Hello");
    expect(result.user_action).toBe("chat");
    expect(result.files).toEqual([]);
    expect(result.models).toEqual(["qwen3-max"]);
    expect(result.chat_type).toBe("t2t");

    // feature_config (7 fields — matches qwen2api core.js, incl. thinking_mode)
    expect(result.feature_config).toEqual({
      thinking_enabled: true,
      output_schema: "phase",
      research_mode: "normal",
      auto_thinking: true,
      thinking_mode: "Auto",
      thinking_format: "summary",
      auto_search: false,
    });

    // qwen2api sends id:null + an empty model field on the message
    expect(result.id).toBeNull();
    expect(result.model).toBe("");

    // extra.meta.subChatType
    expect(result.extra.meta.subChatType).toBe("t2t");

    expect(result.sub_chat_type).toBe("t2t");
    expect(result.parent_id).toBeNull();
    expect(result.parentId).toBeNull();
  });

  it("merges multiple messages into history format", () => {
    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      log: noopLog,
    });

    const result = client.normalizeMessages(
      [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
      "qwen3-max",
      "t2t",
      false,
      false,
    );

    // Should contain system prefix and history
    expect(result.content).toContain("[System]: You are helpful");
    expect(result.content).toContain("[User]: Hi");
    expect(result.content).toContain("[Assistant]: Hello!");
    // Last message content is appended at end
    expect(result.content).toContain("How are you?");
  });

  it("sets auto_search when chatType is search", () => {
    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      log: noopLog,
    });

    const result = client.normalizeMessages(
      [{ role: "user", content: "Search this" }],
      "qwen3-max",
      "search",
      false,
      true, // autoSearch
    );

    expect(result.chat_type).toBe("search");
    expect(result.feature_config.auto_search).toBe(true);
    expect(result.extra.meta.subChatType).toBe("search");
  });
});

// ── chatCompletions ────────────────────────────────────────────────────

describe("chatCompletions", () => {
  it("stream: yields chunks with no finish_reason, output_schema:phase in body, enable_thinking→thinking_enabled", async () => {
    const fetcher = vi
      .fn()
      // createChatSession
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "sid-stream" } }),
      })
      // chat completions stream
      .mockResolvedValueOnce(makeSseResponse("qwen-stream-thinking.txt"));

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    const result = client.chatCompletions("ignored", {
      model: "qwen3-max",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      enable_thinking: true,
    });

    // Should return an async iterable (stream mode)
    expect(result).toBeInstanceOf(Object);
    const chunks: any[] = [];
    for await (const chunk of result as AsyncIterable<any>) {
      chunks.push(chunk);
    }

    // Yields reasoning then content
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks[0].choices[0].delta.reasoning_content).toBeTruthy();
    expect(chunks[2].choices[0].delta.content).toBe("Hello ");

    // No chunk has finish_reason
    for (const chunk of chunks) {
      expect(chunk.choices[0].finish_reason).toBeUndefined();
    }

    // Verify posted body has output_schema:phase and thinking_enabled
    const [, completionsInit] = fetcher.mock.calls[1];
    const postedBody = JSON.parse(completionsInit.body);
    expect(postedBody.messages[0].feature_config.output_schema).toBe("phase");
    expect(postedBody.messages[0].feature_config.thinking_enabled).toBe(true);
    expect(postedBody.messages[0].feature_config.thinking_mode).toBe("Auto");
    expect(postedBody.messages[0].id).toBeNull();
    expect(postedBody.messages[0].model).toBe("");
    // Anti-bot headers chat.qwen.ai expects (Origin/Referer/x-accel-buffering)
    expect(completionsInit.headers.Origin).toBe("https://chat.qwen.ai");
    expect(completionsInit.headers.Referer).toBe("https://chat.qwen.ai/c/guest");
    expect(completionsInit.headers["x-accel-buffering"]).toBe("no");
  });

  it("tools with web_search → chat_type:search + auto_search:true", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "sid-search" } }),
      })
      .mockResolvedValueOnce(makeSseResponse("qwen-stream-thinking.txt"));

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    const result = client.chatCompletions("ignored", {
      model: "qwen3-max",
      messages: [{ role: "user", content: "Search this" }],
      stream: true,
      tools: [{ type: "web_search" }],
    });

    // Drain the stream
    for await (const _ of result as AsyncIterable<any>) { /* consume */ }

    // Verify createChatSession was called with search
    const [sessionUrl, sessionInit] = fetcher.mock.calls[0];
    expect(sessionUrl).toContain("/api/v2/chats/new");
    const sessionBody = JSON.parse(sessionInit.body);
    expect(sessionBody.chat_type).toBe("search");

    // Verify normalizeMessages got auto_search:true
    const [, completionsInit] = fetcher.mock.calls[1];
    const postedBody = JSON.parse(completionsInit.body);
    expect(postedBody.messages[0].feature_config.auto_search).toBe(true);
    expect(postedBody.messages[0].chat_type).toBe("search");
  });

  it("non-stream: joins deltas into OpenAiChatCompletion with finish_reason stop", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "sid-nonstream" } }),
      })
      .mockResolvedValueOnce(makeSseResponse("qwen-stream-thinking.txt"));

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    const result = await client.chatCompletions("ignored", {
      model: "qwen3-max",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    }) as OpenAiChatCompletion;

    // Should be an OpenAiChatCompletion object
    expect(result).toHaveProperty("object", "chat.completion");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.choices[0].message.role).toBe("assistant");
    expect(result.choices[0].message.content).toBe("Hello world");
    expect(result.usage).toBeDefined();
    expect(result.usage!.prompt_tokens).toBe(5);
    expect(result.usage!.completion_tokens).toBe(2);
  });

  it("throws ClientError(400) on data_inspection_failed (content moderation)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "sid-fail" } }),
      })
      // SSE with data_inspection_failed
      .mockResolvedValueOnce({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            const text = 'data: {"data_inspection_failed":true}\n\ndata: [DONE]\n';
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
      });

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    // Stream mode: throws when iterating
    let caught: unknown;
    try {
      for await (const _ of client.chatCompletions("ignored", {
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }) as AsyncIterable<any>) { /* drain */ }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).status).toBe(400);
  });

  it("non-OK response with data_inspection_failed body → ClientError(400) (re-throw guard, not generic 500)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "sid-nonok" } }),
      })
      // completion returns non-OK with a moderation body
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"data_inspection_failed":true}',
      });

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    let caught: unknown;
    try {
      for await (const _ of client.chatCompletions("ignored", {
        model: "qwen3-max",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }) as AsyncIterable<any>) { /* drain */ }
    } catch (e) {
      caught = e;
    }
    // The instanceof ClientError re-throw guard must preserve this —
    // without it the moderation signal would be swallowed into a generic 500.
    expect(caught).toBeInstanceOf(ClientError);
    expect((caught as ClientError).status).toBe(400);
  });
});

// ── listModels ────────────────────────────────────────────────────────

describe("listModels", () => {
  it("JSON path: returns models from /api/models", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        models: [{ id: "qwen3-max" }, { id: "qwen3-plus" }],
      }),
    });

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    const models = await client.listModels("ignored");

    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ id: "qwen3-max", object: "model", owned_by: "qwen" });
    expect(models[1]).toEqual({ id: "qwen3-plus", object: "model", owned_by: "qwen" });
  });

  it("HTML-scrape path: extracts models from prerendered data", async () => {
    const html = `<html><script>window.__PRERENDERED_DATA__ = {"models":[{"id":"qwen-turbo"}]}</script></html>`;
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => html,
    });

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    const models = await client.listModels("ignored");

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("qwen-turbo");
  });

  it("P3-1: extractPrerenderedData handles model objects with nested arrays", async () => {
    // Model objects with nested arrays (e.g. "tags":["a","b"]) break the old non-greedy regex
    const html = `<html><script>window.__PRERENDERED_DATA__ = {"models":[{"id":"qwen3-max","tags":["fast","smart"]},{"id":"qwen-turbo","capabilities":[{"name":"chat"},{"name":"search"}]}]}</script></html>`;
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => html,
    });

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    const models = await client.listModels("ignored");

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("qwen3-max");
    expect(models[1].id).toBe("qwen-turbo");
  });

  it("P3-1b: extracts models with nested arrays via balanced-bracket fallback (no __PRERENDERED_DATA__)", async () => {
    // HTML with "models" key but no __PRERENDERED_DATA__ — exercises the balanced-bracket path
    const html = `<html><script>var cfg = {"models":[{"id":"qwen-max","tags":["reasoning","code"]},{"id":"qwen-plus"}], "other":123};</script></html>`;
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => html,
    });

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    const models = await client.listModels("ignored");

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("qwen-max");
    expect(models[1].id).toBe("qwen-plus");
  });

  it("caches results after first call", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ models: [{ id: "qwen3-max" }] }),
    });

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    await client.listModels("ignored");
    await client.listModels("ignored");

    // fetcher called only once (cached)
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

// ── chatCompletions non-stream empty detection ──────────────────────────

describe("chatCompletions non-stream empty detection", () => {
  it("empty SSE (only [DONE]) → EmptyCompletionError", async () => {
    const fetcher = vi
      .fn()
      // createChatSession
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "sid-empty" } }),
      })
      // chat completions stream (empty — only [DONE])
      .mockResolvedValueOnce(makeSseResponse("empty-done-only.txt"));

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    await expect(
      client.chatCompletions("ignored", {
        model: "qwen3-max",
        messages: [{ role: "user", content: "hi" }],
      } as any),
    ).rejects.toThrow(EmptyCompletionError);
  });

  it("reasoning-only SSE → success (empty content, non-empty reasoning_content)", async () => {
    const fetcher = vi
      .fn()
      // createChatSession
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: "sid-reasoning" } }),
      })
      // chat completions stream (reasoning only)
      .mockResolvedValueOnce(makeSseResponse("reasoning-only.txt"));

    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      fetcher: fetcher as unknown as typeof fetch,
      log: noopLog,
    });

    const result = await client.chatCompletions("ignored", {
      model: "qwen3-max",
      messages: [{ role: "user", content: "hi" }],
    } as any) as OpenAiChatCompletion;

    expect(result.choices[0].message.content).toBe("");
    expect(result.choices[0].message.reasoning_content).toBe("Let me think...");
  });
});

// ── deleteChats ───────────────────────────────────────────────────────

describe("deleteChats", () => {
  it("is a no-op (returns void)", async () => {
    const client = new GuestUpstreamClient({
      baxia: makeBaxia(),
      chatUrl: "https://chat.qwen.ai",
      log: noopLog,
    });

    const result = await client.deleteChats("ignored");
    expect(result).toBeUndefined();
  });
});

// ── Structural typing (R-M3-3) ────────────────────────────────────────

describe("structural typing", () => {
  it("GuestUpstreamClient satisfies Pick<UpstreamClient, 'chatCompletions'|'listModels'|'deleteChats'>", () => {
    // Compile-time assertion: if this file typechecks, the contract holds
    type AdapterClient = Pick<UpstreamClient, "chatCompletions" | "listModels" | "deleteChats">;
    const _ok: AdapterClient = new GuestUpstreamClient({
      baxia: {} as any,
      chatUrl: "x",
      log: noopLog,
    });
    // Runtime: just verify methods exist
    expect(typeof _ok.chatCompletions).toBe("function");
    expect(typeof _ok.listModels).toBe("function");
    expect(typeof _ok.deleteChats).toBe("function");
  });
});
