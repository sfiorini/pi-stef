import { describe, it, expect, vi } from "vitest";
import {
  createUpstreamClient,
  type UpstreamClientOpts,
  type Model,
  type QwenChunk,
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

/** A non-JWT token (no dots) → decodeExpiryMs returns null */
const NON_JWT_TOKEN = "simple-opaque-token-abc123";

/** A real-looking JWT with exp=9999999999 (far future) */
const MOCK_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature";

function mockCookies() {
  return { ssxmod_itna: "cookie1", ssxmod_itna2: "cookie2" };
}

function opts(fetcher: typeof fetch): UpstreamClientOpts {
  return {
    authUrl: "https://auth.example.com",
    apiUrl: "https://api.example.com",
    cookies: mockCookies,
    fetcher,
    timeoutMs: 5000,
  };
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({ "content-type": "application/json", ...extraHeaders });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    body: null,
  } as unknown as Response;
}

function textResponse(body: string, status: number, extraHeaders?: Record<string, string>): Response {
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

/**
 * Build a streaming SSE response with a ReadableStream body.
 */
function sseResponse(chunks: string[], status = 200, extraHeaders?: Record<string, string>): Response {
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
  const headers = new Headers({ "content-type": "text/event-stream", ...extraHeaders });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: () => {
      // Return all chunks concatenated (used for error classification if status is bad)
      return Promise.resolve(chunks.join(""));
    },
    json: () => Promise.reject(new Error("streaming response")),
    body,
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createUpstreamClient", () => {
  // ── login ────────────────────────────────────────────────────────────────

  describe("login", () => {
    it("POSTs to {authUrl}/api/v1/auths/signin with SHA-256 hashed password and returns {bearer, expiresAt}", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse({ token: MOCK_JWT }),
      );
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.login("user@example.com", "plaintext");

      expect(fetcher).toHaveBeenCalledOnce();
      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://auth.example.com/api/v1/auths/signin");
      expect(init.method).toBe("POST");

      // Body must contain SHA-256 of "plaintext"
      const body = JSON.parse(init.body as string);
      expect(body.email).toBe("user@example.com");
      // SHA-256 of "plaintext"
      const { createHash } = await import("node:crypto");
      const expectedHash = createHash("sha256").update("plaintext", "utf8").digest("hex");
      expect(body.password).toBe(expectedHash);
      expect(body.password).not.toBe("plaintext");

      // Result has the bearer and decoded expiry
      expect(result.bearer).toBe(MOCK_JWT);
      expect(result.expiresAt).toBe(9999999999 * 1000); // s → ms
    });

    it("returns expiresAt=null for a non-JWT token", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse({ token: NON_JWT_TOKEN }),
      );
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.login("user@example.com", "pass");

      expect(result.bearer).toBe(NON_JWT_TOKEN);
      expect(result.expiresAt).toBeNull();
    });

    it("does NOT send Authorization: Bearer header (login is acquiring the token)", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse({ token: MOCK_JWT }),
      );
      const client = createUpstreamClient(opts(fetcher));

      await client.login("user@example.com", "pass");

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["authorization"]).toBeUndefined();
    });
  });

  // ── listModels ──────────────────────────────────────────────────────────

  describe("listModels", () => {
    it("GETs {apiUrl}/api/models with bearer + cookies and returns Model[]", async () => {
      const models: Model[] = [
        { id: "qwen-max", object: "model", owned_by: "qwen" },
        { id: "qwen-turbo", object: "model", owned_by: "qwen" },
      ];
      // Real upstream returns {object:"list", data:[...]} envelope
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "list", data: models }));
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.listModels("my-bearer");

      // Must unwrap the envelope and return the array
      expect(result).toEqual(models);
      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/api/models");
      expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-bearer");
      expect((init.headers as Record<string, string>)["Cookie"]).toContain("ssxmod_itna=cookie1");
      expect((init.headers as Record<string, string>)["Cookie"]).toContain("ssxmod_itna2=cookie2");
    });
  });

  // ── createChat ──────────────────────────────────────────────────────────

  describe("createChat", () => {
    it("POSTs {apiUrl}/api/v2/chats/new with bearer and returns {chatId}", async () => {
      // Real upstream returns {data:{id:"<chat_id>"}} envelope
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse({ data: { id: "chat-abc123" } }),
      );
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.createChat("my-bearer", {
        model: "qwen-max",
        title: "Test Chat",
      });

      // Must unwrap data.id into chatId
      expect(result).toEqual({ chatId: "chat-abc123" });
      const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/api/v2/chats/new");
      expect(init.method).toBe("POST");
    });
  });

  // ── chatCompletionsStream ───────────────────────────────────────────────

  describe("chatCompletionsStream", () => {
    it("yields parsed QwenChunk objects from SSE stream and terminates on [DONE]", async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const fetcher = vi.fn().mockResolvedValue(sseResponse(sseChunks));
      const client = createUpstreamClient(opts(fetcher));

      const chunks: QwenChunk[] = [];
      for await (const chunk of client.chatCompletionsStream("my-bearer", {
        chatId: "chat-1",
        model: "qwen-max",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      // We should get 3 chunks: the two content chunks + final {done:true}
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      // The last chunk should be the {done:true} sentinel
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.done).toBe(true);

      // Check that the fetcher was called with the right URL
      const [url] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/api/v2/chat/completions?chat_id=chat-1");
    });

    it("includes chat_id in the POST body as well as the URL (F4)", async () => {
      const sseChunks = ['data: [DONE]\n\n'];
      const fetcher = vi.fn().mockResolvedValue(sseResponse(sseChunks));
      const client = createUpstreamClient(opts(fetcher));

      // Consume the stream
      for await (const _ of client.chatCompletionsStream("my-bearer", {
        chatId: "chat-xyz",
        model: "qwen-max",
        messages: [{ role: "user", content: "hi" }],
      })) {
        // drain
      }

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.chat_id).toBe("chat-xyz");
    });

    it("reads finish_reason at choice level (F5) — final chunk has choices[0].finish_reason", async () => {
      // Upstream final chunk: finish_reason at choice level, not inside delta
      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const fetcher = vi.fn().mockResolvedValue(sseResponse(sseChunks));
      const client = createUpstreamClient(opts(fetcher));

      const chunks: QwenChunk[] = [];
      for await (const chunk of client.chatCompletionsStream("my-bearer", {
        chatId: "chat-f5",
        model: "qwen-max",
        messages: [{ role: "user", content: "hi" }],
      })) {
        chunks.push(chunk);
      }

      // The second chunk (before [DONE]) should have finishReason: "stop"
      const stopChunk = chunks.find((c) => c.finishReason === "stop");
      expect(stopChunk).toBeDefined();
      expect(stopChunk!.finishReason).toBe("stop");
    });
  });

  // ── imageGeneration ─────────────────────────────────────────────────────

  describe("imageGeneration", () => {
    it("POSTs {apiUrl}/v1/images/generations and returns {created, urls}", async () => {
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
    it("POSTs {apiUrl}/v1/images/edits and returns {created, urls}", async () => {
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

  // ── videoGeneration ─────────────────────────────────────────────────────

  describe("videoGeneration", () => {
    it("POSTs {apiUrl}/v1/videos/generations and returns {taskId, status, raw}", async () => {
      const apiResult = { task_id: "vid-123", task_status: "pending" };
      const fetcher = vi.fn().mockResolvedValue(jsonResponse(apiResult));
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.videoGeneration("my-bearer", {
        prompt: "a dancing cat",
      });

      expect(result.taskId).toBe("vid-123");
      expect(result.status).toBe("pending");
      expect(result.raw).toEqual(apiResult);
      const [url] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/v1/videos/generations");
    });
  });

  // ── videoTaskStatus ─────────────────────────────────────────────────────

  describe("videoTaskStatus", () => {
    it("GETs {apiUrl}/api/v1/tasks/status/{taskId} and returns {taskId, status, raw}", async () => {
      const apiResult = { task_id: "vid-123", task_status: "completed", video_url: "https://vid.example.com/out.mp4" };
      const fetcher = vi.fn().mockResolvedValue(jsonResponse(apiResult));
      const client = createUpstreamClient(opts(fetcher));

      const result = await client.videoTaskStatus("my-bearer", "vid-123");

      expect(result.taskId).toBe("vid-123");
      expect(result.status).toBe("completed");
      expect(result.raw).toEqual(apiResult);
      const [url] = fetcher.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.example.com/api/v1/tasks/status/vid-123");
    });
  });

  // ── Cookie and Bearer assertions (non-login methods) ─────────────────────

  describe("headers on non-login methods", () => {
    it("sends Authorization: Bearer + both ssxmod cookies + User-Agent on every non-login call", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({}));
      const client = createUpstreamClient(opts(fetcher));

      await client.listModels("tok");

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const h = init.headers as Record<string, string>;
      expect(h["Authorization"]).toBe("Bearer tok");
      expect(h["Cookie"]).toBe("ssxmod_itna=cookie1; ssxmod_itna2=cookie2");
      expect(h["User-Agent"]).toBeDefined();
    });

    it("does NOT send Authorization on login", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ token: NON_JWT_TOKEN }));
      const client = createUpstreamClient(opts(fetcher));

      await client.login("a@b.com", "pw");

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const h = init.headers as Record<string, string>;
      expect(h["Authorization"]).toBeUndefined();
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
      await expect(client.listModels("tok")).rejects.toSatisfy((e: unknown) => (e as RateLimitError).retryable === true);
    });

    it("401 → AuthExpiredError (retryable)", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        textResponse("unauthorized", 401),
      );
      const client = createUpstreamClient(opts(fetcher));

      await expect(client.listModels("tok")).rejects.toBeInstanceOf(AuthExpiredError);
      await expect(client.listModels("tok")).rejects.toSatisfy((e: unknown) => (e as AuthExpiredError).retryable === true);
    });

    it("500 → ServerError (retryable)", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        textResponse("internal error", 500),
      );
      const client = createUpstreamClient(opts(fetcher));

      await expect(client.listModels("tok")).rejects.toBeInstanceOf(ServerError);
      await expect(client.listModels("tok")).rejects.toSatisfy((e: unknown) => (e as ServerError).retryable === true);
    });

    it("400 → ClientError (NOT retryable)", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        textResponse("bad request", 400),
      );
      const client = createUpstreamClient(opts(fetcher));

      await expect(client.listModels("tok")).rejects.toBeInstanceOf(ClientError);
      await expect(client.listModels("tok")).rejects.toSatisfy((e: unknown) => (e as ClientError).retryable === false);
    });

    it("fetch throws → NetworkError (retryable)", async () => {
      const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const client = createUpstreamClient(opts(fetcher));

      await expect(client.listModels("tok")).rejects.toBeInstanceOf(NetworkError);
      await expect(client.listModels("tok")).rejects.toSatisfy((e: unknown) => (e as NetworkError).retryable === true);
    });

    it("unknown status (418) → UnknownError (NOT retryable)", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        textResponse("teapot", 418),
      );
      const client = createUpstreamClient(opts(fetcher));

      await expect(client.listModels("tok")).rejects.toBeInstanceOf(UnknownError);
      await expect(client.listModels("tok")).rejects.toSatisfy((e: unknown) => (e as UnknownError).retryable === false);
    });

    it("login 401 → AuthExpiredError", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        textResponse("unauthorized", 401),
      );
      const client = createUpstreamClient(opts(fetcher));

      await expect(client.login("a@b.com", "pw")).rejects.toBeInstanceOf(AuthExpiredError);
    });

    it("login fetch throw → NetworkError", async () => {
      const fetcher = vi.fn().mockRejectedValue(new TypeError("network down"));
      const client = createUpstreamClient(opts(fetcher));

      await expect(client.login("a@b.com", "pw")).rejects.toBeInstanceOf(NetworkError);
    });

    it("chatCompletionsStream non-2xx → throws classified error before yielding", async () => {
      const fetcher = vi.fn().mockResolvedValue(
        textResponse("unauthorized", 401),
      );
      const client = createUpstreamClient(opts(fetcher));

      const iter = client.chatCompletionsStream("tok", {
        chatId: "c1",
        model: "qwen-max",
        messages: [{ role: "user", content: "hi" }],
      });

      await expect(iter[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(AuthExpiredError);
    });
  });

  // ── User-Agent default ──────────────────────────────────────────────────

  describe("User-Agent", () => {
    it("uses a default Edge/Chrome UA when none provided", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse([]));
      const client = createUpstreamClient({
        authUrl: "https://auth.example.com",
        apiUrl: "https://api.example.com",
        cookies: mockCookies,
        fetcher,
      });

      await client.listModels("tok");

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      const ua = (init.headers as Record<string, string>)["User-Agent"];
      expect(ua).toContain("Edg/");
      expect(ua).toContain("Chrome/");
    });

    it("uses custom User-Agent when provided", async () => {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse([]));
      const client = createUpstreamClient({
        authUrl: "https://auth.example.com",
        apiUrl: "https://api.example.com",
        cookies: mockCookies,
        fetcher,
        userAgent: "CustomAgent/1.0",
      });

      await client.listModels("tok");

      const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)["User-Agent"]).toBe("CustomAgent/1.0");
    });
  });
});
