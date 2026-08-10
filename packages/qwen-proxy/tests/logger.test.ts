import { describe, it, expect, afterEach } from "vitest";
import { createLogger } from "../src/server/logger";

describe("logger", () => {
  afterEach(() => {
    // Restore stderr if we modified it
  });

  it("redacts sensitive keys (password, bearer, ssxmod_itna)", () => {
    const logger = createLogger();
    const originalWrite = process.stderr.write;
    let output = "";
    process.stderr.write = (chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    };

    logger.info("test message", {
      password: "secret123",
      bearer: "bearer-token-abc",
      ssxmod_itna: "cookie-value-xyz",
      ssxmod_itna2: "cookie2-value",
      bearerToken: "bearer-token-123",
      name: "test-name",
    });

    process.stderr.write = originalWrite;

    // Sensitive keys should be redacted
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("secret123");
    expect(output).not.toContain("bearer-token-abc");
    expect(output).not.toContain("cookie-value-xyz");
    expect(output).not.toContain("cookie2-value");
    expect(output).not.toContain("bearer-token-123");

    // Non-sensitive keys should pass through
    expect(output).toContain("test-name");
  });

  it("recursively redacts nested objects", () => {
    const logger = createLogger();
    const originalWrite = process.stderr.write;
    let output = "";
    process.stderr.write = (chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    };

    logger.info("nested test", {
      outer: {
        password: "nested-secret",
        safe: "visible",
      },
    });

    process.stderr.write = originalWrite;

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("nested-secret");
    expect(output).toContain("visible");
  });

  it("redacts 'key' and 'apiKey' fields (api_keys.key never logged)", () => {
    const logger = createLogger();
    const originalWrite = process.stderr.write;
    let output = "";
    process.stderr.write = (chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    };

    logger.info("api key test", {
      key: "sk-secret-key-12345",
      apiKey: "sk-api-key-67890",
      label: "visible-label",
    });

    process.stderr.write = originalWrite;

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("sk-secret-key-12345");
    expect(output).not.toContain("sk-api-key-67890");
    expect(output).toContain("visible-label");
  });

  it("redacts arrays element-wise", () => {
    const logger = createLogger();
    const originalWrite = process.stderr.write;
    let output = "";
    process.stderr.write = (chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    };

    logger.info("array test", {
      items: [
        { token: "array-secret", name: "item1" },
        { name: "item2" },
      ],
    });

    process.stderr.write = originalWrite;

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("array-secret");
    expect(output).toContain("item1");
    expect(output).toContain("item2");
  });
});
