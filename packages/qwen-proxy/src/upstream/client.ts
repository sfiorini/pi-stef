/**
 * Typed upstream Qwen client.
 * Factory `createUpstreamClient(opts)` returns 8 methods covering login,
 * models, chat, image, and video endpoints.
 */

import { createHash } from "node:crypto";
import type { CookiePair } from "./ssxmod";
import { decodeExpiryMs } from "./auth";
import { classifyResponse, NetworkError, UnknownError } from "./errors";
import { parseSseStream } from "./sse";

// ── Public types ────────────────────────────────────────────────────────────

export interface UpstreamClientOpts {
  authUrl: string;
  apiUrl: string;
  cookies: () => CookiePair;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export interface LoginResult {
  bearer: string;
  expiresAt: number | null;
}

export interface Model {
  id: string;
  object: "model";
  owned_by: string;
}

export interface ChatCreated {
  chatId: string;
}

export interface ImageResult {
  created: number;
  urls: string[];
}

export interface VideoTask {
  taskId: string;
  status: string;
  raw: unknown;
}

export interface QwenChunk {
  phase?: "think" | "answer";
  content?: string;
  name?: string;
  extra?: Record<string, unknown>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  finishReason?: string;
  done?: boolean;
}

export interface UpstreamClient {
  login(email: string, password: string): Promise<LoginResult>;
  listModels(bearer: string): Promise<Model[]>;
  createChat(
    bearer: string,
    body: { model: string; title?: string; chatType?: string },
  ): Promise<ChatCreated>;
  chatCompletionsStream(
    bearer: string,
    body: {
      chatId: string;
      model: string;
      messages: { role: string; content: string }[];
      featureConfig?: Record<string, unknown>;
    },
  ): AsyncIterable<QwenChunk>;
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
    body: { prompt: string; image?: string },
  ): Promise<VideoTask>;
  videoTaskStatus(bearer: string, taskId: string): Promise<VideoTask>;
}

// ── Default UA (Edge/Chrome on Windows) ─────────────────────────────────────

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildCookieHeader(pair: CookiePair): string {
  return `ssxmod_itna=${pair.ssxmod_itna}; ssxmod_itna2=${pair.ssxmod_itna2}`;
}

