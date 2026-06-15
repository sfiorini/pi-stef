import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCursorAuthClient } from "../src/auth";
import { parseModelId } from "../src/index";
import {
  buildCursorRequest,
  getCursorAgentUrl,
  resolveRequestedModelId,
  setBridgeFactoryForTests,
  stopProxy,
  __testInternals,
} from "../src/proxy";

const packageRoot = new URL("..", import.meta.url).pathname;

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(packageRoot, relativePath), "utf8")) as T;
}

describe("cursor-provider package metadata", () => {
  it("limits runtime dependencies and records catalog metadata", () => {
    const pkg = readJson<{
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      pi?: { extensions?: string[] };
    }>("package.json");

    expect(pkg.dependencies).toHaveProperty("@bufbuild/protobuf");
    expect(pkg.peerDependencies).toMatchObject({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
    });
    expect(pkg.pi?.extensions).toEqual(["./extensions"]);
  });
});

describe("cursor agent endpoint", () => {
  afterEach(() => {
    delete process.env.PI_CURSOR_AGENT_URL;
    delete process.env.CURSOR_AGENT_URL;
  });

  it("allows an explicit Cursor agent endpoint override", () => {
    process.env.PI_CURSOR_AGENT_URL = "https://agentn.us.api5.cursor.sh/";

    expect(getCursorAgentUrl()).toBe("https://agentn.us.api5.cursor.sh");
  });
});

describe("cursor model routing", () => {
  it("parses newer Cursor thinking, effort, and fast suffix forms", () => {
    expect(parseModelId("claude-opus-4-7-thinking-max")).toEqual({
      base: "claude-opus-4-7",
      effort: "max",
      fast: false,
      thinking: true,
    });
    expect(parseModelId("gpt-5.5-extra-high-fast")).toEqual({
      base: "gpt-5.5",
      effort: "xhigh",
      fast: true,
      thinking: false,
    });
  });

  it("does not synthesize reasoning-effort suffixes for exact non-effort Cursor models", () => {
    expect(
      __testInternals.resolveNativeReasoningEffort(
        {
          id: "gemini-3.1-pro",
          compat: { supportsReasoningEffort: false },
        } as any,
        { reasoning: "high" } as any,
      ),
    ).toBeUndefined();
  });

  it("maps reasoning effort only for Cursor models that advertise effort support", () => {
    expect(
      __testInternals.resolveNativeReasoningEffort(
        {
          id: "claude-4.6-sonnet",
          compat: { supportsReasoningEffort: true },
          thinkingLevelMap: { high: "medium" },
        } as any,
        { reasoning: "high" } as any,
      ),
    ).toBe("medium");
  });

  it("resolves requestedModel routing for max and parameterized Cursor models", () => {
    expect(
      resolveRequestedModelId(
        {
          id: "gpt-5.5-max-fast",
          name: "GPT-5.5 Max Fast",
          api: "cursor-native",
          provider: "cursor",
          baseUrl: "https://api2.cursor.sh",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 272_000,
          maxTokens: 64_000,
        },
        "high",
        new Map([
          [
            "gpt-5.5-max-fast",
            {
              high: {
                modelId: "gpt-5.5",
                parameters: [
                  { id: "context", value: "272k" },
                  { id: "fast", value: "true" },
                  { id: "reasoning", value: "high" },
                ],
                requestedMaxMode: true,
              },
            },
          ],
        ]),
      ),
    ).toMatchObject({
      modelId: "gpt-5.5",
      maxMode: true,
      parameters: expect.arrayContaining([
        { id: "context", value: "272k" },
        { id: "fast", value: "true" },
        { id: "reasoning", value: "high" },
      ]),
    });
  });
});

describe("cursor request construction", () => {
  it("preserves Pi system prompt text and inline image context", () => {
    const request = buildCursorRequest({
      conversationId: "conv-1",
      modelId: "composer-2",
      systemPrompt: "Pi docs live under ~/.pi/agent/docs.",
      turns: [
        {
          userText: "What is in this image?",
          images: [
            {
              data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
              mimeType: "image/png",
            },
          ],
          steps: [],
        },
      ],
      checkpoint: null,
      existingBlobStore: new Map(),
    });

    expect(request.blobStore.size).toBeGreaterThan(0);
    expect(__testInternals.decodeRequestForTests(request.requestBody).systemPrompt).toContain(
      "Pi docs live under ~/.pi/agent/docs.",
    );
    expect(__testInternals.decodeRequestForTests(request.requestBody).selectedImages).toHaveLength(1);
  });
});

describe("cursor OAuth test seams", () => {
  it("uses injected fetch, sleep, and PKCE generation for login polling", async () => {
    const calls: string[] = [];
    const auth = createCursorAuthClient({
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({
            accessToken: "header.eyJleHAiOjQxMDI0NDQ4MDB9.signature",
            refreshToken: "refresh-token",
          }),
          { status: 200 },
        );
      },
      generatePkce: async () => ({
        challenge: "fixed-challenge",
        uuid: "fixed-uuid",
        verifier: "fixed-verifier",
      }),
      sleep: async () => {},
    });
    const authUrls: string[] = [];

    const result = await auth.login({
      onAuth: ({ url }) => {
        authUrls.push(url);
      },
    });

    expect(authUrls[0]).toContain("fixed-challenge");
    expect(calls[0]).toContain("uuid=fixed-uuid");
    expect(calls[0]).toContain("verifier=fixed-verifier");
    expect(result.refresh).toBe("refresh-token");
  });

  it("redacts token-like values in debug summaries", () => {
    expect(__testInternals.redactForDebug("CURSOR_ACCESS_TOKEN=secret-token-value")).toContain("[redacted");
  });
});

afterEach(() => {
  stopProxy();
  setBridgeFactoryForTests();
});
