/**
 * M3 real-testing gate — 4 integration tests against a running :7791 instance.
 *
 * Gated behind SMOKE=1 (excluded from default vitest run by the
 * tests test.ts include pattern — vitest only picks up .test.ts).
 *
 * Requires:
 *   SMOKE=1
 *   E2E_BASE_URL (default http://127.0.0.1:7791)
 *   E2E_API_KEY  (the test API key for the booted instance)
 *
 * Run:
 *   SMOKE=1 E2E_BASE_URL=http://127.0.0.1:7791 E2E_API_KEY=<key> \
 *     pnpm --filter @pi-stef/qwen-proxy exec vitest run tests/e2e/m3-gate.smoke.ts
 */

import { describe, it, expect } from "vitest";

const SMOKE = process.env.SMOKE === "1";
const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:7791";
const API_KEY = process.env.E2E_API_KEY ?? "";

// ── SSE parser helper ──────────────────────────────────────────────────────

interface SseEvent {
  event?: string;
  data: string;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on double newline (SSE event boundary)
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!; // keep incomplete tail

      for (const part of parts) {
        if (!part.trim()) continue;
        let event: string | undefined;
        let data = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) {
            event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            data += line.slice(6);
          } else if (line.startsWith("data:")) {
            data += line.slice(5);
          }
        }
        if (data) {
          yield { event, data };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

(SMOKE ? describe : describe.skip)("m3 :7791 gate", () => {
  const TIMEOUT = 120_000; // generous for cold-start + upstream latency

  it(
    "single stream: returns content + stop + usage",
    async () => {
      const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: "qwen3-max",
          messages: [{ role: "user", content: "reply with the word pong" }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      let hasContent = false;
      let hasStop = false;
      let usage: any = undefined;

      for await (const ev of parseSseStream(res.body!)) {
        if (ev.data === "[DONE]") break;
        try {
          const json = JSON.parse(ev.data);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) hasContent = true;
          if (json.choices?.[0]?.finish_reason === "stop") hasStop = true;
          if (json.usage) usage = json.usage;
        } catch {
          // skip non-JSON
        }
      }

      expect(hasContent).toBe(true);
      expect(hasStop).toBe(true);
      expect(usage).toBeDefined();
      expect(usage.prompt_tokens).toBeGreaterThan(0);
      expect(usage.completion_tokens).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "tool-calling e2e: returns tool_calls delta",
    async () => {
      const maxRetries = 3;
      let passed = false;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify({
            model: "qwen3-max",
            messages: [
              {
                role: "user",
                content:
                  "What's the weather in Tokyo? Call get_weather.",
              },
            ],
            stream: true,
            tools: [
              {
                type: "function",
                function: {
                  name: "get_weather",
                  parameters: {
                    type: "object",
                    properties: {
                      city: { type: "string" },
                    },
                  },
                },
              },
            ],
          }),
        });

        expect(res.status).toBe(200);
        expect(res.body).not.toBeNull();

        let hasToolCalls = false;
        let hasToolCallsFinish = false;

        for await (const ev of parseSseStream(res.body!)) {
          if (ev.data === "[DONE]") break;
          try {
            const json = JSON.parse(ev.data);
            const delta = json.choices?.[0]?.delta;
            if (delta?.tool_calls) hasToolCalls = true;
            if (json.choices?.[0]?.finish_reason === "tool_calls")
              hasToolCallsFinish = true;
          } catch {
            // skip non-JSON
          }
        }

        if (hasToolCalls && hasToolCallsFinish) {
          passed = true;
          break;
        }

        // Model declined tool call — retry
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      expect(passed).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "Anthropic e2e: returns message_start + content_block_delta + message_stop",
    async () => {
      const res = await fetch(`${BASE}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 64,
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      const eventTypes: string[] = [];

      for await (const ev of parseSseStream(res.body!)) {
        if (ev.event) eventTypes.push(ev.event);
      }

      expect(eventTypes).toContain("message_start");
      expect(eventTypes).toContain("content_block_delta");
      expect(eventTypes).toContain("message_stop");
    },
    TIMEOUT,
  );

  it(
    "12-concurrent burst: all 12 return 200 with non-empty content",
    async () => {
      const N = 12;

      const requests = Array.from({ length: N }, () =>
        fetch(`${BASE}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify({
            model: "qwen3-max",
            messages: [
              { role: "user", content: "say hello in one word" },
            ],
            stream: true,
          }),
        }),
      );

      const responses = await Promise.all(requests);

      // Assert all 12 returned HTTP 200
      let non200Count = 0;
      for (const res of responses) {
        if (res.status !== 200) non200Count++;
      }

      // Collect content from 200 responses
      let emptyCount = 0; // non-200 OR empty-stream
      emptyCount += non200Count; // non-200 counts as empty

      const contentPromises = responses
        .filter((res) => res.status === 200)
        .map(async (res) => {
          let content = "";
          if (!res.body) {
            emptyCount++;
            return;
          }
          for await (const ev of parseSseStream(res.body)) {
            if (ev.data === "[DONE]") break;
            try {
              const json = JSON.parse(ev.data);
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) content += delta.content;
            } catch {
              // skip non-JSON
            }
          }
          if (!content) emptyCount++;
        });

      await Promise.all(contentPromises);

      // Gate: zero empties (non-200 + empty-stream both count as empty)
      expect(emptyCount).toBe(0);
    },
    TIMEOUT,
  );
});
