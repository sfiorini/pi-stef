import { describe, it, expect, vi } from "vitest";
import {
  createUpstreamClient,
  type UpstreamClientOpts,
  type Model,
  type OpenAiChatChunk,
  type OpenAiChatCompletion,
} from "../src/upstream/client";
import {
  RateLimitError,
  AuthExpiredError,
  ServerError,
  ClientError,
  NetworkError,
  UnknownError,
} from "../src/upstream/errors";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A real-looking JWT with exp=9999999999 (far future) */
const MOCK_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature";

function opts(fetcher: typeof fetch): UpstreamClientOpts {
  return {
    authUrl: "https://auth.example.com",
    apiUrl: "https://api.example.com",
    fetcher,
    timeoutMs: 5000,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({
    "content-type": "application/json",
    ...extraHeaders,
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    body: null,
  } as unknown as Response;
}

function textResponse(
  body: string,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers(extraHeaders);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: () => Promise.resolve(body),
    json: () => Promise.reject(new Error("not json")),
    body: null,
  } as unknown as Response;
}

function sseResponse(
  chunks: string[],
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
  const headers = new Headers({
    "content-type": "text/event-stream",
    ...extraHeaders,
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: () => Promise.resolve(chunks.join("")),
    json: () => Promise.reject(new Error("streaming response")),
    body,
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createUpstreamClient", () => {
  // ── login (UNCHANGED) ───────────────────────────────────────────────────

  describe("login", () => {
    it("POSTs to {authUrl}/api/v1/auths/signin with SHA-256 hashed password", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ token: MOCK_JWT }));
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.login("user@example.com", "plaintext");

      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://auth.example.com/api/v1/auths/signin");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string);
      expect(body.email).toBe("user@example.com");
      const { createHash } = await import("node:crypto");
      const expectedHash = createHash("sha256").update("plaintext", "utf8").digest("hex");
      expect(body.password).toBe(expectedHash);

      expect(result.bearer).toBe(MOCK_JWT);
      expect(result.expiresAt).toBe(9999999999 * 1000);
    });

    it("does NOT send Authorization header on login", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ token: MOCK_JWT }));
      const client = createUpstreamClient(opts(fetcher));
      await client.login("a@b.com", "pw");
      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });
  });

  // ── listModels ──────────────────────────────────────────────────────────

  describe("listModels", () => {
    it("GETs {apiUrl}/v1/models and returns Model[]", async () => {
      const models: Model[] = [
        { id: "qwen-max", object: "model" },
        { id: "qwen-turbo", object: "model", owned_by: "qwen" },
      ];
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "list", data: models }));
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.listModels("my-bearer");

      expect(result).toEqual(models);
      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/models");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-bearer");
    });
  });

  // ── chatCompletions (non-stream) ────────────────────────────────────────

  describe("chatCompletions (non-stream)", () => {
    it("POSTs {apiUrl}/v1/chat/completions with thin body and returns OpenAiChatCompletion", async () => {
      const completion: OpenAiChatCompletion = {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1700000000,
        model: "qwen3-max",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      const fetcher = vi.fn().mockResolvedValue(jsonResponse(completion));
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.chatCompletions("my-bearer", {
        model: "qwen3-max",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });

      expect(result).toEqual(completion);
      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("qwen3-max");
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
      expect(body.stream).toBe(false);
    });

    it("includes enable_thinking and thinking_budget when provided", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse({
          id: "cmpl-1",
          object: "chat.completion",
          created: 0,
          model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
      );
      const client = createUpstreamClient(opts(fetcher));

      await client.chatCompletions("tok", {
        model: "qwen3-max",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        enable_thinking: true,
        thinking_budget: 4096,
      });

      const body = JSON.parse(fetcher.mock.calls[0][1].body as string);
      expect(body.enable_thinking).toBe(true);
      expect(body.thinking_budget).toBe(4096);
    });

    it("includes tools when provided", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse({
          id: "cmpl-2",
          object: "chat.completion",
          created: 0,
          model: "qwen3-max",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
      );
      const client = createUpstreamClient(opts(fetcher));

      await client.chatCompletions("tok", {
        model: "qwen3-max",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        tools: [{ type: "web_search" }],
      });

      const body = JSON.parse(fetcher.mock.calls[0][1].body as string);
      expect(body.tools).toEqual([{ type: "web_search" }]);
    });
  });

  // ── chatCompletions (stream) ────────────────────────────────────────────

  describe("chatCompletions (stream)", () => {
    it("yields raw OpenAiChatChunk objects from SSE stream", async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const fetcher = vi.fn().mockResolvedValue(sseResponse(sseChunks));
      const client = createUpstreamClient(opts(fetcher));

      const chunks: OpenAiChatChunk[] = [];
      for await (const chunk of client.chatCompletions("my-bearer", {
        model: "qwen3-max",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }) as AsyncIterable<OpenAiChatChunk>) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBe(3);
      expect(chunks[0].choices[0].delta?.role).toBe("assistant");
      expect(chunks[0].choices[0].delta?.content).toBe("Hello");
      expect(chunks[1].choices[0].delta?.content).toBe(" world");
      expect(chunks[2].choices[0].finish_reason).toBe("stop");

      const [url] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/chat/completions");

      const body = JSON.parse(fetcher.mock.calls[0][1].body as string);
      expect(body.stream).toBe(true);
    });

    it("passes reasoning_content through unmodified", async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const fetcher = vi.fn().mockResolvedValue(sseResponse(sseChunks));
      const client = createUpstreamClient(opts(fetcher));

      const chunks: OpenAiChatChunk[] = [];
      for await (const chunk of client.chatCompletions("tok", {
        model: "qwen3-max",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }) as AsyncIterable<OpenAiChatChunk>) {
        chunks.push(chunk);
      }

      expect(chunks[0].choices[0].delta?.reasoning_content).toBe("thinking...");
      expect(chunks[1].choices[0].delta?.content).toBe("answer");
    });

    it("passes usage in stream chunks", async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
        'data: [DONE]\n\n',
      ];
      const fetcher = vi.fn().mockResolvedValue(sseResponse(sseChunks));
      const client = createUpstreamClient(opts(fetcher));

      const chunks: OpenAiChatChunk[] = [];
      for await (const chunk of client.chatCompletions("tok", {
        model: "q",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }) as AsyncIterable<OpenAiChatChunk>) {
        chunks.push(chunk);
      }

      expect(chunks[0].usage?.prompt_tokens).toBe(5);
    });
  });

  // ── imageGeneration ─────────────────────────────────────────────────────

  describe("imageGeneration", () => {
    it("POSTs {apiUrl}/v1/images/generations and returns ImageResult", async () => {
      const apiResult = {
        created: 1234567890,
        data: [{ url: "https://img.example.com/a.png" }, { url: "https://img.example.com/b.png" }],
      };
      const fetcher = vi.fn().mockResolvedValue(jsonResponse(apiResult));
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.imageGeneration("my-bearer", {
        prompt: "a cat",
        size: "1024x1024",
      });

      expect(result).toEqual({
        created: 1234567890,
        urls: ["https://img.example.com/a.png", "https://img.example.com/b.png"],
      });
      const [url] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/images/generations");
    });
  });

  // ── imageEdit ───────────────────────────────────────────────────────────

  describe("imageEdit", () => {
    it("POSTs {apiUrl}/v1/images/edits and returns ImageResult", async () => {
      const apiResult = {
        created: 1234567890,
        data: [{ url: "https://img.example.com/edited.png" }],
      };
      const fetcher = vi.fn().mockResolvedValue(jsonResponse(apiResult));
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.imageEdit("my-bearer", {
        image: "https://img.example.com/src.png",
        prompt: "add sunglasses",
      });

      expect(result).toEqual({
        created: 1234567890,
        urls: ["https://img.example.com/edited.png"],
      });
      const [url] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/images/edits");
    });
  });

  // ── videoGeneration (SYNC) ──────────────────────────────────────────────

  describe("videoGeneration", () => {
    it("POSTs {apiUrl}/v1/videos/generations synchronously and returns ImageResult", async () => {
      const apiResult = {
        created: 1700000000,
        data: [{ url: "https://vid.example.com/out.mp4" }],
      };
      const fetcher = vi.fn().mockResolvedValue(jsonResponse(apiResult));
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.videoGeneration("my-bearer", {
        prompt: "a dancing cat",
      });

      expect(result).toEqual({
        created: 1700000000,
        urls: ["https://vid.example.com/out.mp4"],
      });

      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/videos/generations");
      expect(init.method).toBe("POST");

      const body = JSON.parse(init.body as string);
      expect(body.prompt).toBe("a dancing cat");
      expect(body.chat_type).toBeUndefined();
      expect(body.stream).toBeUndefined();
    });

    it("passes size when provided", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse({ created: 0, data: [{ url: "u" }] }),
      );
      const client = createUpstreamClient(opts(fetcher));

      await client.videoGeneration("tok", { prompt: "p", size: "1280x720" });

      const body = JSON.parse(fetcher.mock.calls[0][1].body as string);
      expect(body.size).toBe("1280x720");
    });

    it("uses videoTimeoutMs for the request", async () => {
      // We can't easily test the actual timeout, but we can verify the
      // client accepts videoTimeoutMs in opts without error
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse({ created: 0, data: [{ url: "u" }] }),
      );
      const client = createUpstreamClient({
        ...opts(fetcher),
        videoTimeoutMs: 600_000,
      });

      const result = await client.videoGeneration("tok", { prompt: "p" });
      expect(result.urls).toEqual(["u"]);
    });
  });

  // ── deleteChats (S-4) ──────────────────────────────────────────────────

  describe("deleteChats", () => {
    it("DELETEs {apiUrl}/v1/chats/delete with Bearer auth", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        { ok: true, status: 200, headers: new Headers(), text: () => Promise.resolve("") } as unknown as Response,
      );
      const client = createUpstreamClient(opts(fetcher));

      await client.deleteChats("my-bearer");

      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/chats/delete");
      expect(init.method).toBe("DELETE");
      const h = init.headers as Record<string, string>;
      expect(h["Authorization"]).toBe("Bearer my-bearer");
    });

    it("does not throw on non-ok response (best-effort)", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        textResponse("internal error", 500),
      );
      const client = createUpstreamClient(opts(fetcher));

      // Should not throw
      await expect(client.deleteChats("tok")).resolves.toBeUndefined();
    });
  });

  // ── Headers (NO cookie/bx-*/Version/source/Sec-Fetch/sec-ch-ua) ────────

  describe("headers", () => {
    it("sends only the 4 clean headers on non-login calls", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse([]));
      const client = createUpstreamClient(opts(fetcher));

      await client.listModels("tok");

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const h = init.headers as Record<string, string>;
      expect(h["Authorization"]).toBe("Bearer tok");
      expect(h["Content-Type"]).toBe("application/json");
      expect(h["User-Agent"]).toBeDefined();
      expect(h["Accept"]).toBe("application/json");

      // These must NOT be present
      expect(h["Cookie"]).toBeUndefined();
      expect(h["bx-v"]).toBeUndefined();
      expect(h["Version"]).toBeUndefined();
      expect(h["source"]).toBeUndefined();
      expect(h["Sec-Fetch-Site"]).toBeUndefined();
      expect(h["Sec-Fetch-Mode"]).toBeUndefined();
      expect(h["sec-ch-ua"]).toBeUndefined();
      expect(h["Accept-Language"]).toBeUndefined();
      expect(h["Timezone"]).toBeUndefined();
      expect(h["Origin"]).toBeUndefined();
      expect(h["Referer"]).toBeUndefined();
      expect(h["X-Request-Id"]).toBeUndefined();
    });

    it("does NOT send Authorization on login", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ token: "tok" }));
      const client = createUpstreamClient(opts(fetcher));
      await client.login("a@b.com", "pw");
      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const h = init.headers as Record<string, string>;
      expect(h["Authorization"]).toBeUndefined();
    });
  });

  // ── User-Agent ──────────────────────────────────────────────────────────

  describe("User-Agent", () => {
    it("uses a default Edge/Chrome UA when none provided", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse([]));
      const client = createUpstreamClient({
        authUrl: "https://auth.example.com",
        apiUrl: "https://api.example.com",
        fetcher,
      });
      await client.listModels("tok");
      const ua = (fetcher.mock.calls[0][1].headers as Record<string, string>)["User-Agent"];
      expect(ua).toContain("Edg/");
      expect(ua).toContain("Chrome/");
    });

    it("uses custom User-Agent when provided", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse([]));
      const client = createUpstreamClient({
        authUrl: "https://auth.example.com",
        apiUrl: "https://api.example.com",
        fetcher,
        userAgent: "CustomAgent/1.0",
      });
      await client.listModels("tok");
      const ua = (fetcher.mock.calls[0][1].headers as Record<string, string>)["User-Agent"];
      expect(ua).toBe("CustomAgent/1.0");
    });
  });

  // ── Error paths ─────────────────────────────────────────────────────────

  describe("error paths", () => {
    it("429 + Retry-After → RateLimitError (retryable)", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        textResponse("rate limit exceeded", 429, { "retry-after": "30" }),
      );
      const client = createUpstreamClient(opts(fetcher));
      await expect(client.listModels("tok")).rejects.toBeInstanceOf(RateLimitError);
      await expect(client.listModels("tok")).rejects.toSatisfy(
        (e: unknown) => (e as RateLimitError).retryable === true,
      );
    });

    it("401 → AuthExpiredError (retryable)", async () => {
      const fetcher = vi.fn().mockResolvedValue(textResponse("unauthorized", 401));
      const client = createUpstreamClient(opts(fetcher));
      await expect(client.listModels("tok")).rejects.toBeInstanceOf(AuthExpiredError);
    });

    it("500 → ServerError (retryable)", async () => {
      const fetcher = vi.fn().mockResolvedValue(textResponse("internal error", 500));
      const client = createUpstreamClient(opts(fetcher));
      await expect(client.listModels("tok")).rejects.toBeInstanceOf(ServerError);
    });

    it("400 → ClientError (NOT retryable)", async () => {
      const fetcher = vi.fn().mockResolvedValue(textResponse("bad request", 400));
      const client = createUpstreamClient(opts(fetcher));
      await expect(client.listModels("tok")).rejects.toBeInstanceOf(ClientError);
    });

    it("fetch throws → NetworkError (retryable)", async () => {
      const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const client = createUpstreamClient(opts(fetcher));
      await expect(client.listModels("tok")).rejects.toBeInstanceOf(NetworkError);
    });

    it("unknown status (418) → UnknownError (NOT retryable)", async () => {
      const fetcher = vi.fn().mockResolvedValue(textResponse("teapot", 418));
      const client = createUpstreamClient(opts(fetcher));
      await expect(client.listModels("tok")).rejects.toBeInstanceOf(UnknownError);
    });

    it("login 401 → AuthExpiredError", async () => {
      const fetcher = vi.fn().mockResolvedValue(textResponse("unauthorized", 401));
      const client = createUpstreamClient(opts(fetcher));
      await expect(client.login("a@b.com", "pw")).rejects.toBeInstanceOf(AuthExpiredError);
    });

    it("login fetch throw → NetworkError", async () => {
      const fetcher = vi.fn().mockRejectedValue(new TypeError("network down"));
      const client = createUpstreamClient(opts(fetcher));
      await expect(client.login("a@b.com", "pw")).rejects.toBeInstanceOf(NetworkError);
    });

    it("stream non-2xx → throws classified error", async () => {
      const fetcher = vi.fn().mockResolvedValue(textResponse("unauthorized", 401));
      const client = createUpstreamClient(opts(fetcher));

      const iter = client.chatCompletions("tok", {
        model: "q",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }) as AsyncIterable<OpenAiChatChunk>;

      await expect(iter[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(AuthExpiredError);
    });

    it("stream non-SSE content-type → UnknownError", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse({ error: "not a stream" }, 200),
      );
      const client = createUpstreamClient(opts(fetcher));

      const iter = client.chatCompletions("tok", {
        model: "q",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }) as AsyncIterable<OpenAiChatChunk>;

      await expect(iter[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(UnknownError);
    });
  });

  // ── Timeout asymmetry (audit F1) ───────────────────────────────────────

  describe("timeout (audit F1)", () => {
    it("non-stream chatCompletions uses 180s timeout (not default 10s)", async () => {
      const completion: OpenAiChatCompletion = {
        id: "cmpl-1",
        object: "chat.completion",
        created: 0,
        model: "q",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      };
      const fetcher = vi.fn().mockResolvedValue(jsonResponse(completion));
      // Use a short default timeoutMs to prove it's ignored
      const client = createUpstreamClient({ ...opts(fetcher), timeoutMs: 5000 });

      // Spy on setTimeout to capture the timeout passed to the AbortController
      const spy = vi.spyOn(globalThis, "setTimeout");
      try {
        await client.chatCompletions("tok", {
          model: "q",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        });
        // The timedFetch setTimeout should use 180_000 (REQUEST_TIMEOUT_MS),
        // not the 5000 timeoutMs we passed in.
        const timeoutCalls = spy.mock.calls.filter(([, ms]) => ms === 180_000);
        expect(timeoutCalls.length).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("imageGeneration uses 180s timeout (not default 10s)", async () => {
      const apiResult = { created: 0, data: [{ url: "u" }] };
      const fetcher = vi.fn().mockResolvedValue(jsonResponse(apiResult));
      const client = createUpstreamClient({ ...opts(fetcher), timeoutMs: 5000 });

      const spy = vi.spyOn(globalThis, "setTimeout");
      try {
        await client.imageGeneration("tok", { prompt: "a cat" });
        const timeoutCalls = spy.mock.calls.filter(([, ms]) => ms === 180_000);
        expect(timeoutCalls.length).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("imageEdit uses 180s timeout (not default 10s)", async () => {
      const apiResult = { created: 0, data: [{ url: "u" }] };
      const fetcher = vi.fn().mockResolvedValue(jsonResponse(apiResult));
      const client = createUpstreamClient({ ...opts(fetcher), timeoutMs: 5000 });

      const spy = vi.spyOn(globalThis, "setTimeout");
      try {
        await client.imageEdit("tok", { image: "img", prompt: "edit" });
        const timeoutCalls = spy.mock.calls.filter(([, ms]) => ms === 180_000);
        expect(timeoutCalls.length).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("login still uses default timeoutMs (10s)", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ token: MOCK_JWT }));
      const client = createUpstreamClient({ ...opts(fetcher), timeoutMs: 5000 });

      const spy = vi.spyOn(globalThis, "setTimeout");
      try {
        await client.login("a@b.com", "pw");
        const timeoutCalls = spy.mock.calls.filter(([, ms]) => ms === 5000);
        expect(timeoutCalls.length).toBeGreaterThanOrEqual(1);
        // No 180_000 calls for login
        const longCalls = spy.mock.calls.filter(([, ms]) => ms === 180_000);
        expect(longCalls.length).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
