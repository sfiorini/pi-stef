import { describe, it, expect } from "vitest";
import { loadQwenProxyConfig } from "../src/config/load";

describe("config", () => {
  describe("defaults", () => {
    it("returns correct defaults with empty env", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(7790);
      expect(config.dbPath).toBe("./data/qwen-proxy.db");
      expect(config.authUrl).toBe("https://chat.qwen.ai");
      expect(config.apiUrl).toBe("https://chat.qwen.ai");
      expect(config.refreshIntervalMs).toBe(900000);
      expect(config.jwtRefreshMs).toBe(21600000);
      expect(config.refreshThresholdMs).toBe(21600000);
      expect(config.loginTimeoutMs).toBe(10000);
      expect(config.staggerMs).toBe(5000);
      expect(config.logLevel).toBe("info");
      expect(config.accounts).toEqual([]);
    });

    it("overrides port via SF_QWEN_PORT", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_PORT: "8080" });
      expect(config.port).toBe(8080);
    });

    it("overrides host via SF_QWEN_HOST", async () => {
      const config = await loadQwenProxyConfig({ SF_QWEN_HOST: "0.0.0.0" });
      expect(config.host).toBe("0.0.0.0");
    });

    it("overrides authUrl via SF_QWEN_AUTH_URL", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_AUTH_URL: "https://custom.example.com",
      });
      expect(config.authUrl).toBe("https://custom.example.com");
    });

    it("overrides apiUrl via SF_QWEN_API_URL", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_API_URL: "https://api.example.com",
      });
      expect(config.apiUrl).toBe("https://api.example.com");
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

    it("overrides numeric fields via env", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_REFRESH_INTERVAL_MS: "60000",
        SF_QWEN_JWT_REFRESH_MS: "3600000",
        SF_QWEN_REFRESH_THRESHOLD_MS: "1800000",
        SF_QWEN_LOGIN_TIMEOUT_MS: "5000",
        SF_QWEN_STAGGER_MS: "2000",
        SF_QWEN_LOG_LEVEL: "debug",
      });
      expect(config.refreshIntervalMs).toBe(60000);
      expect(config.jwtRefreshMs).toBe(3600000);
      expect(config.refreshThresholdMs).toBe(1800000);
      expect(config.loginTimeoutMs).toBe(5000);
      expect(config.staggerMs).toBe(2000);
      expect(config.logLevel).toBe("debug");
    });
  });
});
