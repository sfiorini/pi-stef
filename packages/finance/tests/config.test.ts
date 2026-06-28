import { describe, it, expect } from "vitest";
import { loadFinanceConfig } from "../src/config";

describe("loadFinanceConfig", () => {
  it("returns defaults when no config exists", async () => {
    const cfg = await loadFinanceConfig({}, "/tmp/does-not-exist-home");
    expect(cfg.apiUrl).toBe("http://127.0.0.1:7780");
    expect(cfg.token).toBe("");
  });

  it("env overrides win (SF_FINANCE_*)", async () => {
    const cfg = await loadFinanceConfig(
      { SF_FINANCE_API_URL: "http://127.0.0.1:9999", SF_FINANCE_TOKEN: "t1" },
      "/tmp/does-not-exist-home",
    );
    expect(cfg.apiUrl).toBe("http://127.0.0.1:9999");
    expect(cfg.token).toBe("t1");
  });
});
