import { describe, expect, it } from "vitest";

import {
  buildFullContextPrompt,
  buildIncrementalPrompt,
  extractText,
  collectImages,
} from "../src/context-builder";
import type { Context, Message, TextContent, ImageContent } from "@earendil-works/pi-ai";

// --- helpers to build test messages ---

function userText(text: string): Message {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

function assistantText(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text } as TextContent],
    api: "cursor-sdk",
    provider: "cursor",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolResult(toolCallId: string, toolName: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text } as TextContent],
    isError: false,
    timestamp: Date.now(),
  };
}

function userWithImage(imageData: string, mimeType: string, altText?: string): Message {
  const blocks: (TextContent | ImageContent)[] = [
    { type: "image", data: imageData, mimeType } as ImageContent,
  ];
  if (altText) {
    blocks.unshift({ type: "text", text: altText } as TextContent);
  }
  return {
    role: "user",
    content: blocks,
    timestamp: Date.now(),
  };
}

function userWithImageUrlDataUrl(dataUrl: string): Message {
  // image_url blocks with data: URLs — a shape some providers use
  return {
    role: "user",
    content: [
      { type: "text", text: "see image" } as TextContent,
      { type: "image_url", image_url: { url: dataUrl } } as unknown as TextContent,
    ],
    timestamp: Date.now(),
  };
}

// --- tests ---

describe("buildFullContextPrompt", () => {
  it("includes systemPrompt + ALL messages role-prefixed and joined by \\n\\n", () => {
    const ctx: Context = {
      systemPrompt: "You are helpful.",
      messages: [userText("hello"), assistantText("hi there")],
    };
    const result = buildFullContextPrompt(ctx);
    expect(result.text).toContain("[system]: You are helpful.");
    expect(result.text).toContain("[user]: hello");
    expect(result.text).toContain("[assistant]: hi there");
    // separated by double newline
    expect(result.text).toMatch(/\[system\]:.*\n\n\[user\]:.*\n\n\[assistant\]:/s);
  });

  it("collects ImageContent blocks into images array", () => {
    const ctx: Context = {
      messages: [userWithImage("aGVsbG8=", "image/png", "test image")],
    };
    const result = buildFullContextPrompt(ctx);
    expect(result.images).toHaveLength(1);
    expect(result.images![0]).toEqual({ data: "aGVsbG8=", mimeType: "image/png" });
  });

  it("collects image_url data-URL blocks into images array", () => {
    const dataUrl = "data:image/jpeg;base64,/9j/4AAQ";
    const ctx: Context = {
      messages: [userWithImageUrlDataUrl(dataUrl)],
    };
    const result = buildFullContextPrompt(ctx);
    expect(result.images).toHaveLength(1);
    expect(result.images![0]).toEqual({ data: "/9j/4AAQ", mimeType: "image/jpeg" });
  });

  it("returns images: undefined when no images present", () => {
    const ctx: Context = {
      messages: [userText("no images here")],
    };
    const result = buildFullContextPrompt(ctx);
    expect(result.images).toBeUndefined();
  });

  it("handles empty messages with systemPrompt", () => {
    const ctx: Context = {
      systemPrompt: "system only",
      messages: [],
    };
    const result = buildFullContextPrompt(ctx);
    expect(result.text).toBe("[system]: system only");
  });
});

describe("buildIncrementalPrompt", () => {
  it("only includes messages from fromIndex onwards", () => {
    const msgs = [userText("msg0"), assistantText("msg1"), userText("msg2"), assistantText("msg3")];
    const ctx: Context = { messages: msgs };
    const result = buildIncrementalPrompt(ctx, 2);
    expect(result.text).toContain("[user]: msg2");
    expect(result.text).toContain("[assistant]: msg3");
    expect(result.text).not.toContain("msg0");
    expect(result.text).not.toContain("msg1");
  });

  it("returns empty text when fromIndex >= messages.length", () => {
    const ctx: Context = { messages: [userText("only one")] };
    const result = buildIncrementalPrompt(ctx, 5);
    expect(result.text).toBe("");
  });

  it("returns empty text for empty messages regardless of fromIndex", () => {
    const ctx: Context = { messages: [] };
    const result = buildIncrementalPrompt(ctx, 0);
    expect(result.text).toBe("");
  });

  it("collects images only from sliced messages", () => {
    const msgs = [
      userWithImage("early", "image/png"),
      userText("middle"),
      userWithImage("later", "image/jpeg"),
    ];
    const ctx: Context = { messages: msgs };
    const result = buildIncrementalPrompt(ctx, 1);
    // image from index 0 should NOT be included
    expect(result.images).toHaveLength(1);
    expect(result.images![0]).toEqual({ data: "later", mimeType: "image/jpeg" });
  });
});

describe("extractText", () => {
  it("extracts string content from user message", () => {
    const msg = userText("hello world");
    expect(extractText(msg)).toBe("hello world");
  });

  it("extracts text from text blocks in assistant message", () => {
    const msg = assistantText("assistant says");
    expect(extractText(msg)).toBe("assistant says");
  });

  it("labels tool-role messages with [tool]", () => {
    const msg = toolResult("tc1", "read_file", "file contents");
    expect(extractText(msg)).toContain("[tool]");
    expect(extractText(msg)).toContain("file contents");
  });

  it("handles user message with array content (text + image)", () => {
    const msg = userWithImage("data", "image/png", "some text");
    const text = extractText(msg);
    expect(text).toContain("some text");
    // image blocks should NOT produce text
    expect(text).not.toContain("data");
  });
});

describe("collectImages", () => {
  it("collects ImageContent blocks", () => {
    const out: Array<{ data: string; mimeType: string }> = [];
    const msg = userWithImage("imgdata", "image/gif");
    collectImages(msg, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ data: "imgdata", mimeType: "image/gif" });
  });

  it("collects image_url data-URL blocks", () => {
    const out: Array<{ data: string; mimeType: string }> = [];
    const msg = userWithImageUrlDataUrl("data:image/webp;base64,d2VicA==");
    collectImages(msg, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ data: "d2VicA==", mimeType: "image/webp" });
  });

  it("skips image_url with non-data URLs", () => {
    const out: Array<{ data: string; mimeType: string }> = [];
    const msg: Message = {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "https://example.com/cat.jpg" } } as unknown as TextContent,
      ],
      timestamp: Date.now(),
    };
    collectImages(msg, out);
    expect(out).toHaveLength(0);
  });

  it("handles assistant and toolResult messages (no images)", () => {
    const out: Array<{ data: string; mimeType: string }> = [];
    collectImages(assistantText("text"), out);
    collectImages(toolResult("tc1", "tool", "result"), out);
    expect(out).toHaveLength(0);
  });
});
