import { describe, it, expect } from "vitest";
import { loadQwenProxyConfig } from "../src/config/load";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("config", () => {
  describe("defaults", () => {
    it("returns correct defaults with empty env", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(7790);
      expect(config.dbPath).toBe("./data/qwen-proxy.db");
      expect(config.authUrl).toBe("https://chat.qwen.ai");
      expect(config.apiUrl).toBe("https://qwen.aikit.club");
      expect(config.jwtRefreshMs).toBe(21600000);
      expect(config.refreshThresholdMs).toBe(21600000);
      expect(config.loginTimeoutMs).toBe(10000);
      expect(config.staggerMs).toBe(5000);
      expect(config.logLevel).toBe("info");
      expect(config.accounts).toEqual([]);
      expect(config.rateLimitCooldownMs).toBe(86_400_000);
      expect(config.reenableIntervalMs).toBe(60_000);
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
        SF_QWEN_JWT_REFRESH_MS: "3600000",
        SF_QWEN_REFRESH_THRESHOLD_MS: "1800000",
        SF_QWEN_LOGIN_TIMEOUT_MS: "5000",
        SF_QWEN_STAGGER_MS: "2000",
        SF_QWEN_LOG_LEVEL: "debug",
      });
      expect(config.jwtRefreshMs).toBe(3600000);
      expect(config.refreshThresholdMs).toBe(1800000);
      expect(config.loginTimeoutMs).toBe(5000);
      expect(config.staggerMs).toBe(2000);
      expect(config.logLevel).toBe("debug");
    });

    it("returns default rateLimitCooldownMs when unset", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.rateLimitCooldownMs).toBe(86_400_000);
    });

    it("returns default reenableIntervalMs when unset", async () => {
      const config = await loadQwenProxyConfig({});
      expect(config.reenableIntervalMs).toBe(60_000);
    });

    it("parses rateLimitCooldownMs from env", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_RATE_LIMIT_COOLDOWN_MS: "3600000",
      });
      expect(config.rateLimitCooldownMs).toBe(3_600_000);
    });

    it("parses reenableIntervalMs from env", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_REENABLE_INTERVAL_MS: "120000",
      });
      expect(config.reenableIntervalMs).toBe(120_000);
    });

    it("falls back to default on invalid rateLimitCooldownMs", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_RATE_LIMIT_COOLDOWN_MS: "abc",
      });
      expect(config.rateLimitCooldownMs).toBe(86_400_000);
    });

    it("falls back to default on invalid reenableIntervalMs", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_REENABLE_INTERVAL_MS: "0",
      });
      expect(config.reenableIntervalMs).toBe(60_000);
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
        useChromeBaxia: true,
        chromePath: undefined,
        cacheTtlMs: 1_500_000,
        baxiaVersion: "2.5.37",
        preWarm: true,
        fallback: false,
      });
    });

    it("overrides baxia via env", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_USE_CHROME_BAXIA: "false",
        SF_QWEN_BAXIA_VERSION: "9.9.9",
      });
      expect(config.baxia.useChromeBaxia).toBe(false);
      expect(config.baxia.baxiaVersion).toBe("9.9.9");
    });
  });

  describe("account supply", () => {
    it("parses accounts from SF_QWEN_ACCOUNTS JSON", async () => {
      const accounts = [
        { id: 1, email: "a@test.com", password: "p1", ord: 1 },
        { id: 2, email: "b@test.com", password: "p2", ord: 2 },
      ];
      const config = await loadQwenProxyConfig({
        SF_QWEN_ACCOUNTS: JSON.stringify(accounts),
      });
      expect(config.accounts).toEqual(accounts);
    });

    it("parses accounts from SF_QWEN_ACCOUNTS_FILE", async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "qwen-cfg-"));
      const filePath = path.join(tmpDir, "accounts.json");
      const accounts = [{ id: 10, email: "file@test.com", password: "fp", ord: 10 }];
      writeFileSync(filePath, JSON.stringify(accounts), "utf8");
      try {
        const config = await loadQwenProxyConfig({
          SF_QWEN_ACCOUNTS_FILE: filePath,
        });
        expect(config.accounts).toEqual(accounts);
      } finally {
        unlinkSync(filePath);
        rmdirSync(tmpDir);
      }
    });

    it("parses accounts from numbered SF_QWEN_ACCOUNT_N env vars", async () => {
      const config = await loadQwenProxyConfig({
        SF_QWEN_ACCOUNT_1_EMAIL: "num@test.com",
        SF_QWEN_ACCOUNT_1_PASSWORD: "np",
        SF_QWEN_ACCOUNT_1_ID: "42",
        SF_QWEN_ACCOUNT_1_ORD: "7",
      });
      expect(config.accounts).toEqual([
        { id: 42, email: "num@test.com", password: "np", ord: 7 },
      ]);
    });

    it("resolution: ACCOUNTS beats ACCOUNTS_FILE beats numbered", async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "qwen-cfg-"));
      const filePath = path.join(tmpDir, "accounts.json");
      writeFileSync(
        filePath,
        JSON.stringify([{ id: 99, email: "file@test.com", password: "fp", ord: 99 }]),
        "utf8",
      );
      try {
        const accounts = [
          { id: 1, email: "json@test.com", password: "jp", ord: 1 },
        ];
        const config = await loadQwenProxyConfig({
          SF_QWEN_ACCOUNTS: JSON.stringify(accounts),
          SF_QWEN_ACCOUNTS_FILE: filePath,
          SF_QWEN_ACCOUNT_1_EMAIL: "num@test.com",
          SF_QWEN_ACCOUNT_1_PASSWORD: "np",
        });
        expect(config.accounts).toEqual(accounts);
      } finally {
        unlinkSync(filePath);
        rmdirSync(tmpDir);
      }
    });

    it("zod rejects bad email", async () => {
      const accounts = [{ id: 1, email: "not-an-email", password: "p", ord: 1 }];
      await expect(
        loadQwenProxyConfig({ SF_QWEN_ACCOUNTS: JSON.stringify(accounts) }),
      ).rejects.toThrow(/email/i);
    });

    it("zod rejects missing password", async () => {
      const accounts = [{ id: 1, email: "a@test.com", ord: 1 }];
      await expect(
        loadQwenProxyConfig({ SF_QWEN_ACCOUNTS: JSON.stringify(accounts) }),
      ).rejects.toThrow();
    });

    it("throws on invalid SF_QWEN_ACCOUNTS JSON", async () => {
      await expect(
        loadQwenProxyConfig({ SF_QWEN_ACCOUNTS: "{bad json" }),
      ).rejects.toThrow(/SF_QWEN_ACCOUNTS is not valid JSON/);
    });

    it("throws on missing SF_QWEN_ACCOUNTS_FILE", async () => {
      await expect(
        loadQwenProxyConfig({
          SF_QWEN_ACCOUNTS_FILE: "/nonexistent/path/accounts.json",
        }),
      ).rejects.toThrow();
    });

    it("(A2) numbered-env rejects non-numeric ID (SF_QWEN_ACCOUNT_1_ID=abc)", async () => {
      await expect(
        loadQwenProxyConfig({
          SF_QWEN_ACCOUNT_1_EMAIL: "a@test.com",
          SF_QWEN_ACCOUNT_1_PASSWORD: "p",
          SF_QWEN_ACCOUNT_1_ID: "abc",
        }),
      ).rejects.toThrow(/invalid|id/i);
    });

    it("(A2) numbered-env rejects invalid email", async () => {
      await expect(
        loadQwenProxyConfig({
          SF_QWEN_ACCOUNT_1_EMAIL: "not-an-email",
          SF_QWEN_ACCOUNT_1_PASSWORD: "p",
        }),
      ).rejects.toThrow(/email/i);
    });
  });
});
