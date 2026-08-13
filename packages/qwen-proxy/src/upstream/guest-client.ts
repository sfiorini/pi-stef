/**
 * Guest-mode upstream client for chat.qwen.ai.
 * Handles guest session creation, message normalization,
 * chatCompletions (stream + non-stream), listModels, and deleteChats.
 */

import { randomUUID } from "node:crypto";
import type { BaxiaTokenManager } from "./baxia-token";
import { ClientError, EmptyCompletionError } from "./errors";
import { translateQwenSse, isDataInspectionFailed } from "./qwen-sse";
import type {
  OpenAiChatChunk,
  OpenAiChatCompletion,
  ChatCompletionsBody,
  Model,
} from "./types";
import type { Logger } from "../server/logger";

// ── Config ────────────────────────────────────────────────────────────────

export interface GuestUpstreamClientConfig {
  baxia: BaxiaTokenManager;
  chatUrl: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
  /** Optional in-flight concurrency cap (async semaphore). Absent = unlimited.
   *  Baxia flags the IP on concurrent upstream connections, so bin wires a
   *  Semaphore(SF_QWEN_MAX_CONCURRENCY, default 1) to serialize — like the web
   *  chat (you can't send the next until the previous completes). */
  concurrency?: { acquire(): Promise<void>; release(): void };
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const RGV587_RE = /rgv.?587/i;

// ── GuestUpstreamClient ──────────────────────────────────────────────────

export class GuestUpstreamClient {
  private baxia: BaxiaTokenManager;
  private chatUrl: string;
  private _fetch: typeof fetch;
  private userAgent: string;
  private log: Logger;
  private _sleep: (ms: number) => Promise<void>;
  private modelsCache: Model[] | null = null;
  private concurrency?: { acquire(): Promise<void>; release(): void };

  constructor(config: GuestUpstreamClientConfig) {
    this.baxia = config.baxia;
    this.chatUrl = config.chatUrl;
    this._fetch = config.fetcher ?? globalThis.fetch;
    this.userAgent = config.userAgent ?? DEFAULT_UA;
    this.log = config.log;
    this._sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.concurrency = config.concurrency;
  }

  // ── createChatSession ──────────────────────────────────────────────────

  async createChatSession(model: string, chatType: "t2t" | "search"): Promise<string> {
    const referer = `${this.chatUrl}/c/guest`;

    const body = {
      title: "新建对话",
      models: [model],
      chat_mode: "guest",
      chat_type: chatType,
      timestamp: Date.now(),
      project_id: "",
    };

    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const tokens = await this.baxia.ensureToken(attempt > 0 ? { forceRefresh: true } : undefined);
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        "bx-ua": tokens.bxUa,
        "bx-umidtoken": tokens.bxUmidToken,
        "bx-v": tokens.bxV,
        Cookie: tokens.cookies,
        Origin: this.chatUrl,
        source: "web",
        version: "0.2.83",
        Referer: referer,
        "User-Agent": this.userAgent,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "x-request-id": randomUUID(),
      };

      const res = await this._fetch(`${this.chatUrl}/api/v2/chats/new`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const data = await res.json();

      // Check for rgv587 (Baxia captcha rejection)
      if (RGV587_RE.test(JSON.stringify(data))) {
        this.log.warn("createChatSession rgv587 detected, retrying", { attempt: attempt + 1 });
        if (attempt < maxRetries - 1) {
          await this._sleep(600);
          continue;
        }
        throw new Error("createChatSession rgv587 after 3 retries");
      }

      return (data as any).data.id;
    }

    throw new Error("createChatSession failed after max retries");
  }

  // ── normalizeMessages ──────────────────────────────────────────────────

  normalizeMessages(
    messages: { role: string; content: string }[],
    model: string,
    chatType: "t2t" | "search",
    enableThinking: boolean,
    autoSearch: boolean,
  ): any {
    // Merge messages into Qwen format:
    // - system → "[System]: content"
    // - prior user/assistant → "[Role]: content" joined with \n\n
    // - last message → plain content
    let mergedContent: string;
    const historyParts: string[] = [];

    for (let i = 0; i < messages.length - 1; i++) {
      const m = messages[i];
      if (m.role === "system") {
        historyParts.push(`[System]: ${m.content}`);
      } else {
        const label = m.role.charAt(0).toUpperCase() + m.role.slice(1);
        historyParts.push(`[${label}]: ${m.content}`);
      }
    }

    const lastMessage = messages[messages.length - 1];

    if (historyParts.length > 0) {
      mergedContent = historyParts.join("\n\n") + "\n\n" + lastMessage.content;
    } else {
      mergedContent = lastMessage.content;
    }

    return {
      id: null,
      fid: randomUUID(),
      parentId: null,
      parent_id: null,
      childrenIds: [randomUUID()],
      role: "user",
      content: mergedContent,
      user_action: "chat",
      files: [],
      timestamp: Date.now(),
      models: [model],
      model: "",
      chat_type: chatType,
      feature_config: {
        thinking_enabled: !!enableThinking,
        output_schema: "phase",
        research_mode: "normal",
        auto_thinking: true,
        thinking_mode: "Auto",
        thinking_format: "summary",
        auto_search: !!autoSearch,
      },
      extra: {
        meta: {
          subChatType: chatType,
        },
      },
      sub_chat_type: chatType,
    };
  }

  // ── chatCompletions ────────────────────────────────────────────────────

  chatCompletions(
    _bearer: string,
    body: ChatCompletionsBody,
  ): Promise<OpenAiChatCompletion> | AsyncIterable<OpenAiChatChunk> {
    if (body.stream) {
      return this.chatCompletionsStream(body);
    }
    return this.chatCompletionsNonStream(body);
  }

