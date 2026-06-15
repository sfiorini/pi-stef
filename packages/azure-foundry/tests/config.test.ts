import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  afterEach(() => {
    delete process.env.PI_AZURE_FOUNDRY_CONFIG;
  });

  it("loads a valid JSONC config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "azure-foundry-config-"));
    const configPath = join(dir, "config.json");
    process.env.PI_AZURE_FOUNDRY_CONFIG = configPath;
    writeFileSync(
      configPath,
      `{
        // comments are allowed
        "deployments": []
      }`,
      "utf8",
    );

    expect(loadConfig()).toEqual({ deployments: [] });
  });

  it("seeds missing config and schema files without overwriting an existing config", () => {
    const dir = mkdtempSync(join(tmpdir(), "azure-foundry-config-"));
    const configPath = join(dir, "nested", "config.json");
    process.env.PI_AZURE_FOUNDRY_CONFIG = configPath;

    expect(loadConfig()).toEqual({ $schema: "./config.schema.json", deployments: [] });
    expect(readFileSync(configPath, "utf8")).toContain("https://<resource>.services.ai.azure.com/openai/v1/");
    expect(existsSync(join(dir, "nested", "config.schema.json"))).toBe(true);

    writeFileSync(configPath, `{"deployments":[]}`, "utf8");
    expect(loadConfig()).toEqual({ deployments: [] });
    expect(readFileSync(configPath, "utf8")).toBe(`{"deployments":[]}`);
  });
});
