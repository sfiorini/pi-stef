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

describe("cursor-refresh-models command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  type Source = "live" | "cache" | "fallback";

  /** Wire up the extension with a mocked discoverModels, then invoke the
   * refresh handler once and return the captured registerProvider + notify. */
  async function runRefresh(
    source: Source,
    items: ModelListItem[],
    reason?: "no-api-key" | "live-error" | "live-empty",
  ) {
    vi.doMock("@earendil-works/pi-coding-agent", () => ({
      AuthStorage: {
        create: () => ({ get: () => undefined, set: () => {} }),
      },
    }));
    vi.doMock("../src/model-discovery", () => ({
      discoverModels: vi.fn().mockResolvedValue({ items, source, reason }),
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

    const refreshEntry = registerCommand.mock.calls.find(
      (c: unknown[]) => c[0] === "cursor-refresh-models",
    ) as unknown as [
      string,
      {
        handler: (
          args: string,
          ctx: { ui?: { notify?: (msg: string, level: string) => void } },
        ) => Promise<void>,
      },
    ];
    const notify = vi.fn();
    await refreshEntry[1].handler("", { ui: { notify } });

    return { registerProvider, notify };
  }

  it("on live source: re-registers models live and reports success without 'restart'", async () => {
    const { registerProvider, notify } = await runRefresh("live", [
      { id: "new-cursor-model", displayName: "New Cursor Model" },
    ]);

    // registerProvider called twice: startup + the live refresh (live update).
    expect(registerProvider).toHaveBeenCalledTimes(2);
    const refreshCall = registerProvider.mock.calls[1]!;
    expect(refreshCall[0]).toBe("cursor");
    const modelIds = (
      refreshCall[1] as { models: Array<{ id: string }> }
    ).models.map((m) => m.id);
    expect(modelIds).toContain("new-cursor-model");

    expect(notify).toHaveBeenCalledTimes(1);
    const [msg, level] = notify.mock.calls[0]!;
    expect(msg).toMatch(/Refreshed cursor models/i);
    expect(msg).not.toMatch(/restart/i);
    expect(level).toBe("info");
  });

  it("on fallback source: does NOT re-register (no clobber) and warns", async () => {
    const { registerProvider, notify } = await runRefresh("fallback", [
      { id: "fallback-only-model", displayName: "Fallback" },
    ]);

    // registerProvider called once (startup only) — in-memory list untouched.
    expect(registerProvider).toHaveBeenCalledTimes(1);

    expect(notify).toHaveBeenCalledTimes(1);
    const [, level] = notify.mock.calls[0]!;
    expect(level).toBe("warning");
  });

  it("on cache source: does NOT re-register (no clobber) and warns", async () => {
    const { registerProvider, notify } = await runRefresh("cache", [
      { id: "cached-model", displayName: "Cached" },
    ]);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toBe("warning");
  });

  it("tailors the warning message by reason", async () => {
    const items = [{ id: "x", displayName: "X" }];

    const noKey = await runRefresh("fallback", items, "no-api-key");
    expect(noKey.notify.mock.calls[0]![0]).toMatch(/No Cursor API key configured.*\/cursor-login/i);

    const empty = await runRefresh("fallback", items, "live-empty");
    expect(empty.notify.mock.calls[0]![0]).toMatch(/Cursor API returned no models/i);

    const liveErr = await runRefresh("fallback", items, "live-error");
    expect(liveErr.notify.mock.calls[0]![0]).toMatch(/Couldn't reach the Cursor API.*live call failed/i);

    // No reason (e.g. stale cache with no live-attempt detail) → default reachability message.
    const noReason = await runRefresh("fallback", items);
    expect(noReason.notify.mock.calls[0]![0]).toMatch(/Couldn't reach the Cursor API/i);
  });
});