  private async *chatCompletionsStream(
    body: ChatCompletionsBody,
  ): AsyncGenerator<OpenAiChatChunk> {
    await this.concurrency?.acquire();
    try {
      const res = await this.doChatCompletionsRequest(body);
      if (!res.body) {
        throw new Error("Response body is null (no stream)");
      }
      yield* translateQwenSse(res.body);
    } finally {
      this.concurrency?.release();
    }
  }

  private async chatCompletionsNonStream(
    body: ChatCompletionsBody,
  ): Promise<OpenAiChatCompletion> {
    await this.concurrency?.acquire();
    try {
      const res = await this.doChatCompletionsRequest(body);
      if (!res.body) {
        throw new Error("Response body is null (no stream)");
      }

      // Buffer the entire stream
      let content = "";
      let reasoning = "";
      let usage: any = undefined;

      for await (const chunk of translateQwenSse(res.body)) {
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
        if (chunk.usage) usage = chunk.usage;
      }

      if (content === "" && reasoning === "") {
        throw new EmptyCompletionError("upstream returned an empty completion (content and reasoning_content both empty — likely Baxia CAPTCHA flag)");
      }

      return {
        id: "chatcmpl-" + randomUUID(),
        object: "chat.completion" as const,
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
            },
            finish_reason: "stop",
          },
        ],
        ...(usage ? { usage } : {}),
      };
    } finally {
      this.concurrency?.release();
    }
  }

  private async doChatCompletionsRequest(body: ChatCompletionsBody): Promise<Response> {
    const enableThinking = body.enable_thinking === true;
    const wantsSearch =
      Array.isArray(body.tools) &&
      body.tools.some((t: any) => t?.type === "web_search");
    const chatType: "t2t" | "search" = wantsSearch ? "search" : "t2t";

    const chatId = await this.createChatSession(body.model, chatType);
    const tokens = await this.baxia.ensureToken();

    const qwenMsg = this.normalizeMessages(
      body.messages,
      body.model,
      chatType,
      enableThinking,
      wantsSearch,
    );

    const upstreamBody = {
      stream: true,
      version: "2.1",
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "guest",
      model: body.model,
      parent_id: null,
      messages: [qwenMsg],
      timestamp: Date.now(),
    };

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "bx-ua": tokens.bxUa,
      "bx-umidtoken": tokens.bxUmidToken,
      "bx-v": tokens.bxV,
      Cookie: tokens.cookies,
      "x-accel-buffering": "no",
      Origin: this.chatUrl,
      source: "web",
      version: "0.2.83",
      Referer: `${this.chatUrl}/c/guest`,
      "User-Agent": this.userAgent,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "x-request-id": randomUUID(),
    };

    const res = await this._fetch(
      `${this.chatUrl}/api/v2/chat/completions?chat_id=${chatId}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Check for data_inspection_failed in error body
      try {
        const json = JSON.parse(text);
        if (isDataInspectionFailed(json)) {
          throw new ClientError("data_inspection_failed: content moderated by upstream", { status: 400 });
        }
      } catch (e) {
        if (e instanceof ClientError) throw e;
      }
      throw new Error(`chatCompletions upstream error ${res.status}: ${text.slice(0, 300)}`);
    }

    return res;
  }

  // ── listModels ─────────────────────────────────────────────────────────

  async listModels(_bearer: string): Promise<Model[]> {
    if (this.modelsCache) return this.modelsCache;

    const res = await this._fetch(`${this.chatUrl}/api/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`listModels upstream error ${res.status}: ${text.slice(0, 200)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const json = (await res.json()) as { data?: { id: string }[]; models?: { id: string }[] };
      const ids = (json.data ?? json.models ?? []).map((m) => m.id);
      this.modelsCache = ids.map((id) => ({ id, object: "model" as const, owned_by: "qwen" }));
      return this.modelsCache;
    }

    // HTML fallback — scrape prerendered data
    const html = await res.text();
    const ids = this.extractPrerenderedData(html);
    this.modelsCache = ids.map((id) => ({ id, object: "model" as const, owned_by: "qwen" }));
    return this.modelsCache;
  }

  private extractPrerenderedData(html: string): string[] {
    // Try __PRERENDERED_DATA__ or __NEXT_DATA__ blob first (JSON.parse for robustness)
    const blobMatch =
      html.match(/__PRERENDERED_DATA__\s*=\s*(\{[\s\S]*?\})\s*[;<]/) ??
      html.match(/__NEXT_DATA__\s*=\s*(\{[\s\S]*?\})\s*[;<]/);
    if (blobMatch) {
      try {
        const data = JSON.parse(blobMatch[1]) as { models?: { id: string }[] };
        const models = (data.models ?? []).map((m) => m.id).filter(Boolean);
        if (models.length > 0) return models;
      } catch {
        // fall through
      }
    }

    // Fallback: find "models" key and extract the balanced bracket array
    const modelsKeyMatch = html.match(/"models"\s*:\s*\[/);
    if (modelsKeyMatch?.index != null) {
      const startBracket = modelsKeyMatch.index + modelsKeyMatch[0].length - 1;
      let depth = 0;
      for (let i = startBracket; i < html.length; i++) {
        if (html[i] === "[") depth++;
        if (html[i] === "]") {
          depth--;
          if (depth === 0) {
            try {
              const arr = JSON.parse(html.slice(startBracket, i + 1)) as { id?: string }[];
              return arr.map((m) => m.id ?? "").filter(Boolean);
            } catch {
              return [];
            }
          }
        }
      }
    }

    return [];
  }

  // ── deleteChats ────────────────────────────────────────────────────────

  async deleteChats(_bearer: string): Promise<void> {
    return;
  }
}
