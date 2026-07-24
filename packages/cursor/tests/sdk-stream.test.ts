import { describe, expect, it } from "vitest";
import { streamCursor, streamCursorLazy } from "../src/sdk-stream";

describe("sdk-stream stub", () => {
  it("streamCursor returns a stream that terminates with an error", async () => {
    const fakeModel = {
      id: "test-model",
      name: "Test Model",
      provider: "cursor",
      api: "cursor-sdk" as unknown as never,
      baseUrl: "",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    };
    const fakeContext = {
      messages: [],
    };

    const stream = streamCursor(
      fakeModel as Parameters<typeof streamCursor>[0],
      fakeContext as Parameters<typeof streamCursor>[1],
    );

    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("not yet wired");
  });

  it("streamCursorLazy is the same function as streamCursor", () => {
    expect(streamCursorLazy).toBe(streamCursor);
  });
});
