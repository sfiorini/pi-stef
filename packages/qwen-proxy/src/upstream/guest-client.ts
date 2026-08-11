/**
 * Guest-mode upstream client for chat.qwen.ai.
 * Handles guest session creation, message normalization, and
 * will eventually (S-M2-3) provide chatCompletions/listModels/deleteChats.
 */

import { randomUUID } from "node:crypto";
import type { BaxiaTokenManager } from "./baxia-token";
import type { ChatCompletionsBody } from "./types";
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

  constructor(config: GuestUpstreamClientConfig) {
    this.baxia = config.baxia;
    this.chatUrl = config.chatUrl;
    this._fetch = config.fetcher ?? globalThis.fetch;
    this.userAgent = config.userAgent ?? DEFAULT_UA;
    this.log = config.log;
    this._sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ── createChatSession ──────────────────────────────────────────────────

  async createChatSession(model: string, chatType: "t2t" | "search"): Promise<string> {
    const tokens = await this.baxia.ensureToken();
    const referer = `${this.chatUrl}/c/guest`;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "bx-ua": tokens.bxUa,
      "bx-umidtoken": tokens.bxUmidToken,
      "bx-v": tokens.bxV,
      Cookie: tokens.cookies,
      source: "web",
      version: "0.2.83",
      Referer: referer,
      "User-Agent": this.userAgent,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "x-request-id": randomUUID(),
    };

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
      const res = await this._fetch(`${this.chatUrl}/api/v2/chats/new`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      const data = await res.json();

      // Check for rgv587 (Baxia captcha rejection)
      if (RGV587_RE.test(JSON.stringify(data)) || RGV587_RE.test(String(res.status))) {
        this.log.warn("createChatSession rgv587 detected, retrying", { attempt: attempt + 1 });
        if (attempt < maxRetries - 1) {
          await this.baxia.ensureToken({ forceRefresh: true });
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
      chat_type: chatType,
      feature_config: {
        thinking_enabled: !!enableThinking,
        output_schema: "phase",
        research_mode: "normal",
        auto_thinking: true,
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

  // ── Stubs (S-M2-3) ────────────────────────────────────────────────────

  async chatCompletions(_bearer: string, _body: ChatCompletionsBody): Promise<any> {
    throw new Error("not impl");
  }

  async listModels(_bearer: string): Promise<any> {
    throw new Error("not impl");
  }

  async deleteChats(_bearer: string): Promise<void> {
    throw new Error("not impl");
  }
}
