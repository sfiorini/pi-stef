import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebAccessConfig } from "../src/types";

const launchPersistentContext = vi.fn(async () => fakeContext);
const ensureBinary = vi.fn(async () => "/tmp/cloak");

vi.mock("cloakbrowser", () => ({
  ensureBinary,
  launchPersistentContext,
}));

let root = "";
let config: WebAccessConfig;
let fakeContext: any;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "fh-web-cloak-test-"));
  config = {
    allowPrivateNetworks: false,
    browserFingerprintSeed: undefined,
    browserGeoip: undefined,
    browserHumanPreset: undefined,
    browserLocale: undefined,
    browserProxy: undefined,
    browserTimezone: undefined,
    fetchMaxBytes: 2 * 1024 * 1024,
    fetchTimeoutMs: 1000,
    maxBytes: 1000,
    maxLines: 100,
    maxResults: 5,
    outputDir: path.join(root, "output"),
    profilesDir: path.join(root, "profiles"),
    searchProviders: ["duckduckgo"],
    sensitiveQueryKeys: [],
    userAgent: "sf-fast-fetch-test",
  };
  fakeContext = {
    close: vi.fn(async () => undefined),
    newPage: vi.fn(async () => fakePage()),
    pages: vi.fn(() => [fakePage()]),
  };
  launchPersistentContext.mockClear();
  ensureBinary.mockClear();
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("CloakBrowser runtime configuration", () => {
  it("does not override CloakBrowser's coherent user agent by default", async () => {
    const { createCloakBrowserRuntime } = await import("../src/browser/cloak");

    const runtime = await createCloakBrowserRuntime(config, { profile: "default" });
    await runtime.close();

    expect(launchPersistentContext).toHaveBeenCalledWith(expect.not.objectContaining({ userAgent: expect.any(String) }));
  });

  it("derives a stable fingerprint seed from the profile and lets explicit config win", async () => {
    const { createCloakBrowserRuntime } = await import("../src/browser/cloak");

    await (await createCloakBrowserRuntime(config, { profile: "walmart" })).close();
    await (await createCloakBrowserRuntime(config, { profile: "walmart" })).close();
    await (await createCloakBrowserRuntime({ ...config, browserFingerprintSeed: "77777" }, { profile: "walmart" })).close();

    const calls = launchPersistentContext.mock.calls as unknown as Array<[any]>;
    const firstArgs = calls[0]![0].args;
    const secondArgs = calls[1]![0].args;
    const explicitArgs = calls[2]![0].args;
    expect(firstArgs.find((arg: string) => arg.startsWith("--fingerprint="))).toBe(
      secondArgs.find((arg: string) => arg.startsWith("--fingerprint=")),
    );
    expect(explicitArgs).toContain("--fingerprint=77777");
  });

  it("passes config-only browser proxy, locale, timezone, geoip, and human preset to CloakBrowser", async () => {
    const { createCloakBrowserRuntime } = await import("../src/browser/cloak");

    await (
      await createCloakBrowserRuntime(
        {
          ...config,
          browserGeoip: true,
          browserHumanPreset: "careful",
          browserLocale: "en-US",
          browserProxy: "socks5://proxy.example.com:1080",
          browserTimezone: "America/New_York",
        },
        { profile: "proxy-profile" },
      )
    ).close();

    expect(launchPersistentContext).toHaveBeenCalledWith(
      expect.objectContaining({
        geoip: true,
        humanPreset: "careful",
        locale: "en-US",
        proxy: "socks5://proxy.example.com:1080",
        timezone: "America/New_York",
      }),
    );
  });

  it("uses native sleep instead of page.waitForTimeout in browser search", async () => {
    const page = fakePage();
    page.waitForTimeout = vi.fn(async () => {
      throw new Error("CDP wait should not be used");
    });
    fakeContext.pages = vi.fn(() => [page]);
    const { createCloakBrowserSearchAdapter } = await import("../src/browser/cloak");

    const results = await createCloakBrowserSearchAdapter(config, { profile: "search" }).search("bing", "espresso", {
      maxResults: 1,
    });

    expect(results).toEqual([{ source: "bing", title: "Result", url: "https://example.com/result" }]);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });
});

function fakePage(): any {
  return {
    content: vi.fn(async () => '<html><body><li class="b_algo"><h2><a href="https://example.com/result">Result</a></h2></li></body></html>'),
    goto: vi.fn(async () => undefined),
    locator: vi.fn(),
    title: vi.fn(async () => "Title"),
    url: vi.fn(() => "https://example.com"),
    waitForTimeout: vi.fn(async () => undefined),
  };
}
