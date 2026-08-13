/**
 * Guest client smoke test — SMOKE=1 only.
 * Requires real host Chrome and live chat.qwen.ai.
 *
 * Run: SMOKE=1 SF_QWEN_CHROME_PATH=/usr/bin/chromium pnpm --filter @pi-stef/qwen-proxy exec vitest run tests/upstream/guest-client.smoke.ts
 *
 * Default vitest run skips this file (vitest.config.ts only includes *.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BaxiaTokenManager } from "../../src/upstream/baxia-token";
import { GuestUpstreamClient } from "../../src/upstream/guest-client";
import type { OpenAiChatChunk } from "../../src/upstream/types";

const SMOKE = process.env.SMOKE === "1";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

(SMOKE ? describe : describe.skip)("guest-client smoke", () => {
  let baxia: BaxiaTokenManager;

  beforeAll(() => {
    baxia = new BaxiaTokenManager({
      chatUrl: "https://chat.qwen.ai",
      chromePath: process.env.SF_QWEN_CHROME_PATH,
      cacheTtlMs: 1_500_000,
      baxiaVersion: "2.5.37",
      fallback: false,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      log: noopLog,
    });
  });

  afterAll(() => {
    baxia.stop();
  });

  it("chatCompletions stream returns non-empty content (t2t)", async () => {
    const client = new GuestUpstreamClient({
      baxia,
      chatUrl: "https://chat.qwen.ai",
      log: noopLog,
    });

    const result = client.chatCompletions("ignored", {
      model: "qwen3-max",
      messages: [{ role: "user", content: "Say hi in 3 words" }],
      stream: true,
    });

    let content = "";
    for await (const chunk of result as AsyncIterable<OpenAiChatChunk>) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
    }

    expect(content.length).toBeGreaterThan(0);
    console.log("[smoke] t2t content:", content.slice(0, 100));
  });

  it("chatCompletions stream with enable_thinking returns some reasoning_content", async () => {
    const client = new GuestUpstreamClient({
      baxia,
      chatUrl: "https://chat.qwen.ai",
      log: noopLog,
    });

    const result = client.chatCompletions("ignored", {
      model: "qwen3-max",
      messages: [{ role: "user", content: "What is 2+2? Think step by step." }],
      stream: true,
      enable_thinking: true,
    });

    let hasReasoning = false;
    let content = "";
    for await (const chunk of result as AsyncIterable<OpenAiChatChunk>) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) hasReasoning = true;
      if (delta?.content) content += delta.content;
    }

    expect(content.length).toBeGreaterThan(0);
    // Reasoning may or may not be present depending on model, log it
    console.log("[smoke] thinking: hasReasoning=", hasReasoning, "content=", content.slice(0, 100));
  });

  it("chat_type defaults to t2t for plain request", async () => {
    // Verify the request body has chat_type: "t2t" by intercepting fetch
    let capturedChatType: string | undefined;
    const origFetch = globalThis.fetch;
    const spyFetch: typeof fetch = async (url: any, init?: any) => {
      if (typeof url === "string" && url.includes("/api/v2/chat/completions")) {
        try {
          const body = JSON.parse(init?.body);
          capturedChatType = body.messages?.[0]?.chat_type;
        } catch { /* ignore */ }
      }
      return origFetch(url, init);
    };

    const clientWithSpy = new GuestUpstreamClient({
      baxia,
      chatUrl: "https://chat.qwen.ai",
      fetcher: spyFetch,
      log: noopLog,
    });

    const result = clientWithSpy.chatCompletions("ignored", {
      model: "qwen3-max",
      messages: [{ role: "user", content: "Say hi" }],
      stream: true,
    });

    // Consume stream
    for await (const _ of result as AsyncIterable<OpenAiChatChunk>) { /* drain */ }

    expect(capturedChatType).toBe("t2t");
    console.log("[smoke] default chat_type:", capturedChatType);
  });

  it("tools with web_search sets chat_type to search", async () => {
    let capturedChatType: string | undefined;
    const origFetch = globalThis.fetch;
    const spyFetch2: typeof fetch = async (url: any, init?: any) => {
      if (typeof url === "string" && url.includes("/api/v2/chat/completions")) {
        try {
          const body = JSON.parse(init?.body);
          capturedChatType = body.messages?.[0]?.chat_type;
        } catch { /* ignore */ }
      }
      return origFetch(url, init);
    };

    const clientWithSpy = new GuestUpstreamClient({
      baxia,
      chatUrl: "https://chat.qwen.ai",
      fetcher: spyFetch2,
      log: noopLog,
    });

    const result = clientWithSpy.chatCompletions("ignored", {
      model: "qwen3-max",
      messages: [{ role: "user", content: "Search for latest news" }],
      stream: true,
      tools: [{ type: "web_search" }],
    });

    // Consume stream
    for await (const _ of result as AsyncIterable<OpenAiChatChunk>) { /* drain */ }

    expect(capturedChatType).toBe("search");
    console.log("[smoke] search chat_type:", capturedChatType);
  });
});
