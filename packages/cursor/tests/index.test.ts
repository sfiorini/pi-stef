import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseModelId } from "../src/index";

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
    } as unknown as Parameters<typeof import("../src/index").default>[0];

    const mod = await import("../src/index");
    await mod.default(fakePi);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const [providerId, config] = registerProvider.mock.calls[0];
    expect(providerId).toBe("cursor");
    expect(config.api).toBe("cursor-sdk");
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
