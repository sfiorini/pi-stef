import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadWebAccessConfig } from "../src/config";

describe("web-access config", () => {
  it("loads defaults, config file, env, and params in precedence order", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "fh-web-config-"));
    const configDir = path.join(homeDir, ".pi", "web-access");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        allowPrivateNetworks: true,
        fetchTimeoutMs: 1000,
        fetchMaxBytes: 777,
        browserFingerprintSeed: "11111",
        browserHumanPreset: "default",
        browserLocale: "it-IT",
        browserProxy: "http://file-proxy.example.com:8080",
        browserTimezone: "Europe/Rome",
        maxResults: 4,
        searxngUrl: "https://file-search.example.com",
        sensitiveQueryKeys: ["ticket"],
      }),
    );

    const config = await loadWebAccessConfig(
      {
        maxResults: 8,
        searxngUrl: "https://param-search.example.com",
      },
      {
        FH_WEB_ALLOW_PRIVATE_NETWORKS: "0",
        FH_WEB_FETCH_TIMEOUT_MS: "2500",
        FH_WEB_FETCH_MAX_BYTES: "888",
        FH_WEB_BROWSER_FINGERPRINT_SEED: "22222",
        FH_WEB_BROWSER_GEOIP: "1",
        FH_WEB_BROWSER_HUMAN_PRESET: "careful",
        FH_WEB_BROWSER_LOCALE: "en-US",
        FH_WEB_BROWSER_PROXY: "socks5://env-proxy.example.com:1080",
        FH_WEB_BROWSER_TIMEZONE: "America/New_York",
        FH_WEB_MAX_RESULTS: "6",
        FH_WEB_SEARXNG_URL: "https://env-search.example.com",
        FH_WEB_SENSITIVE_QUERY_KEYS: "session_id,private_key",
      },
      homeDir,
    );

    expect(config).toMatchObject({
      allowPrivateNetworks: false,
      browserFingerprintSeed: "22222",
      browserGeoip: true,
      browserHumanPreset: "careful",
      browserLocale: "en-US",
      browserProxy: "socks5://env-proxy.example.com:1080",
      browserTimezone: "America/New_York",
      fetchMaxBytes: 888,
      fetchTimeoutMs: 2500,
      maxResults: 8,
      searxngUrl: "https://param-search.example.com",
    });
    expect(config.profilesDir).toBe(path.join(homeDir, ".pi", "web-access", "profiles"));
    expect(config.sensitiveQueryKeys).toEqual(expect.arrayContaining(["token", "ticket", "session_id", "private_key"]));
  });

  it("ignores invalid numeric and boolean env values", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "fh-web-config-"));

    const config = await loadWebAccessConfig(
      {},
      {
        FH_WEB_ALLOW_PRIVATE_NETWORKS: "sometimes",
        FH_WEB_BROWSER_GEOIP: "sometimes",
        FH_WEB_BROWSER_HUMAN_PRESET: "reckless",
        FH_WEB_BROWSER_PROXY: "file:///tmp/proxy",
        FH_WEB_FETCH_TIMEOUT_MS: "not-a-number",
        FH_WEB_FETCH_MAX_BYTES: "0",
        FH_WEB_MAX_RESULTS: "0",
      },
      homeDir,
    );

    expect(config.allowPrivateNetworks).toBe(false);
    expect(config.browserGeoip).toBeUndefined();
    expect(config.browserHumanPreset).toBeUndefined();
    expect(config.browserProxy).toBeUndefined();
    expect(config.fetchTimeoutMs).toBe(15_000);
    expect(config.fetchMaxBytes).toBe(2 * 1024 * 1024);
    expect(config.maxResults).toBe(10);
  });

  it("does not let undefined params erase defaults", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "fh-web-config-"));

    const config = await loadWebAccessConfig(
      {
        maxResults: undefined,
        searchProviders: undefined,
        searxngUrl: undefined,
      },
      {},
      homeDir,
    );

    expect(config.maxResults).toBe(10);
    expect(config.fetchMaxBytes).toBe(2 * 1024 * 1024);
    expect(config.searchProviders).toEqual(["searxng", "duckduckgo", "google", "bing"]);
    expect(config.searxngUrl).toBeUndefined();
  });
});
