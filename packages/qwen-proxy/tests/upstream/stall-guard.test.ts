import { describe, it, expect } from "vitest";
import { EmptyCompletionError } from "../../src/upstream/errors";
import type { OpenAiChatChunk } from "../../src/upstream/types";

function contentChunk(content: string): OpenAiChatChunk {
  return { choices: [{ delta: { content } }] };
}

function usageOnlyChunk(): OpenAiChatChunk {
  return { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } };
}

/** A chunk source that never yields (silent stream). */
function silentSource(): AsyncGenerator<OpenAiChatChunk> {
  return (async function* () {
    await new Promise<void>(() => {}); // never resolves
  })();
}

/** A chunk source that yields once, then stalls forever. */
function stallAfterFirst(first: OpenAiChatChunk): AsyncGenerator<OpenAiChatChunk> {
  return (async function* () {
    yield first;
    await new Promise<void>(() => {}); // never resolves
  })();
}

function trackingBody(): { body: ReadableStream<Uint8Array>; cancelled: () => number } {
  let cancelled = 0;
  const body = {
    cancel: async () => {
      cancelled += 1;
    },
  } as unknown as ReadableStream<Uint8Array>;
  return { body, cancelled: () => cancelled };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("withStallGuard", () => {
  it("silent stream: first-payload timeout throws EmptyCompletionError and cancels the body", async () => {
    const { withStallGuard } = await import("../../src/upstream/stall-guard");
    const { body, cancelled } = trackingBody();
    await expect(
      collect(withStallGuard(silentSource(), body, { firstPayloadTimeoutMs: 50, idleTimeoutMs: 0 })),
    ).rejects.toBeInstanceOf(EmptyCompletionError);
    expect(cancelled()).toBeGreaterThanOrEqual(1);
  });

  it("payload then silence: idle timeout ends gracefully after partial content, cancels the body", async () => {
    const { withStallGuard } = await import("../../src/upstream/stall-guard");
    const { body, cancelled } = trackingBody();
    const chunks = await collect(
      withStallGuard(stallAfterFirst(contentChunk("hi")), body, { firstPayloadTimeoutMs: 0, idleTimeoutMs: 50 }),
    );
    expect(chunks.map((c) => c.choices?.[0]?.delta?.content)).toEqual(["hi"]);
    expect(cancelled()).toBeGreaterThanOrEqual(1);
  });

  it("continuous chunks: no premature idle end while data flows", async () => {
    const { withStallGuard } = await import("../../src/upstream/stall-guard");
    const { body } = trackingBody();
    const source = (async function* () {
      for (let i = 0; i < 5; i++) {
        yield contentChunk("c" + i);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const chunks = await collect(withStallGuard(source, body, { firstPayloadTimeoutMs: 500, idleTimeoutMs: 100 }));
    expect(chunks.length).toBe(5);
  });

  it("usage-only chunk does NOT disarm the first-payload timer", async () => {
    const { withStallGuard } = await import("../../src/upstream/stall-guard");
    const { body } = trackingBody();
    await expect(
      collect(withStallGuard(stallAfterFirst(usageOnlyChunk()), body, { firstPayloadTimeoutMs: 50, idleTimeoutMs: 0 })),
    ).rejects.toBeInstanceOf(EmptyCompletionError);
  });

  it("both timeouts 0: pass-through, no timers", async () => {
    const { withStallGuard } = await import("../../src/upstream/stall-guard");
    const { body } = trackingBody();
    const source = (async function* () {
      yield contentChunk("a");
      yield contentChunk("b");
    })();
    const chunks = await collect(withStallGuard(source, body, {}));
    expect(chunks.length).toBe(2);
  });

  it("consumer break: body cancelled on abandonment", async () => {
    const { withStallGuard } = await import("../../src/upstream/stall-guard");
    const { body, cancelled } = trackingBody();
    const source = (async function* () {
      yield contentChunk("a");
      await new Promise<void>(() => {});
    })();
    const guard = withStallGuard(source, body, { firstPayloadTimeoutMs: 10_000, idleTimeoutMs: 10_000 });
    for await (const _ of guard) break; // abandon after first chunk
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelled()).toBeGreaterThanOrEqual(1);
  });
});
