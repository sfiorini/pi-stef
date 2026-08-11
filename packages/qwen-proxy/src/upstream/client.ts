/**
 * Typed upstream Qwen client — thin OpenAI pass-through to qwen.aikit.club.
 * Factory `createUpstreamClient(opts)` returns 6 methods covering login,
 * models, chat completions, image, and video endpoints.
 *
 * All forward methods use the 4 clean headers (Authorization, Content-Type,
 * User-Agent, Accept). No Cookie, bx-*, Version, source, Sec-Fetch-*, etc.
 */

import { createHash } from "node:crypto";
import { decodeExpiryMs } from "./auth";
import { classifyResponse, NetworkError, UnknownError } from "./errors";
import { parseSseStream } from "./sse";
import type {
  OpenAiChatChunk,
  OpenAiChatCompletion,
  Model,
  ChatCompletionsBody,
} from "./types";
export type {
  OpenAiChatChunk,
  OpenAiChatCompletion,
  Model,
  ChatCompletionsBody,
} from "./types";

// ── Public types ────────────────────────────────────────────────────────────

export interface UpstreamClientOpts {
  authUrl: string;
  apiUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  videoTimeoutMs?: number;
  userAgent?: string;
}

export interface LoginResult {
  bearer: string;
  expiresAt: number | null;
}

export interface ImageResult {
  created: number;
  urls: string[];
}

export interface UpstreamClient {
  login(email: string, password: string): Promise<LoginResult>;
  listModels(bearer: string): Promise<Model[]>;
  chatCompletions(
    bearer: string,
    body: ChatCompletionsBody,
  ): Promise<OpenAiChatCompletion> | AsyncIterable<OpenAiChatChunk>;
  imageGeneration(
    bearer: string,
    body: { prompt: string; size?: string },
  ): Promise<ImageResult>;
  imageEdit(
    bearer: string,
    body: { image: string; prompt: string },
  ): Promise<ImageResult>;
  videoGeneration(
    bearer: string,
    body: { prompt: string; size?: string },
  ): Promise<ImageResult>;
  deleteChats(bearer: string): Promise<void>;
}

// ── Default UA (Edge/Chrome on Windows) ─────────────────────────────────────

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";

// Generation endpoints (chat stream, chat non-stream, image) can run long
// (a thinking phase + the answer, or slow image rendering); the default
// login/listModels 10s timeout cuts them off → spurious NetworkError.
const REQUEST_TIMEOUT_MS = 180_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The 4 clean gateway headers. No Cookie, bx-*, Version, etc. */
function commonHeaders(
  bearer: string,
  ua: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    "User-Agent": ua,
    Accept: "application/json",
  };
}

/**
 * Perform a fetch with AbortController timeout.
 * On fetch throw / timeout, wraps in NetworkError.
 */
