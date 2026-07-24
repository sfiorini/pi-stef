import { describe, expect, it } from "vitest";
import {
  CURSOR_API_KEY_ENV_VAR,
  CURSOR_API_KEY_CONFIG_VALUE,
  resolveCursorApiKey,
  resolveCursorRuntimeApiKey,
  detectLegacyOAuthCredential,
} from "../src/api-key";

describe("CURSOR_API_KEY_ENV_VAR", () => {
  it("is 'CURSOR_API_KEY'", () => {
    expect(CURSOR_API_KEY_ENV_VAR).toBe("CURSOR_API_KEY");
  });
});

describe("CURSOR_API_KEY_CONFIG_VALUE", () => {
  it("is a sentinel string", () => {
    expect(CURSOR_API_KEY_CONFIG_VALUE).toBe("pi-stef-cursor-api-key-placeholder");
  });
});

describe("resolveCursorApiKey", () => {
  it("returns the trimmed key for a normal value", () => {
    expect(resolveCursorApiKey("crsr_abc123")).toBe("crsr_abc123");
  });

  it("returns undefined for the sentinel placeholder", () => {
    expect(resolveCursorApiKey("pi-stef-cursor-api-key-placeholder")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveCursorApiKey("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(resolveCursorApiKey("   ")).toBeUndefined();
  });

  it("trims surrounding whitespace", () => {
    expect(resolveCursorApiKey("  crsr_key123  ")).toBe("crsr_key123");
  });

  it("returns undefined for undefined input", () => {
    expect(resolveCursorApiKey(undefined)).toBeUndefined();
  });
});

describe("resolveCursorRuntimeApiKey", () => {
  it("prefers stored api_key credential", async () => {
    const result = await resolveCursorRuntimeApiKey({
      readStoredCredential: async () => ({ type: "api_key" as const, key: "stored_key" }),
      envApiKey: "env_key",
      fallbackApiKey: "fallback_key",
    });
    expect(result).toBe("stored_key");
  });

  it("falls back to env when stored credential is oauth", async () => {
    const result = await resolveCursorRuntimeApiKey({
      readStoredCredential: async () => ({ type: "oauth" as const }),
      envApiKey: "env_key",
      fallbackApiKey: "fallback_key",
    });
    expect(result).toBe("env_key");
  });

  it("falls back to env when stored credential is undefined", async () => {
    const result = await resolveCursorRuntimeApiKey({
      readStoredCredential: async () => undefined,
      envApiKey: "env_key",
      fallbackApiKey: "fallback_key",
    });
    expect(result).toBe("env_key");
  });

  it("returns undefined when stored is oauth and env is sentinel", async () => {
    const result = await resolveCursorRuntimeApiKey({
      readStoredCredential: async () => ({ type: "oauth" as const }),
      envApiKey: "pi-stef-cursor-api-key-placeholder",
      fallbackApiKey: undefined,
    });
    expect(result).toBeUndefined();
  });

  it("falls back to fallbackApiKey when stored and env are absent", async () => {
    const result = await resolveCursorRuntimeApiKey({
      readStoredCredential: async () => undefined,
      envApiKey: undefined,
      fallbackApiKey: "fallback_key",
    });
    expect(result).toBe("fallback_key");
  });

  it("returns undefined when all sources are absent", async () => {
    const result = await resolveCursorRuntimeApiKey({
      readStoredCredential: async () => undefined,
      envApiKey: undefined,
      fallbackApiKey: undefined,
    });
    expect(result).toBeUndefined();
  });

  it("propagates reader errors", async () => {
    await expect(
      resolveCursorRuntimeApiKey({
        readStoredCredential: async () => {
          throw new Error("storage error");
        },
        envApiKey: "env_key",
        fallbackApiKey: undefined,
      }),
    ).rejects.toThrow("storage error");
  });
});

describe("detectLegacyOAuthCredential", () => {
  it("returns true when stored credential is oauth type", async () => {
    const result = await detectLegacyOAuthCredential(async () => ({
      type: "oauth" as const,
    }));
    expect(result).toBe(true);
  });

  it("returns false when stored credential is api_key type", async () => {
    const result = await detectLegacyOAuthCredential(async () => ({
      type: "api_key" as const,
      key: "some_key",
    }));
    expect(result).toBe(false);
  });

  it("returns false when no stored credential", async () => {
    const result = await detectLegacyOAuthCredential(async () => undefined);
    expect(result).toBe(false);
  });
});
