import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import azureFoundryProvider from "../src/index";

const baseModel = {
  id: "Kimi-K2.6",
  name: "Kimi K2.6",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function deployment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "azure-foundry",
    name: "Azure Foundry East US",
    baseUrl: "https://resource.services.ai.azure.com/openai/v1/",
    apiKeyEnv: "AZURE_API_KEY",
    api: "openai-completions",
    models: [baseModel],
    ...overrides,
  };
}

async function runWithConfig(config: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "azure-foundry-index-"));
  const configPath = join(dir, "config.json");
  process.env.PI_AZURE_FOUNDRY_CONFIG = configPath;
  writeFileSync(configPath, JSON.stringify(config), "utf8");
  const registerProvider = vi.fn();
  await azureFoundryProvider({ registerProvider } as unknown as ExtensionAPI);
  return registerProvider;
}

describe("azureFoundryProvider", () => {
  afterEach(() => {
    delete process.env.PI_AZURE_FOUNDRY_CONFIG;
    delete process.env.AZURE_API_KEY;
    vi.restoreAllMocks();
  });

  it("registers two valid deployments", async () => {
    process.env.AZURE_API_KEY = "secret";
    const registerProvider = await runWithConfig({
      deployments: [deployment(), deployment({ id: "azure-foundry-west", name: "Azure Foundry West" })],
    });

    expect(registerProvider).toHaveBeenCalledTimes(2);
    expect(registerProvider).toHaveBeenNthCalledWith(1, "azure-foundry", expect.objectContaining({ apiKey: "AZURE_API_KEY" }));
    expect(registerProvider).toHaveBeenNthCalledWith(2, "azure-foundry-west", expect.any(Object));
  });

  it("skips invalid deployments and registers valid ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerProvider = await runWithConfig({
      deployments: [deployment({ baseUrl: "http://invalid.example.com" }), deployment({ id: "valid" })],
    });

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith("valid", expect.any(Object));
    expect(warn).toHaveBeenCalledWith("[azure-foundry]", expect.stringContaining("Skipped deployments[0]"));
  });

  it("skips duplicate ids after registering the first deployment", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerProvider = await runWithConfig({
      deployments: [deployment(), deployment({ name: "Duplicate" })],
    });

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[azure-foundry]", 'Skipped deployments[1]: duplicate id "azure-foundry"');
  });

  it("registers deployments even when the api key env var is missing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const registerProvider = await runWithConfig({ deployments: [deployment()] });

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("[azure-foundry]", expect.stringContaining("AZURE_API_KEY is not set"));
  });

  it("does not throw or register providers for malformed root configs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runWithConfig({})).resolves.toHaveBeenCalledTimes(0);
    await expect(runWithConfig({ deployments: "bad" })).resolves.toHaveBeenCalledTimes(0);
    expect(error).toHaveBeenCalledWith("[azure-foundry]", expect.stringContaining("must be an object with a 'deployments' array"));
  });
});