async function timedFetch(
  _fetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await _fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw new NetworkError(
      err instanceof Error ? err.message : "fetch failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createUpstreamClient(opts: UpstreamClientOpts): UpstreamClient {
  const _fetch = opts.fetcher ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const videoTimeoutMs = opts.videoTimeoutMs ?? 300_000;
  const ua = opts.userAgent ?? DEFAULT_UA;

  // ── login ──────────────────────────────────────────────────────────────

  async function login(
    email: string,
    password: string,
  ): Promise<LoginResult> {
    const hashedPassword = createHash("sha256")
      .update(password, "utf8")
      .digest("hex");

    const res = await timedFetch(
      _fetch,
      `${opts.authUrl}/api/v1/auths/signin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": ua,
        },
        body: JSON.stringify({ email, password: hashedPassword }),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    const data = (await res.json()) as { token: string };
    return {
      bearer: data.token,
      expiresAt: decodeExpiryMs(data.token),
    };
  }

  // ── listModels ─────────────────────────────────────────────────────────

  async function listModels(bearer: string): Promise<Model[]> {
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/models`,
      {
        method: "GET",
        headers: commonHeaders(bearer, ua),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    const json = (await res.json()) as { object: string; data: Model[] };
    return json.data;
  }

  // ── chatCompletions ────────────────────────────────────────────────────

  function chatCompletions(
    bearer: string,
    body: ChatCompletionsBody,
  ): Promise<OpenAiChatCompletion> | AsyncIterable<OpenAiChatChunk> {
    // Thin body — just the essential fields, no rich wrapping
    const thinBody: Record<string, unknown> = {
      model: body.model,
      messages: body.messages,
      stream: body.stream,
    };
    if (body.enable_thinking !== undefined) thinBody.enable_thinking = body.enable_thinking;
    if (body.thinking_budget !== undefined) thinBody.thinking_budget = body.thinking_budget;
    if (body.tools !== undefined) thinBody.tools = body.tools;
    if (body.tool_choice !== undefined) thinBody.tool_choice = body.tool_choice;

    if (body.stream) {
      return streamChatCompletion(bearer, thinBody);
    }
    return chatCompletionsNonStream(bearer, thinBody);
  }

  async function chatCompletionsNonStream(
    bearer: string,
    thinBody: Record<string, unknown>,
  ): Promise<OpenAiChatCompletion> {
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: commonHeaders(bearer, ua),
        body: JSON.stringify(thinBody),
      },
      REQUEST_TIMEOUT_MS,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    return (await res.json()) as OpenAiChatCompletion;
  }

  async function* streamChatCompletion(
    bearer: string,
    thinBody: Record<string, unknown>,
  ): AsyncIterable<OpenAiChatChunk> {
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: commonHeaders(bearer, ua),
        body: JSON.stringify(thinBody),
      },
      REQUEST_TIMEOUT_MS,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    // Non-SSE safety net: qwen.aikit.club sometimes returns text/html for valid
    // SSE streams. Accept text/event-stream, text/html, text/plain. Reject JSON (CAPTCHA/error).
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") && !contentType.includes("text/html") && !contentType.includes("text/plain")) {
      const text = await res.text();
      throw new UnknownError(
        `upstream /v1/chat/completions returned non-SSE (${contentType}, status ${res.status}): ${text.slice(0, 300)}`,
      );
    }

    if (!res.body) {
      throw new NetworkError("Response body is null (no stream)");
    }

    for await (const sseEvent of parseSseStream(res.body)) {
      if (sseEvent.data === "[DONE]") {
        return;
      }

      try {
        const parsed = JSON.parse(sseEvent.data) as OpenAiChatChunk;
        yield parsed;
      } catch {
        // Skip non-JSON data lines (shouldn't happen but don't crash)
      }
    }
  }

  // ── imageGeneration ────────────────────────────────────────────────────

  async function imageGeneration(
    bearer: string,
    body: { prompt: string; size?: string },
  ): Promise<ImageResult> {
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/images/generations`,
      {
        method: "POST",
        headers: commonHeaders(bearer, ua),
        body: JSON.stringify({
          prompt: body.prompt,
          ...(body.size ? { size: body.size } : {}),
        }),
      },
      REQUEST_TIMEOUT_MS,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    const data = (await res.json()) as {
      created: number;
      data: { url: string }[];
    };
    return {
      created: data.created,
      urls: data.data.map((d) => d.url),
    };
  }

  // ── imageEdit ──────────────────────────────────────────────────────────

  async function imageEdit(
    bearer: string,
    body: { image: string; prompt: string },
  ): Promise<ImageResult> {
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/images/edits`,
      {
        method: "POST",
        headers: commonHeaders(bearer, ua),
        body: JSON.stringify({
          image: body.image,
          prompt: body.prompt,
        }),
      },
      REQUEST_TIMEOUT_MS,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    const data = (await res.json()) as {
      created: number;
      data: { url: string }[];
    };
    return {
      created: data.created,
      urls: data.data.map((d) => d.url),
    };
  }

  // ── videoGeneration (SYNC) ─────────────────────────────────────────────

  async function videoGeneration(
    bearer: string,
    body: { prompt: string; size?: string },
  ): Promise<ImageResult> {
    const thinBody: Record<string, unknown> = { prompt: body.prompt };
    if (body.size) thinBody.size = body.size;

    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/videos/generations`,
      {
        method: "POST",
        headers: commonHeaders(bearer, ua),
        body: JSON.stringify(thinBody),
      },
      videoTimeoutMs,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    const data = (await res.json()) as {
      created: number;
      data: { url: string }[];
    };
    return {
      created: data.created,
      urls: data.data.map((d) => d.url),
    };
  }

  // ── deleteChats (S-4) ──────────────────────────────────────────────────

  async function deleteChats(bearer: string): Promise<void> {
    await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/chats/delete`,
      {
        method: "DELETE",
        headers: commonHeaders(bearer, ua),
      },
      timeoutMs,
    ).catch(() => {
      // best-effort: swallow all errors
    });
  }

  // ── Return the client ──────────────────────────────────────────────────

  return {
    login,
    listModels,
    chatCompletions,
    imageGeneration,
    imageEdit,
    videoGeneration,
    deleteChats,
  };
}
