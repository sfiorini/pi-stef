import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { CONFIG_SCHEMA } from "../src/schema.mjs";
import type { Api, DeploymentConfig, ModelConfig } from "../src/types";

describe("config schema drift checks", () => {
  it("keeps config.schema.json in sync with CONFIG_SCHEMA", () => {
    const onDisk = JSON.parse(readFileSync(new URL("../config.schema.json", import.meta.url), "utf8"));

    expect(onDisk).toEqual(CONFIG_SCHEMA);
  });

  it("schema declares every key used by DeploymentConfig", () => {
    const declared = Object.keys(CONFIG_SCHEMA.properties.deployments.items.properties);
    const expected: (keyof DeploymentConfig)[] = ["id", "name", "baseUrl", "apiKeyEnv", "api", "authHeader", "headers", "models"];

    for (const key of expected) expect(declared).toContain(key);
  });

  it("schema declares every key used by ModelConfig", () => {
    const declared = Object.keys(CONFIG_SCHEMA.properties.deployments.items.properties.models.items.properties);
    const expected: (keyof ModelConfig)[] = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost"];

    for (const key of expected) expect(declared).toContain(key);
  });

  it("schema required arrays match TS-required fields", () => {
    expect(CONFIG_SCHEMA.required).toEqual(["deployments"]);
    expect(CONFIG_SCHEMA.properties.deployments.items.required).toEqual(["id", "name", "baseUrl", "apiKeyEnv", "api", "models"]);
    expect(CONFIG_SCHEMA.properties.deployments.items.properties.models.items.required).toEqual([
      "id",
      "name",
      "reasoning",
      "input",
      "contextWindow",
      "maxTokens",
      "cost",
    ]);
    expect(CONFIG_SCHEMA.properties.deployments.items.properties.models.items.properties.cost.required).toEqual([
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
    ]);
  });

  it("schema disables additionalProperties at every object level", () => {
    expect(CONFIG_SCHEMA.additionalProperties).toBe(false);
    expect(CONFIG_SCHEMA.properties.deployments.items.additionalProperties).toBe(false);
    expect(CONFIG_SCHEMA.properties.deployments.items.properties.models.items.additionalProperties).toBe(false);
    expect(CONFIG_SCHEMA.properties.deployments.items.properties.models.items.properties.cost.additionalProperties).toBe(false);
  });

  it("api enum is exhaustive against the Api union", () => {
    const apiCases = {
      "openai-completions": 0,
      "azure-openai-responses": 0,
    } satisfies Record<Api, number>;

    expect(CONFIG_SCHEMA.properties.deployments.items.properties.api.enum).toEqual(Object.keys(apiCases));
  });
});
