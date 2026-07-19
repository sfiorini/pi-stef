import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFinanceConfig, saveProviderConfig } from "../src/config";

function withConfigHome(config: unknown): string {
  const home = mkdtempSync(path.join(tmpdir(), "fin-cfg-"));
  const dir = path.join(home, ".pi", "sf", "finance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  return home;
}

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

  it("loads providers.snaptrade from config file", async () => {
    const home = withConfigHome({
      apiUrl: "http://127.0.0.1:7780",
      token: "tok",
      providers: { snaptrade: { clientId: "PERS-123", consumerKey: "secret-key" } },
    });
    const cfg = await loadFinanceConfig({}, home);
    expect(cfg.providers?.snaptrade).toMatchObject({ clientId: "PERS-123", consumerKey: "secret-key" });
  });

  it("providers is undefined when not in config file", async () => {
    const home = withConfigHome({ apiUrl: "http://127.0.0.1:7780", token: "tok" });
    const cfg = await loadFinanceConfig({}, home);
    expect(cfg.providers).toBeUndefined();
  });

  it("loads providers.simplefin from config file", async () => {
    const home = withConfigHome({
      apiUrl: "http://127.0.0.1:7780",
      token: "tok",
      providers: { simplefin: { accessUrl: "https://demo:secret@bridge.simplefin.org/simplefin" } },
    });
    const cfg = await loadFinanceConfig({}, home);
    expect(cfg.providers?.simplefin?.accessUrl).toBe("https://demo:secret@bridge.simplefin.org/simplefin");
  });
});

describe("saveProviderConfig", () => {
  it("writes a new provider to an existing config", async () => {
    const home = withConfigHome({ apiUrl: "http://127.0.0.1:7780", token: "tok" });
    await saveProviderConfig("simplefin", { accessUrl: "https://new" }, home);
    const raw = JSON.parse(readFileSync(path.join(home, ".pi", "sf", "finance", "config.json"), "utf8"));
    expect(raw.providers.simplefin).toEqual({ accessUrl: "https://new" });
  });

  it("overwrites an existing provider's creds", async () => {
    const home = withConfigHome({
      apiUrl: "http://127.0.0.1:7780",
      token: "tok",
      providers: { simplefin: { setupToken: "old" } },
    });
    await saveProviderConfig("simplefin", { accessUrl: "https://new" }, home);
    const raw = JSON.parse(readFileSync(path.join(home, ".pi", "sf", "finance", "config.json"), "utf8"));
    expect(raw.providers.simplefin).toEqual({ accessUrl: "https://new" });
    expect(raw.providers.simplefin.setupToken).toBeUndefined();
  });

  it("preserves other providers when writing one", async () => {
    const home = withConfigHome({
      apiUrl: "http://127.0.0.1:7780",
      token: "tok",
      providers: { snaptrade: { clientId: "PERS-1", consumerKey: "key" } },
    });
    await saveProviderConfig("simplefin", { accessUrl: "https://new" }, home);
    const raw = JSON.parse(readFileSync(path.join(home, ".pi", "sf", "finance", "config.json"), "utf8"));
    expect(raw.providers.snaptrade.clientId).toBe("PERS-1");
    expect(raw.providers.simplefin.accessUrl).toBe("https://new");
  });
});