function commonHeaders(
  bearer: string,
  cookieHeader: string,
  ua: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    Cookie: cookieHeader,
    "User-Agent": ua,
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
    const cookieHeader = buildCookieHeader(opts.cookies());
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/api/models`,
      {
        method: "GET",
        headers: commonHeaders(bearer, cookieHeader, ua),
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

  // ── createChat ─────────────────────────────────────────────────────────

  async function createChat(
    bearer: string,
    body: { model: string; title?: string; chatType?: string },
  ): Promise<ChatCreated> {
    const cookieHeader = buildCookieHeader(opts.cookies());
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/api/v2/chats/new`,
      {
        method: "POST",
        headers: {
          ...commonHeaders(bearer, cookieHeader, ua),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: body.title ?? "",
          models: [body.model],
          chat_mode: "local",
          chat_type: body.chatType ?? "t2t",
          timestamp: Date.now(),
        }),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    const json = (await res.json()) as { data?: { id?: string } };
    const chatId = json.data?.id;
    if (!chatId) {
      // Upstream returned 200 but an unexpected body — surface it instead of a
      // cryptic TypeError so the failure is diagnosable (mapped to 500 + logged).
      throw new UnknownError(
        `upstream /api/v2/chats/new returned ${res.status} with unexpected body (missing data.id): ${JSON.stringify(json).slice(0, 200)}`,
      );
    }
    return { chatId };
  }

  // ── chatCompletionsStream ──────────────────────────────────────────────

  async function* chatCompletionsStream(
    bearer: string,
    body: {
      chatId: string;
      model: string;
      messages: { role: string; content: string }[];
      featureConfig?: Record<string, unknown>;
    },
  ): AsyncIterable<QwenChunk> {
    const cookieHeader = buildCookieHeader(opts.cookies());
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/api/v2/chat/completions?chat_id=${encodeURIComponent(body.chatId)}`,
      {
        method: "POST",
        headers: {
          ...commonHeaders(bearer, cookieHeader, ua),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: body.chatId,
          stream: true,
          model: body.model,
          messages: body.messages,
          ...(body.featureConfig ? { feature_config: body.featureConfig } : {}),
        }),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    if (!res.body) {
      throw new NetworkError("Response body is null (no stream)");
    }

    for await (const sseEvent of parseSseStream(res.body)) {
      if (sseEvent.data === "[DONE]") {
        yield { done: true };
        return;
      }

      try {
        const parsed = JSON.parse(sseEvent.data);
        const chunk: QwenChunk = {};

        // Extract from choices[0].delta (typical streaming shape)
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          if (delta.phase) chunk.phase = delta.phase;
          if (delta.content) chunk.content = delta.content;
          if (delta.name) chunk.name = delta.name;
          if (delta.extra) chunk.extra = delta.extra;
        }
        // finish_reason: check choice level first, delta fallback
        if (choice?.finish_reason != null) {
          chunk.finishReason = choice.finish_reason;
        } else if (delta?.finish_reason) {
          chunk.finishReason = delta.finish_reason;
        }

        // Top-level usage
        if (parsed.usage) {
          chunk.usage = parsed.usage;
        }

        // Top-level extra/name (some upstream variants)
        if (!chunk.extra && parsed.extra) chunk.extra = parsed.extra;
        if (!chunk.name && parsed.name) chunk.name = parsed.name;

        yield chunk;
      } catch {
        // Skip non-JSON data lines (shouldn't happen but don't crash)
      }
    }

    // If we exit the loop without [DONE], yield done anyway
    yield { done: true };
  }

  // ── imageGeneration ────────────────────────────────────────────────────

  async function imageGeneration(
    bearer: string,
    body: { prompt: string; size?: string },
  ): Promise<ImageResult> {
    const cookieHeader = buildCookieHeader(opts.cookies());
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/images/generations`,
      {
        method: "POST",
        headers: {
          ...commonHeaders(bearer, cookieHeader, ua),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: body.prompt,
          ...(body.size ? { size: body.size } : {}),
        }),
      },
      timeoutMs,
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
    const cookieHeader = buildCookieHeader(opts.cookies());
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/images/edits`,
      {
        method: "POST",
        headers: {
          ...commonHeaders(bearer, cookieHeader, ua),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: body.image,
          prompt: body.prompt,
        }),
      },
      timeoutMs,
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

  // ── videoGeneration ────────────────────────────────────────────────────

  async function videoGeneration(
    bearer: string,
    body: { prompt: string; image?: string },
  ): Promise<VideoTask> {
    const cookieHeader = buildCookieHeader(opts.cookies());
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/v1/videos/generations`,
      {
        method: "POST",
        headers: {
          ...commonHeaders(bearer, cookieHeader, ua),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_type: "t2v",
          stream: false,
          prompt: body.prompt,
          ...(body.image ? { image: body.image } : {}),
        }),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    const raw = await res.json();
    const data = raw as { task_id?: string; task_status?: string };
    return {
      taskId: data.task_id ?? "",
      status: data.task_status ?? "unknown",
      raw,
    };
  }

  // ── videoTaskStatus ────────────────────────────────────────────────────

  async function videoTaskStatus(
    bearer: string,
    taskId: string,
  ): Promise<VideoTask> {
    const cookieHeader = buildCookieHeader(opts.cookies());
    const res = await timedFetch(
      _fetch,
      `${opts.apiUrl}/api/v1/tasks/status/${encodeURIComponent(taskId)}`,
      {
        method: "GET",
        headers: commonHeaders(bearer, cookieHeader, ua),
      },
      timeoutMs,
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw classifyResponse(res.status, bodyText, res.headers);
    }

    const raw = await res.json();
    const data = raw as { task_id?: string; task_status?: string };
    return {
      taskId: data.task_id ?? taskId,
      status: data.task_status ?? "unknown",
      raw,
    };
  }

  // ── Return the client ──────────────────────────────────────────────────

  return {
    login,
    listModels,
    createChat,
    chatCompletionsStream,
    imageGeneration,
    imageEdit,
    videoGeneration,
    videoTaskStatus,
  };
}
