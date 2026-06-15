import { describe, expect, it } from "vitest";

import { validate } from "../src/validate";
import type { Config, DeploymentConfig } from "../src/types";

const model = {
  id: "Kimi-K2.6",
  name: "Kimi K2.6",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  contextWindow: 128000,
  maxTokens: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function deployment(overrides: Partial<DeploymentConfig> = {}): DeploymentConfig {
  return {
    id: "azure-foundry",
    name: "Azure Foundry East US",
    baseUrl: "https://resource.services.ai.azure.com/openai/v1/",
    apiKeyEnv: "AZURE_API_KEY",
    api: "openai-completions",
    models: [model],
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return { deployments: [deployment()], ...overrides };
}

function issuePaths(raw: unknown): string[] {
  const result = validate(raw);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe("validate", () => {
  it("rejects an empty config object", () => {
    expect(validate({})).toEqual({
      ok: false,
      issues: [{ path: "deployments", message: "Must be an array." }],
    });
  });

  it("accepts an empty deployments array", () => {
    expect(validate({ deployments: [] })).toEqual({ ok: true, value: { deployments: [] } });
  });

  it("rejects a non-array deployments field", () => {
    expect(issuePaths({ deployments: "bad" })).toContain("deployments");
  });

  it("rejects invalid deployment fields and duplicate ids", () => {
    const result = validate({
      deployments: [
        {
          id: "Bad Id",
          name: "",
          baseUrl: "http://resource.services.ai.azure.com/openai/v1/",
          apiKeyEnv: "lowercase",
          api: "bad-api",
          models: [model],
          extra: true,
        },
        deployment({ id: "dupe" }),
        deployment({ id: "dupe", name: "Duplicate" }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining([
          "deployments[0].extra",
          "deployments[0].id",
          "deployments[0].name",
          "deployments[0].baseUrl",
          "deployments[0].apiKeyEnv",
          "deployments[0].api",
          "deployments[2].id",
        ]),
      );
    }
  });

  it("rejects openai-completions baseUrl values that include composed request paths or api-version queries", () => {
    const result = validate({
      deployments: [
        deployment({ baseUrl: "https://resource.services.ai.azure.com/openai/v1/chat/completions" }),
        deployment({ id: "legacy", baseUrl: "https://resource.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview" }),
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.filter((issue) => issue.path.endsWith(".baseUrl"))).toHaveLength(3);
      expect(result.issues.map((issue) => issue.message).join("\n")).toContain("must NOT end with /chat/completions");
      expect(result.issues.map((issue) => issue.message).join("\n")).toContain("api-version=");
    }
  });

  it("rejects azure-openai-responses baseUrl hosts that Pi will not normalize", () => {
    const result = validate(config({ deployments: [deployment({ api: "azure-openai-responses", baseUrl: "https://resource.services.ai.azure.com" })] }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "deployments[0].baseUrl",
          message: expect.stringContaining(".openai.azure.com"),
        }),
      );
    }
  });

  it("accepts azure-openai-responses Azure OpenAI hosts", () => {
    const result = validate(config({ deployments: [deployment({ api: "azure-openai-responses", baseUrl: "https://my-aoai.openai.azure.com" })] }));

    expect(result.ok).toBe(true);
  });

  it("rejects invalid model fields", () => {
    const badModel = {
      id: "",
      name: "",
      reasoning: "no",
      input: ["audio"],
      contextWindow: 0,
      maxTokens: 1.5,
      cost: { input: -1, output: 0, cacheRead: 0 },
      extra: true,
    };
    const paths = issuePaths(config({ deployments: [deployment({ models: [badModel as any] })] }));

    expect(paths).toEqual(
      expect.arrayContaining([
        "deployments[0].models[0].extra",
        "deployments[0].models[0].id",
        "deployments[0].models[0].name",
        "deployments[0].models[0].reasoning",
        "deployments[0].models[0].input[0]",
        "deployments[0].models[0].contextWindow",
        "deployments[0].models[0].maxTokens",
        "deployments[0].models[0].cost.cacheWrite",
        "deployments[0].models[0].cost.input",
      ]),
    );
  });

  it("rejects empty models arrays", () => {
    expect(issuePaths(config({ deployments: [deployment({ models: [] })] }))).toContain("deployments[0].models");
  });

  it("accepts env-var-backed headers and rejects literal header secrets", () => {
    expect(validate(config({ deployments: [deployment({ headers: { "api-key": "AZURE_HEADER_KEY" }, authHeader: false })] }))).toMatchObject({
      ok: true,
    });
    expect(issuePaths(config({ deployments: [deployment({ headers: { "api-key": "literal-secret" }, authHeader: "yes" as any })] }))).toEqual(
      expect.arrayContaining(["deployments[0].headers.api-key", "deployments[0].authHeader"]),
    );
  });
});
