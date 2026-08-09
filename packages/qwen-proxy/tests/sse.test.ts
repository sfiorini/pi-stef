import { describe, it, expect } from "vitest";
import { parseSseStream, type SseEvent } from "../src/upstream/sse";

/** Build a ReadableStream<Uint8Array> from string chunks. */
function streamFromChunks(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

/** Collect all events from the async generator. */
async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(stream)) {
    events.push(event);
  }
  return events;
}

describe("parseSseStream", () => {
  it("splits records on blank-line boundary (\\n\\n)", async () => {
    const stream = streamFromChunks(
      "data: hello\n\ndata: world\n\n",
    );
    const events = await collect(stream);
    expect(events).toEqual([
      { data: "hello" },
      { data: "world" },
    ]);
  });

  it("concatenates consecutive data: lines with \\n", async () => {
    const stream = streamFromChunks(
      "data: line1\ndata: line2\ndata: line3\n\n",
    );
    const events = await collect(stream);
    expect(events).toEqual([{ data: "line1\nline2\nline3" }]);
  });

  it("captures event: field", async () => {
    const stream = streamFromChunks(
      "event: message\ndata: payload\n\n",
    );
    const events = await collect(stream);
    expect(events).toEqual([{ event: "message", data: "payload" }]);
  });

  it("data: [DONE] yields { data: '[DONE]' } then returns", async () => {
    const stream = streamFromChunks(
      "data: first\n\ndata: [DONE]\n\ndata: after-done\n\n",
    );
    const events = await collect(stream);
    expect(events).toEqual([
      { data: "first" },
      { data: "[DONE]" },
    ]);
    // should NOT include "after-done"
    expect(events).toHaveLength(2);
  });

  it("ignores junk lines and empty lines between records", async () => {
    const stream = streamFromChunks(
      ": this is a comment\nid: 123\ndata: real\n\n",
    );
    const events = await collect(stream);
    expect(events).toEqual([{ data: "real" }]);
  });

  it("re-assembles a record split across two chunks", async () => {
    const stream = streamFromChunks(
      "data: hel",
      "lo\n\ndata: world\n\n",
    );
    const events = await collect(stream);
    expect(events).toEqual([
      { data: "hello" },
      { data: "world" },
    ]);
  });

  it("tolerates \\r\\n (CRLF) line endings", async () => {
    const stream = streamFromChunks(
      "data: hello\r\n\r\ndata: world\r\n\r\n",
    );
    const events = await collect(stream);
    expect(events).toEqual([
      { data: "hello" },
      { data: "world" },
    ]);
  });

  it("flushes trailing data without final \\n\\n on stream end", async () => {
    const stream = streamFromChunks("data: trailing");
    const events = await collect(stream);
    expect(events).toEqual([{ data: "trailing" }]);
  });

  it("handles an empty stream gracefully", async () => {
    const stream = streamFromChunks();
    const events = await collect(stream);
    expect(events).toEqual([]);
  });

  it("handles data with colons in the value (data: url: http://...)", async () => {
    const stream = streamFromChunks("data: url: http://example.com\n\n");
    const events = await collect(stream);
    expect(events).toEqual([{ data: "url: http://example.com" }]);
  });
});
