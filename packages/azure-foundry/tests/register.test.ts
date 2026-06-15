import { describe, expect, it } from "vitest";

import { toProviderConfig } from "../src/register";
import type { DeploymentConfig } from "../src/types";

const deployment: DeploymentConfig = {
  id: "azure-foundry",
  name: "Azure Foundry East US",
  baseUrl: "https://resource.services.ai.azure.com/openai/v1/",
  apiKeyEnv: "AZURE_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: "Kimi-K2.6",
      name: "Kimi K2.6",
      reasoning: false,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
};

describe("toProviderConfig", () => {
  it("maps an openai-completions deployment", () => {
    const config = toProviderConfig(deployment);

    expect(config.baseUrl).toBe(deployment.baseUrl);
    expect(config.apiKey).toBe("AZURE_API_KEY");
    expect(config.api).toBe("openai-completions");
    expect(config.authHeader).toBe(true);
    expect(config.name).toBe(deployment.name);
    expect(config.models).toHaveLength(1);
  });

  it("preserves azure-openai-responses, authHeader false, and headers", () => {
    const config = toProviderConfig({
      ...deployment,
      api: "azure-openai-responses",
      baseUrl: "https://my-aoai.openai.azure.com",
      authHeader: false,
      headers: { "api-key": "AZURE_HEADER_KEY" },
    });

    expect(config.api).toBe("azure-openai-responses");
    expect(config.baseUrl).toBe("https://my-aoai.openai.azure.com");
    expect(config.authHeader).toBe(false);
    expect(config.headers).toEqual({ "api-key": "AZURE_HEADER_KEY" });
  });
});
