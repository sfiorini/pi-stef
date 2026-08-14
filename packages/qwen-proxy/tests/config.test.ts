import { describe, it, expect } from "vitest";
import { loadQwenProxyConfig } from "../src/config/load";

describe("config", () => {
  describe("defaults", () => {
    it("returns correct defaults with empty env", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(7790);
      expect(config.dbPath).toBe("./data/qwen-proxy.db");
      expect(config.logLevel).toBe("info");
      expect(config.emptyCooldownMs).toBe(10_000);
      expect(config.emptyRetryMax).toBe(3);
      expect(config.emptyRetryGapMs).toBe(1_000);
      expect(config.apiKeyEnv).toEqual([]);
    });

    it("overrides port via SF_QWEN_PORT", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PORT: "8080" });
      expect(config.port).toBe(8080);
    });

    it("overrides host via SF_QWEN_HOST", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_HOST: "0.0.0.0" });
      expect(config.host).toBe("0.0.0.0");
    });

    it("falls back to default on invalid port", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PORT: "abc" });
      expect(config.port).toBe(7790);
    });

    it("falls back to default on zero port", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PORT: "0" });
      expect(config.port).toBe(7790);
    });

    it("falls back to default on negative port", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PORT: "-1" });
      expect(config.port).toBe(7790);
    });

    it("returns empty apiKeyEnv when SF_QWEN_API_KEY is unset", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.apiKeyEnv).toEqual([]);
    });

    it("parses comma-separated SF_QWEN_API_KEY into apiKeyEnv", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_API_KEY: "sk-a,sk-b,sk-c",
      });
      expect(config.apiKeyEnv).toEqual(["sk-a", "sk-b", "sk-c"]);
    });

    it("trims whitespace and drops empty entries from SF_QWEN_API_KEY", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_API_KEY: " sk-a , , sk-b , ",
      });
      expect(config.apiKeyEnv).toEqual(["sk-a", "sk-b"]);
    });

    it("returns empty apiKeyEnv on empty string SF_QWEN_API_KEY", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_API_KEY: "",
      });
      expect(config.apiKeyEnv).toEqual([]);
    });

    it("defaults adminKey to undefined", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.adminKey).toBeUndefined();
    });

    it("overrides adminKey via SF_QWEN_ADMIN_KEY", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_ADMIN_KEY: "my-secret-admin-key",
      });
      expect(config.adminKey).toBe("my-secret-admin-key");
    });

    it("treats empty SF_QWEN_ADMIN_KEY as unset", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_ADMIN_KEY: "",
      });
      expect(config.adminKey).toBeUndefined();
    });

    it("returns baxia defaults", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.baxia).toEqual({
        chromePath: undefined,
        cacheTtlMs: 1_500_000,
        baxiaVersion: "2.5.37",
        preWarm: true,
        fallback: false,
      });
    });

    it("overrides baxia via env", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_CHROME_PATH: "/usr/local/bin/chromium",
        SF_QWEN_BAXIA_VERSION: "9.9.9",
      });
      expect(config.baxia.chromePath).toBe("/usr/local/bin/chromium");
      expect(config.baxia.baxiaVersion).toBe("9.9.9");
    });
  });

  describe("empty-retry config", () => {
    it("returns defaults: emptyCooldownMs=10000, emptyRetryMax=3, emptyRetryGapMs=1000", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.emptyCooldownMs).toBe(10_000);
      expect(config.emptyRetryMax).toBe(3);
      expect(config.emptyRetryGapMs).toBe(1_000);
    });

    it("overrides via env", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_EMPTY_COOLDOWN_MS: "5000",
        SF_QWEN_EMPTY_RETRY_MAX: "5",
        SF_QWEN_EMPTY_RETRY_GAP_MS: "2000",
      });
      expect(config.emptyCooldownMs).toBe(5_000);
      expect(config.emptyRetryMax).toBe(5);
      expect(config.emptyRetryGapMs).toBe(2_000);
    });

    it("SF_QWEN_EMPTY_RETRY_MAX=0 is valid (disables retry)", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_EMPTY_RETRY_MAX: "0",
      });
      expect(config.emptyRetryMax).toBe(0);
    });

    it("SF_QWEN_EMPTY_RETRY_MAX negative → fallback 3", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_EMPTY_RETRY_MAX: "-1",
      });
      expect(config.emptyRetryMax).toBe(3);
    });

    it("SF_QWEN_EMPTY_RETRY_MAX non-numeric → fallback 3", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_EMPTY_RETRY_MAX: "abc",
      });
      expect(config.emptyRetryMax).toBe(3);
    });

    it("SF_QWEN_EMPTY_RETRY_MAX fractional (1.5) → fallback 3", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_EMPTY_RETRY_MAX: "1.5",
      });
      expect(config.emptyRetryMax).toBe(3);
    });

    it("SF_QWEN_EMPTY_RETRY_MAX whitespace → fallback 3", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_EMPTY_RETRY_MAX: "   ",
      });
      expect(config.emptyRetryMax).toBe(3);
    });

    it("SF_QWEN_EMPTY_RETRY_GAP_MS=0 → fallback 1000 (parseIntEnv rejects <=0)", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_EMPTY_RETRY_GAP_MS: "0",
      });
      expect(config.emptyRetryGapMs).toBe(1_000);
    });
  });

  describe("proxy rotation config", () => {
    it("returns correct defaults with empty env", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.proxyCount).toBe(0);
      expect(config.proxyUrlsRaw).toBe("");
      expect(config.proxyUser).toBeUndefined();
      expect(config.proxyPass).toBeUndefined();
      expect(config.proxyCountriesRaw).toBe("");
      expect(config.timeoutMs).toBe(60_000);
    });

    it("overrides proxyCount via SF_QWEN_PROXY_COUNT", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PROXY_COUNT: "5" });
      expect(config.proxyCount).toBe(5);
    });

    it("overrides proxyUrlsRaw via SF_QWEN_PROXY_URLS", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PROXY_URLS: "socks5://a:1080,socks5://b:1080" });
      expect(config.proxyUrlsRaw).toBe("socks5://a:1080,socks5://b:1080");
    });

    it("overrides proxyUser/proxyPass via SF_QWEN_PROXY_USER/PASS", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_PROXY_USER: "myuser",
        SF_QWEN_PROXY_PASS: "mypass",
      });
      expect(config.proxyUser).toBe("myuser");
      expect(config.proxyPass).toBe("mypass");
    });

    it("overrides proxyCountriesRaw via SF_QWEN_PROXY_COUNTRIES", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PROXY_COUNTRIES: "US,DE" });
      expect(config.proxyCountriesRaw).toBe("US,DE");
    });

    it("stall guard defaults: firstPayloadTimeoutMs/streamIdleTimeoutMs = 30000", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.firstPayloadTimeoutMs).toBe(30_000);
      expect(config.streamIdleTimeoutMs).toBe(30_000);
    });

    it("SF_QWEN_FIRST_PAYLOAD_TIMEOUT_MS=0 disables (0 kept, not defaulted)", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_FIRST_PAYLOAD_TIMEOUT_MS: "0" });
      expect(config.firstPayloadTimeoutMs).toBe(0);
    });

    it("SF_QWEN_STREAM_IDLE_TIMEOUT_MS=0 disables (0 kept, not defaulted)", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_STREAM_IDLE_TIMEOUT_MS: "0" });
      expect(config.streamIdleTimeoutMs).toBe(0);
    });

    it("SF_QWEN_FIRST_PAYLOAD_TIMEOUT_MS=5000 overrides", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_FIRST_PAYLOAD_TIMEOUT_MS: "5000" });
      expect(config.firstPayloadTimeoutMs).toBe(5_000);
    });

    it("garbage/negative stall-guard values fall back to 30000", async () => {
      const c1 = await loadQwenProxyConfig({ SF_QWEN_FIRST_PAYLOAD_TIMEOUT_MS: "abc", SF_QWEN_STREAM_IDLE_TIMEOUT_MS: "-5" });
      expect(c1.firstPayloadTimeoutMs).toBe(30_000);
      expect(c1.streamIdleTimeoutMs).toBe(30_000);
    });

    it("overrides timeoutMs via SF_QWEN_TIMEOUT_MS", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_TIMEOUT_MS: "30000" });
      expect(config.timeoutMs).toBe(30_000);
    });

    it("SF_QWEN_PROXY_COUNT=0 is valid", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PROXY_COUNT: "0" });
      expect(config.proxyCount).toBe(0);
    });

    it("SF_QWEN_PROXY_COUNT negative → fallback 0", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PROXY_COUNT: "-1" });
      expect(config.proxyCount).toBe(0);
    });

    it("SF_QWEN_PROXY_COUNT non-numeric → fallback 0", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PROXY_COUNT: "abc" });
      expect(config.proxyCount).toBe(0);
    });

    it("SF_QWEN_TIMEOUT_MS=0 → fallback 60000", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_TIMEOUT_MS: "0" });
      expect(config.timeoutMs).toBe(60_000);
    });

    it("empty SF_QWEN_PROXY_URLS → empty string", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PROXY_URLS: "" });
      expect(config.proxyUrlsRaw).toBe("");
    });
  });
});
