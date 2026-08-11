import { describe, it, expect } from "vitest";
import { sizeToRatio, generateImage, editImage, SIZE_TO_RATIO } from "../../src/media/images";
import type { MediaImageDeps } from "../../src/media/images";
import type { UpstreamClient, ImageResult } from "../../src/upstream/client";
import type { RetryDeps } from "../../src/pool/retry";
import { withPoolRetry } from "../../src/pool/retry";

describe("SIZE_TO_RATIO", () => {
  it("maps known sizes to ratios", () => {
    expect(SIZE_TO_RATIO["1024x1024"]).toBe("1:1");
    expect(SIZE_TO_RATIO["1792x1024"]).toBe("16:9");
    expect(SIZE_TO_RATIO["1024x1792"]).toBe("9:16");
  });
});

describe("sizeToRatio", () => {
  it("returns 1:1 for 1024x1024", () => {
    expect(sizeToRatio("1024x1024")).toBe("1:1");
  });

  it("returns 16:9 for 1792x1024", () => {
    expect(sizeToRatio("1792x1024")).toBe("16:9");
  });

  it("returns 9:16 for 1024x1792", () => {
    expect(sizeToRatio("1024x1792")).toBe("9:16");
  });

  it("returns 1:1 for unknown size", () => {
    expect(sizeToRatio("512x512")).toBe("1:1");
  });

  it("returns 1:1 when size is undefined", () => {
    expect(sizeToRatio(undefined)).toBe("1:1");
  });

  it("returns 1:1 when size is omitted", () => {
    expect(sizeToRatio()).toBe("1:1");
  });
});

function makeDeps(overrides?: Partial<MediaImageDeps>): MediaImageDeps {
  return {
    pool: {
      getActiveAccount: () => ({ id: 1, bearer: "test-bearer", expiresAt: null }),
      markRateLimitedAndSwitch: async () => ({ newActiveId: null, earliestReEnableAt: null }),
      earliestReEnableAt: () => null,
      hydrate: () => {},
      reEnableExpired: () => ({ cleared: 0, promoted: 0 }),
    } as unknown as RetryDeps["pool"],
    scheduler: { refreshOnDemand: async () => ({ bearer: "r", expiresAt: 999999 }) },
    config: { rateLimitCooldownMs: 60_000, emptyCooldownMs: 600_000 },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    client: {} as unknown as UpstreamClient,
    retry: withPoolRetry,
    ...overrides,
  };
}

describe("generateImage", () => {
  it("calls client.imageGeneration with the ratio via pool", async () => {
    let calledWith: unknown;
    const result: ImageResult = { created: 1000, urls: ["https://img/1.png"] };
    const client = {
      imageGeneration: async (_bearer: string, body: unknown) => {
        calledWith = body;
        return result;
      },
      imageEdit: async () => ({ created: 0, urls: [] }),
    } as unknown as UpstreamClient;

    const deps = makeDeps({ client });
    const output = await generateImage(deps, { prompt: "a cat", size: "1792x1024" });

    expect(calledWith).toEqual({ prompt: "a cat", size: "16:9" });
    expect(output).toEqual({ created: 1000, urls: ["https://img/1.png"] });
  });

  it("uses default 1:1 ratio when size is undefined", async () => {
    let calledWith: unknown;
    const client = {
      imageGeneration: async (_bearer: string, body: unknown) => {
        calledWith = body;
        return { created: 1, urls: [] };
      },
      imageEdit: async () => ({ created: 0, urls: [] }),
    } as unknown as UpstreamClient;

    const deps = makeDeps({ client });
    await generateImage(deps, { prompt: "test" });

    expect(calledWith).toEqual({ prompt: "test", size: "1:1" });
  });

  it("n>1 coerced to 1 — still returns single url", async () => {
    const client = {
      imageGeneration: async () => ({ created: 1, urls: ["u"] }),
      imageEdit: async () => ({ created: 0, urls: [] }),
    } as unknown as UpstreamClient;

    const deps = makeDeps({ client });
    const output = await generateImage(deps, { prompt: "test", n: 5 });
    // n>1 is handled at adapter layer; core always returns 1 url
    expect(output.urls).toEqual(["u"]);
  });
});

describe("editImage", () => {
  it("calls client.imageEdit with image and prompt", async () => {
    let calledWith: unknown;
    const result: ImageResult = { created: 2000, urls: ["https://img/edited.png"] };
    const client = {
      imageGeneration: async () => ({ created: 0, urls: [] }),
      imageEdit: async (_bearer: string, body: unknown) => {
        calledWith = body;
        return result;
      },
    } as unknown as UpstreamClient;

    const deps = makeDeps({ client });
    const output = await editImage(deps, { image: "base64data", prompt: "add hat" });

    expect(calledWith).toEqual({ image: "base64data", prompt: "add hat" });
    expect(output).toEqual({ created: 2000, urls: ["https://img/edited.png"] });
  });
});
