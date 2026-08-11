import { describe, it, expect, vi } from "vitest";
import { GuestUpstreamClient } from "../../src/upstream/guest-client";
import type { BaxiaTokenManager, BaxiaTokens } from "../../src/upstream/baxia-token";
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

    // feature_config (6 fields)
    expect(result.feature_config).toEqual({
      thinking_enabled: true,
      output_schema: "phase",
      research_mode: "normal",
      auto_thinking: true,
      thinking_format: "summary",
      auto_search: false,
    });

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
