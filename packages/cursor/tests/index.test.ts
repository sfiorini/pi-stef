process.env.PI_CURSOR_AUTH_JSON_PATH ??= "/tmp/pi-stef-cursor-test-noauth.json";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseModelId, mapModelListItems } from "../src/index";
import type { ModelListItem } from "../src/model-cache";

const packageRoot = new URL("..", import.meta.url).pathname;

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(packageRoot, relativePath), "utf8")) as T;
}

describe("cursor-provider package metadata", () => {
  it("has @cursor/sdk as a dependency and no @bufbuild/protobuf", () => {
    const pkg = readJson<{
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      pi?: { extensions?: string[] };
    }>("package.json");

    expect(pkg.dependencies).toHaveProperty("@cursor/sdk");
    expect(pkg.peerDependencies).toMatchObject({
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-coding-agent": "*",
    });
    expect(pkg.pi?.extensions).toEqual(["./extensions"]);
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
});

describe("mapModelListItems", () => {
  it("maps ModelListItem[] to CursorModel[] with correct defaults and heuristics", () => {
    const items: ModelListItem[] = [
      { id: "claude-4.6-sonnet", displayName: "Sonnet 4.6" },
      { id: "gpt-5.4", displayName: "GPT-5.4" },
      { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
      { id: "text-embedding-3", displayName: "Embedding" },
    ];
    const result = mapModelListItems(items);
    expect(result).toHaveLength(4);

    const sonnet = result[0]!;
    expect(sonnet.id).toBe("claude-4.6-sonnet");
    expect(sonnet.name).toBe("Sonnet 4.6");
    expect(sonnet.reasoning).toBe(true);
    expect(sonnet.contextWindow).toBe(200_000);
    expect(sonnet.maxTokens).toBe(16_384);
    expect(sonnet.supportsImages).toBe(true);

    const embed = result[3]!;
    expect(embed.reasoning).toBe(false);
    expect(embed.supportsImages).toBe(false);
  });

  it("returns empty array for empty input", () => {
    expect(mapModelListItems([])).toEqual([]);
  });
});

describe("cursor provider registration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("registers a cursor provider with sentinel apiKey, cursor-sdk api, and non-empty models", async () => {
    // Mock the peer dep so the default export can import AuthStorage
    vi.doMock("@earendil-works/pi-coding-agent", () => ({
      AuthStorage: {
        create: () => ({
          get: () => undefined,
          set: () => {},
        }),
      },
    }));

    const registerProvider = vi.fn();
    const registerCommand = vi.fn();
    const fakePi = {
      registerProvider,
      registerCommand,
      on: vi.fn(),
    } as unknown as Parameters<typeof import("../src/index").default>[0];

    const mod = await import("../src/index");
    await mod.default(fakePi);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const [providerId, config] = registerProvider.mock.calls[0];
    expect(providerId).toBe("cursor");
    expect(config.api).toBe("cursor-sdk");
    expect(config.baseUrl).toBe("https://api.cursor.com");
    expect(config.apiKey).toBe("pi-stef-cursor-api-key-placeholder");
    expect(typeof config.streamSimple).toBe("function");
    expect(Array.isArray(config.models)).toBe(true);
    expect(config.models.length).toBeGreaterThan(0);
  });

  it("registers cursor-login and cursor-refresh-models commands", async () => {
    vi.doMock("@earendil-works/pi-coding-agent", () => ({
      AuthStorage: {
        create: () => ({
          get: () => undefined,
          set: () => {},
        }),
      },
    }));

    const registerProvider = vi.fn();
    const registerCommand = vi.fn();
    const fakePi = {
      registerProvider,
      registerCommand,
      on: vi.fn(),
    } as unknown as Parameters<typeof import("../src/index").default>[0];

    const mod = await import("../src/index");
    await mod.default(fakePi);

    const cmdNames = registerCommand.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(cmdNames).toContain("cursor-login");
    expect(cmdNames).toContain("cursor-refresh-models");
  });
});
