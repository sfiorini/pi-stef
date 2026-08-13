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
      expect(config.rateLimitCooldownMs).toBe(60_000);
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

    it("returns default rateLimitCooldownMs when unset", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.rateLimitCooldownMs).toBe(60_000);
    });

    it("parses rateLimitCooldownMs from env", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_RATE_LIMIT_COOLDOWN_MS: "3600000",
      });
      expect(config.rateLimitCooldownMs).toBe(3_600_000);
    });

    it("falls back to default on invalid rateLimitCooldownMs", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_RATE_LIMIT_COOLDOWN_MS: "abc",
      });
      expect(config.rateLimitCooldownMs).toBe(60_000);
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
});
