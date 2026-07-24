/**
 * Context builder — converts pi's Context into SDK user messages.
 *
 * The SDK local-agent persists conversation state internally, so subsequent
 * turns must NOT re-send the whole transcript (that would double-count history).
 *
 * Two builders:
 * - `buildFullContextPrompt` — cold start: systemPrompt + ALL messages.
 * - `buildIncrementalPrompt` — follow-up turns: only messages from `fromIndex`.
 */

import type { Context, Message, TextContent, ImageContent } from "@earendil-works/pi-ai";

// ─── Public types ────────────────────────────────────────────────────────────

export interface SdkUserMessage {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract human-readable text from a Message.
 *
 * - user (string content) → the string
 * - user (array content)  → joined text blocks (images skipped)
 * - assistant             → text content blocks joined
 * - toolResult            → labelled "[tool] <text>"
 */
export function extractText(msg: Message): string {
  switch (msg.role) {
    case "user": {
      if (typeof msg.content === "string") return msg.content;
      return msg.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
    case "assistant":
      return msg.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    case "toolResult": {
      const inner = msg.content
        .filter((b): b is TextContent => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return `[tool] ${inner}`;
    }
    default: {
      // Runtime fallback for non-standard roles (e.g. "system").
      // msg is typed `never` here because the union is exhaustive, but
      // consumers may inject messages with non-standard roles at runtime.
      const content = (msg as unknown as { content: string | unknown[] }).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return (content as TextContent[])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n");
      }
      return "";
    }
  }
}

/**
 * Collect image data from a Message into the output array.
 *
 * Recognises two block shapes:
 * 1. `{ type: "image", data, mimeType }` — standard ImageContent
 * 2. `{ type: "image_url", image_url: { url: "data:mime;base64,..." } }` — data-URL variant
 */
export function collectImages(
  msg: Message,
  out: Array<{ data: string; mimeType: string }>,
): void {
  const content = msg.role === "user"
    ? (typeof msg.content === "string" ? [] : msg.content)
    : msg.role === "assistant"
      ? msg.content
      : msg.content;

  for (const block of content) {
    if (block.type === "image") {
      const img = block as ImageContent;
      out.push({ data: img.data, mimeType: img.mimeType });
    } else if ((block as { type: string }).type === "image_url") {
      // Some providers emit data-URLs in image_url blocks
      const url = (block as unknown as { image_url?: { url?: string } }).image_url?.url;
      if (url && url.startsWith("data:")) {
        const commaIdx = url.indexOf(",");
        if (commaIdx !== -1) {
          const meta = url.slice(5, commaIdx); // "image/png;base64"
          const semiIdx = meta.indexOf(";");
          const mimeType = semiIdx !== -1 ? meta.slice(0, semiIdx) : meta;
          const data = url.slice(commaIdx + 1);
          out.push({ data, mimeType });
        }
      }
    }
  }
}

// ─── Builders ────────────────────────────────────────────────────────────────

function rolePrefix(msg: Message): string {
  switch (msg.role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool";
    default:
      return (msg as unknown as { role: string }).role;
  }
}

function buildFromMessages(
  systemPrompt: string | undefined,
  messages: readonly Message[],
): SdkUserMessage {
  const parts: string[] = [];
  const images: Array<{ data: string; mimeType: string }> = [];

  if (systemPrompt) {
    parts.push(`[system]: ${systemPrompt}`);
  }

  for (const msg of messages) {
    const text = extractText(msg);
    if (text) {
      parts.push(`[${rolePrefix(msg)}]: ${text}`);
    }
    collectImages(msg, images);
  }

  return {
    text: parts.join("\n\n"),
    images: images.length > 0 ? images : undefined,
  };
}

/**
 * Build a full context prompt — systemPrompt + ALL messages.
 * Used on the FIRST send to a fresh SDK agent (cold start).
 */
export function buildFullContextPrompt(context: Context): SdkUserMessage {
  return buildFromMessages(context.systemPrompt, context.messages);
}

/**
 * Build an incremental prompt — only messages from `fromIndex` onwards.
 * Used for new user turns after a run completed (SDK retains prior turns).
 */
export function buildIncrementalPrompt(context: Context, fromIndex: number): SdkUserMessage {
  if (fromIndex >= context.messages.length || context.messages.length === 0) {
    return { text: "" };
  }
  return buildFromMessages(undefined, context.messages.slice(fromIndex));
}
